import { describe, expect, test } from "bun:test"

import { sessionId, threadId } from "../../src/core/ids"
import { decodeClose, decodeCreate, decodeSend, parseThreadList } from "../../src/omo/decode"
import { fixture, value } from "./support"

describe("decoding thread SDK answers pinned by todo 5", () => {
  test("list accepts the {kind, threads} object omo 5.1.79 prints and the array the reference documents", async () => {
    const object = await fixture("thread-list-cli")
    const rows = value(parseThreadList(object))
    expect(rows).toHaveLength(6)
    expect(rows[1]).toEqual({
      thread: threadId("d8c2a740-5530-89cf-a3a9-9f9f1ca1993a"),
      name: "omo-daemonic-contract-a2",
      cwd: "<ROOT>/project",
      state: "running",
      controls: [],
      sessionId: sessionId("d8c2a740-5530-89cf-a3a9-9f9f1ca1993a"),
      surface: "daemon",
    })
    const array = (object as { threads: unknown[] }).threads
    expect(value(parseThreadList(array))).toEqual(rows)
  })

  test("an unrecognized list shape is a refusal, not a throw", () => {
    expect(parseThreadList({ kind: "ok", rows: [] })).toEqual({ kind: "error", code: "internal", message: "unrecognized list answer" })
  })

  test("create, close and send keep the fields the run engine needs", async () => {
    expect(value(decodeCreate(await fixture("create")))).toEqual({
      thread: threadId("d8c2a740-5530-89cf-a3a9-9f9f1ca1993a"),
      sessionId: sessionId("d8c2a740-5530-89cf-a3a9-9f9f1ca1993a"),
      created: true,
    })
    expect(value(decodeCreate(await fixture("create-with-prompt-repeat"))).created).toBe(false)
    expect(value(decodeClose(await fixture("close-graceful")))).toEqual({ closed: true, reason: "closed" })
    expect(value(decodeSend(await fixture("send-dedup")))).toEqual({ delivered: true, deduplicated: true })
  })

  test("refusals keep their gateway code, and unknown codes become internal with the code in the message", async () => {
    expect(decodeCreate(await fixture("create-host-unavailable"))).toEqual({
      kind: "error",
      code: "host_unavailable",
      message: "The thread host is unavailable at <ROOT>/agent/rpc/rpc.sock.",
    })
    expect(decodeClose({ kind: "error", error: { code: "relay_requires_paid_plan", message: "paid" } })).toEqual({
      kind: "error",
      code: "internal",
      message: "relay_requires_paid_plan: paid",
    })
  })
})
