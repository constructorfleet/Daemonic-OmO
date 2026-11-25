import { afterEach, describe, expect, test } from "bun:test"
import { member, memberHeaders, server, stopServers } from "../api/harness"

afterEach(stopServers)

describe("thread control refusal mapping", () => {
  test("maps gateway refusals to their HTTP status and error code", async () => {
    const cases = [
      { gatewayCode: "not_found", status: 404, apiCode: "not_found" },
      { gatewayCode: "scope_denied", status: 403, apiCode: "forbidden" },
      { gatewayCode: "turn_conflict", status: 409, apiCode: "state_conflict" },
      { gatewayCode: "loop_detected", status: 409, apiCode: "state_conflict" },
      { gatewayCode: "host_unavailable", status: 503, apiCode: "host_unavailable" },
    ] as const

    for (const scenario of cases) {
      const target = await server()
      const alice = await member(target, `alice-${scenario.gatewayCode}`)
      const thread = target.gateway.seedThread({ name: scenario.gatewayCode, cwd: "/work/alpha" })
      target.gateway.setThreadControls(thread, ["send"])
      target.gateway.send = async () => ({
        kind: "error",
        code: scenario.gatewayCode,
        message: "gateway refused",
      })

      const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
        method: "POST",
        headers: memberHeaders(target, alice, { "idempotency-key": `refusal-${scenario.gatewayCode}` }),
        body: JSON.stringify({ text: "message", mode: "auto" }),
      })
      const body: unknown = await response.json()

      expect(response.status).toBe(scenario.status)
      expect(body).toMatchObject({
        error: {
          code: scenario.apiCode,
          message: "gateway refused",
          ...(scenario.gatewayCode === "host_unavailable" ? { details: { retryAfterMs: 1_000 } } : {}),
        },
      })
    }
  })
})
