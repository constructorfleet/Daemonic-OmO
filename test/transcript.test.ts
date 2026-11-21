import { describe, expect, test } from "bun:test"

import { parseEventTranscript, visibleTranscript } from "../src/transcript"

describe("parseEventTranscript", () => {
  test("#given task event JSONL #when parsed #then assistant, tool and error activity is readable", () => {
    const text = [
      JSON.stringify({ type: "assistant_message", payload: { text: "I found the bug." } }),
      JSON.stringify({ type: "tool_execution", payload: { tool: "read" } }),
      JSON.stringify({ type: "child_error", payload: { message: "permission denied" } }),
    ].join("\n")

    expect(parseEventTranscript(text)).toEqual([
      "assistant: I found the bug.",
      "tool: read",
      "error: permission denied",
    ])
  })

  test("#given a partial final JSONL line #when parsed #then it ignores that write in progress", () => {
    const text = `${JSON.stringify({ type: "assistant_message", payload: { text: "complete" } })}\n{"type":"assistant_message","payload":{"text":"still writing` 
    expect(parseEventTranscript(text)).toEqual(["assistant: complete"])
  })

  test("#given malformed and future event rows #when parsed #then it keeps valid known rows", () => {
    const text = [
      "not json",
      JSON.stringify({ type: "future_event", payload: {} }),
      JSON.stringify({ type: "assistant_message", payload: { text: "still here" } }),
    ].join("\n")
    expect(parseEventTranscript(text)).toEqual(["assistant: still here"])
  })
})

describe("visibleTranscript", () => {
  test("#given a long transcript #when rendering the newest page #then it follows new output until the user scrolls back", () => {
    const lines = ["one", "two", "three", "four", "five"]
    expect(visibleTranscript(lines, 2, 0)).toEqual(["four", "five"])
    expect(visibleTranscript(lines, 2, 2)).toEqual(["two", "three"])
  })
})
