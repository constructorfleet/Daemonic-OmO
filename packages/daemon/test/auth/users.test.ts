import { describe, expect, test } from "bun:test"
import { AuthError } from "../../src/auth/http"
import { scopeFor } from "../../src/auth/users"
import { parseUlid } from "../../src/core/ids"
import type { User, UserId, UserRole } from "../../src/core/types"

function id(value: string): UserId {
  const parsed = parseUlid(value)
  if (parsed === null) throw new RangeError(`invalid test id: ${value}`)
  return parsed
}

const MEMBER_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FAV")
const OTHER_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FAW")

function user(userId: UserId, role: UserRole): User {
  return {
    id: userId,
    oidcIssuer: "https://issuer.example",
    oidcSub: userId,
    email: "",
    name: userId,
    role,
    agentDir: `/agents/${userId}`,
    allowedRoots: [],
    settings: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: null,
  }
}

function refusal(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    if (error instanceof AuthError) return `${error.status} ${error.code}`
    throw error
  }
}

describe("scopeFor", () => {
  test("a member is always scoped to their own rows and may not ask for another user's", () => {
    const member = user(MEMBER_ID, "member")

    expect(scopeFor(member, null)).toEqual({ kind: "user", userId: MEMBER_ID })
    expect(scopeFor(member, MEMBER_ID)).toEqual({ kind: "user", userId: MEMBER_ID })
    expect(refusal(() => scopeFor(member, OTHER_ID))).toBe("403 forbidden")
  })

  test("an admin sees every user by default and can narrow to one valid user id", () => {
    const admin = user(OTHER_ID, "admin")

    expect(scopeFor(admin, null)).toEqual({ kind: "all" })
    expect(scopeFor(admin, MEMBER_ID)).toEqual({ kind: "user", userId: MEMBER_ID })
    expect(refusal(() => scopeFor(admin, "../etc"))).toBe("400 invalid_arguments")
  })
})
