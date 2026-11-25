import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { AuthError } from "../../src/auth/http"
import {
  AuthHarness,
  BREAKGLASS_TOKEN,
  MockIdp,
  PROBE,
  errorCode,
  type HarnessOptions,
} from "./harness"

let idp: MockIdp
const harnesses: AuthHarness[] = []
const REMOTE_PEER = "198.51.100.7"
const PROXY_PEER = "203.0.113.9"

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

function rejection(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    if (error instanceof AuthError) return `${error.status} ${error.code}`
    throw error
  }
}

function probeRequest(target: AuthHarness, headers: Record<string, string>): Request {
  return new Request(target.url(PROBE), { headers })
}

function rawGet(target: AuthHarness, host: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(target.origin)
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path: "/api/v1/me", headers: { host } }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    outgoing.on("error", reject)
    outgoing.end()
  })
}

describe("request guard", () => {
  test("a request whose Host is not trusted is rejected before any route runs", async () => {
    const target = await harness()

    const response = await rawGet(target, "evil.example")

    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "forbidden" } })
    console.log(`QA failure: GET /api/v1/me with Host: evil.example -> ${response.status} ${response.body}`)
  })

  test("X-Forwarded-Host is ignored from an untrusted peer and honored from a trusted proxy", async () => {
    const direct = await harness()
    const trustedHost = new URL(direct.origin).host
    const proxied = await harness({ trustedProxies: [PROXY_PEER] })
    const proxiedHost = new URL(proxied.origin).host

    expect(rejection(() => direct.auth.guard.admitPublic(
      probeRequest(direct, { host: "evil.example", "x-forwarded-host": trustedHost }), REMOTE_PEER,
    ))).toBe("403 forbidden")
    expect(rejection(() => direct.auth.guard.admitPublic(
      probeRequest(direct, { host: trustedHost, "x-forwarded-host": "evil.example" }), REMOTE_PEER,
    ))).toBeNull()
    expect(rejection(() => proxied.auth.guard.admitPublic(
      probeRequest(proxied, { host: "backend.internal", "x-forwarded-host": proxiedHost }), PROXY_PEER,
    ))).toBeNull()
    expect(rejection(() => proxied.auth.guard.admitPublic(
      probeRequest(proxied, { host: proxiedHost, "x-forwarded-host": "evil.example" }), PROXY_PEER,
    ))).toBe("403 forbidden")
  })

  test("a mutation needs the session's csrf token, the public origin and a JSON body", async () => {
    const target = await harness()
    target.provision(idp.issuer, "alice")
    const { cookie, csrf } = await target.session(idp, { sub: "alice" })

    const accepted = await target.fetch(PROBE, target.mutation(cookie, csrf))
    const missingCsrf = await target.fetch(PROBE, target.mutation(cookie, null))
    const wrongCsrf = await target.fetch(PROBE, target.mutation(cookie, `${csrf}x`))
    const foreignOrigin = await target.fetch(PROBE, target.mutation(cookie, csrf, { origin: "http://evil.example" }))
    const formBody = await target.fetch(PROBE, target.mutation(cookie, csrf, { "content-type": "text/plain" }))

    expect(accepted.status).toBe(200)
    expect([missingCsrf.status, await errorCode(missingCsrf)]).toEqual([403, "forbidden"])
    expect([wrongCsrf.status, await errorCode(wrongCsrf)]).toEqual([403, "forbidden"])
    expect([foreignOrigin.status, await errorCode(foreignOrigin)]).toEqual([403, "forbidden"])
    expect([formBody.status, await errorCode(formBody)]).toEqual([400, "invalid_arguments"])
  })

  test("activity slides the session expiry and an idle session past sessionTtlMs is rejected", async () => {
    const target = await harness()
    target.provision(idp.issuer, "alice")
    const { cookie } = await target.session(idp, { sub: "alice" })
    const ttl = target.config.limits.sessionTtlMs

    target.clock.advance(ttl - 1)
    const stillActive = await target.fetch(PROBE, { headers: { cookie } })
    target.clock.advance(ttl - 1)
    const slid = await target.fetch(PROBE, { headers: { cookie } })
    target.clock.advance(ttl)
    const expired = await target.fetch(PROBE, { headers: { cookie } })

    expect(stillActive.status).toBe(200)
    expect(slid.status).toBe(200)
    expect([expired.status, await errorCode(expired)]).toEqual([401, "unauthenticated"])
  })

  test("the break-glass token from a non-loopback client is 401", async () => {
    const target = await harness({ trustedProxies: ["127.0.0.1"] })
    const host = new URL(target.origin).host
    const bearer = { host, authorization: `Bearer ${BREAKGLASS_TOKEN}` }

    expect(rejection(() => target.auth.guard.authenticate(probeRequest(target, bearer), "192.0.2.10")))
      .toBe("401 unauthenticated")
    expect(rejection(() => target.auth.guard.authenticate(
      probeRequest(target, { ...bearer, "x-forwarded-for": "192.0.2.10" }), "127.0.0.1",
    ))).toBe("401 unauthenticated")
    expect(rejection(() => target.auth.guard.authenticate(
      probeRequest(target, { host, authorization: "Bearer wrong" }), "127.0.0.1",
    ))).toBe("401 unauthenticated")
  })

  test("the break-glass token over loopback acts as the bootstrap admin without a csrf token", async () => {
    const target = await harness({ users: { bootstrapAdmin: { agentDir: "/owner/agent" } } })

    const body = await target.breakglassMe()
    const mutation = await target.fetch(PROBE, {
      method: "POST",
      headers: { authorization: `Bearer ${BREAKGLASS_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    })

    expect(body).toMatchObject({ role: "admin", csrfToken: null, user: { role: "admin", agentDir: "/owner/agent" } })
    expect(mutation.status).toBe(200)
  })

  test("no response carries CORS headers, even for a cross-origin preflight", async () => {
    const target = await harness()
    target.provision(idp.issuer, "alice")
    const { cookie } = await target.session(idp, { sub: "alice" })

    const responses = await Promise.all([
      target.fetch(PROBE, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } }),
      target.fetch("/api/v1/me", { headers: { cookie, origin: "http://evil.example" } }),
      target.fetch("/auth/login", { headers: { origin: "http://evil.example" } }),
    ])

    const corsHeaders = responses.flatMap((response) =>
      [...response.headers.keys()].filter((name) => name.startsWith("access-control-")))
    expect(corsHeaders).toEqual([])
  })
})
