import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { parseUlid } from "../../src/core/ids"
import {
  AuthHarness,
  CLIENT_ID,
  MockIdp,
  errorCode,
  isRecord,
  requiredLocation,
  setCookie,
  type HarnessOptions,
} from "./harness"

let idp: MockIdp
const TOKEN_CHARS = 43
const harnesses: AuthHarness[] = []

beforeAll(async () => {
  idp = await MockIdp.start()
})

afterAll(async () => {
  await idp.stop()
})

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop()
})

async function harness(options: HarnessOptions = {}): Promise<AuthHarness> {
  const started = await AuthHarness.start(idp, options)
  harnesses.push(started)
  return started
}

async function me(target: AuthHarness, cookie: string): Promise<Record<string, unknown>> {
  const response = await target.fetch("/api/v1/me", { headers: { cookie } })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("me body is not an object")
  return body
}

async function roleAfterLogin(target: AuthHarness, sub: string, groups: readonly string[]): Promise<unknown> {
  target.provision(idp.issuer, sub)
  const { cookie } = await target.login(idp, { sub, groups })
  if (cookie === null) throw new Error(`no session for ${sub}`)
  return (await me(target, cookie)).role
}

describe("oidc login", () => {
  test("a provisioned user is redirected through the provider and gets a session plus csrf from /me", async () => {
    const target = await harness()
    const alice = target.provision(idp.issuer, "alice")

    const start = await target.fetch("/auth/login")
    expect(start.status).toBe(302)
    const authorize = new URL(requiredLocation(start))
    expect(authorize.origin).toBe(new URL(idp.issuer).origin)
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(authorize.searchParams.get("redirect_uri")).toBe(target.url("/auth/callback"))
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("state")).toHaveLength(TOKEN_CHARS)
    expect(authorize.searchParams.get("nonce")).toHaveLength(TOKEN_CHARS)

    const { callback, cookie } = await target.login(idp, { sub: "alice", email: "alice@corp.test", name: "Alice" })
    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("/")
    const sessionCookie = setCookie(callback, "omod_session") ?? ""
    expect(sessionCookie).toContain("HttpOnly")
    expect(sessionCookie).toContain("SameSite=Lax")
    expect(sessionCookie).toContain("Path=/")
    expect(sessionCookie).not.toContain("Secure")
    expect(setCookie(callback, "omod_login")).toContain("Max-Age=0")
    if (cookie === null) throw new Error("no session cookie")

    const body = await me(target, cookie)
    expect(body.role).toBe("member")
    expect(isRecord(body.user) ? body.user.id : null).toBe(alice.id)
    expect(body.csrfToken).toHaveLength(TOKEN_CHARS)
    const stored = target.repos.users.get(alice.id)
    expect(stored?.lastLoginAt).toBe(new Date(target.clock.now()).toISOString())
    expect(stored?.email).toBe("alice@corp.test")
    console.log(`QA happy: /auth/login 302 -> ${authorize.origin}/authorize; callback ${callback.status} -> /; /api/v1/me user=${alice.id} role=${String(body.role)} csrf=${String(body.csrfToken).length} chars`)
  })

  test("behind an https publicUrl the login and session cookies are Secure", async () => {
    const target = await harness({ publicUrl: "https://omo.example.test" })
    target.provision(idp.issuer, "alice")

    const start = await target.fetch("/auth/login")
    const { callback } = await target.login(idp, { sub: "alice" }, (url) => {
      url.href = target.url(`${url.pathname}${url.search}`)
    })

    expect(new URL(requiredLocation(start)).searchParams.get("redirect_uri")).toBe("https://omo.example.test/auth/callback")
    expect(setCookie(start, "omod_login")).toContain("; Secure")
    expect(callback.status).toBe(303)
    expect(setCookie(callback, "omod_session")).toContain("; Secure")
  })

  test("an unknown user gets 403, no session, and an audit row for the admins", async () => {
    const target = await harness()

    const { callback, cookie } = await target.login(idp, { sub: "mallory" })

    expect(callback.status).toBe(403)
    expect(await errorCode(callback)).toBe("forbidden")
    expect(cookie).toBeNull()
    expect(target.repos.users.findByOidc(idp.issuer, "mallory")).toBeNull()
    const admin = await target.breakglassMe()
    const adminId = parseUlid(isRecord(admin.user) && typeof admin.user.id === "string" ? admin.user.id : "")
    if (adminId === null) throw new Error("break-glass /me returned no admin id")
    const audit = target.repos.audit.listByUser(adminId, 10)
    expect(audit.map(({ action, entityKind, detail }) => ({ action, entityKind, detail }))).toEqual([
      {
        action: "auth.login_denied",
        entityKind: "user",
        detail: { issuer: idp.issuer, sub: "mallory", reason: "not_provisioned" },
      },
    ])
  })

  test("self-signup creates a member with a contained, collision-free agent dir and no project roots", async () => {
    const target = await harness({ users: { allowSelfSignup: true } })
    const root = target.config.users.defaultAgentDirRoot

    const first = await target.login(idp, { sub: "tenant|../../etc" })
    const second = await target.login(idp, { sub: "tenant_.._.._etc" })

    expect(first.callback.status).toBe(303)
    expect(second.callback.status).toBe(303)
    const traversal = target.repos.users.findByOidc(idp.issuer, "tenant|../../etc")
    const lookalike = target.repos.users.findByOidc(idp.issuer, "tenant_.._.._etc")
    expect(traversal?.role).toBe("member")
    expect(traversal?.allowedRoots).toEqual([])
    expect(lookalike?.agentDir).toBe(join(root, "tenant_.._.._etc"))
    expect(dirname(traversal?.agentDir ?? "")).toBe(root)
    expect(traversal?.agentDir).not.toBe(lookalike?.agentDir)
  })

  test("a subject listed in adminSubjects logs in as admin", async () => {
    const target = await harness({ oidc: { adminSubjects: [{ issuer: idp.issuer, sub: "root" }] } })

    expect(await roleAfterLogin(target, "root", [])).toBe("admin")
    expect(await roleAfterLogin(target, "plain", [])).toBe("member")
  })

  test("a groups claim grants admin only when groupsClaim is configured", async () => {
    const withoutClaim = await harness()
    const withClaim = await harness({ oidc: { groupsClaim: "groups", adminGroup: "omo-admins" } })

    expect(await roleAfterLogin(withoutClaim, "grouped", ["omo-admins"])).toBe("member")
    expect(await roleAfterLogin(withClaim, "grouped", ["omo-admins"])).toBe("admin")
    expect(await roleAfterLogin(withClaim, "other", ["staff"])).toBe("member")
  })

  test("the bootstrap admin's first login maps to bootstrapAdmin.agentDir as admin", async () => {
    const target = await harness({ users: { bootstrapAdmin: { oidcSub: "owner", agentDir: "/owner/agent" } } })

    const { cookie } = await target.login(idp, { sub: "owner", email: "owner@corp.test" })
    if (cookie === null) throw new Error("bootstrap admin got no session")

    const body = await me(target, cookie)
    expect(body.role).toBe("admin")
    expect(isRecord(body.user) ? body.user.agentDir : null).toBe("/owner/agent")
    const breakglass = await target.breakglassMe()
    expect(isRecord(breakglass.user) ? breakglass.user.id : null).toBe(isRecord(body.user) ? body.user.id : "")
  })

  test("a bootstrap admin known only by email is matched on a verified email, never an unverified one", async () => {
    const target = await harness({ users: { bootstrapAdmin: { email: "Owner@Corp.test", agentDir: "/owner/agent" } } })

    const unverified = await target.login(idp, { sub: "imposter", email: "owner@corp.test", email_verified: false })
    const verified = await target.login(idp, { sub: "owner-sub", email: "owner@corp.test", email_verified: true })

    expect(unverified.callback.status).toBe(403)
    expect(verified.callback.status).toBe(303)
    const owner = target.repos.users.findByOidc(idp.issuer, "owner-sub")
    expect(owner?.role).toBe("admin")
    expect(owner?.agentDir).toBe("/owner/agent")
  })

  test("a callback whose state does not match the login cookie is rejected", async () => {
    const target = await harness()
    target.provision(idp.issuer, "alice")

    const { callback, cookie } = await target.login(idp, { sub: "alice" }, (url) => {
      url.searchParams.set("state", "forged-state")
    })

    expect(callback.status).toBe(401)
    expect(await errorCode(callback)).toBe("unauthenticated")
    expect(cookie).toBeNull()
  })

  test("an ID token carrying a different nonce is rejected", async () => {
    const target = await harness()
    target.provision(idp.issuer, "alice")

    const { callback, cookie } = await target.login(idp, { sub: "alice", nonce: "replayed-nonce" })

    expect(callback.status).toBe(401)
    expect(await errorCode(callback)).toBe("unauthenticated")
    expect(cookie).toBeNull()
  })

  test("logout deletes the session and clears the cookie", async () => {
    const target = await harness()
    target.provision(idp.issuer, "alice")
    const { cookie, csrf } = await target.session(idp, { sub: "alice" })

    const logout = await target.fetch("/auth/logout", target.mutation(cookie, csrf))

    expect(logout.status).toBe(204)
    expect(setCookie(logout, "omod_session")).toContain("Max-Age=0")
    const after = await target.fetch("/api/v1/me", { headers: { cookie } })
    expect(after.status).toBe(401)
  })
})
