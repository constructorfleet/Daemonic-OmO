import { describe, expect, test } from "bun:test"

import { parseTerminals } from "../src/terminals"

const joined = (...lines: readonly string[]): string => `${lines.join("\n")}\n`

const resultMessage = (...toolCalls: readonly unknown[]): string =>
  JSON.stringify({
    type: "message",
    id: "m1",
    message: { role: "toolResult", toolName: "eval", content: [], details: { toolCalls } },
  })

const monitorCall = (overrides: Record<string, unknown> = {}): unknown => ({
  name: "monitor",
  ok: true,
  args: {
    description: "PR checks settle",
    command: "while :; do sleep 10; done; echo DONE",
    filter: "^DONE$",
    timeout_ms: 3_600_000,
    persistent: true,
    ...overrides,
  },
  resultPreview: "Monitor started with ID: mon_ABC123",
})

const bashCall = (preview: string, args: Record<string, unknown> = {}): unknown => ({
  name: "bash",
  ok: true,
  args: { command: "tools/check_changed.sh --tests=all", run_in_background: true, ...args },
  resultPreview: preview,
})

const custody = (source: string, state: string, items: readonly unknown[]): string =>
  JSON.stringify({
    type: "custom",
    customType: "work-custody",
    data: {
      key: `wake-source:${source}`,
      source,
      kind: "background",
      activeCount: items.length,
      state,
      items,
    },
  })

const lifecycle = (state: string): string =>
  JSON.stringify({ type: "custom", customType: "session-lifecycle", data: { state } })

describe("parseTerminals", () => {
  test("#given monitor and shell custody records #when parsed #then launches are joined to their items", () => {
    const text = joined(
      resultMessage(monitorCall(), bashCall("Command running in background with ID: bash_241")),
      custody("terminal-monitors", "open", [
        { id: "mon_ABC123", description: "PR checks settle", startedAtMs: 1_000 },
      ]),
      custody("terminal-background-sessions", "passive", [
        { id: "bash_241", description: "cd /tmp/project && tools/check_changed.sh --tests=all", startedAtMs: 2_000 },
      ]),
    )
    const snapshot = parseTerminals(text)
    expect(snapshot.items).toHaveLength(2)
    expect(snapshot.items[0]).toEqual({
      id: "bash_241",
      kind: "shell",
      state: "passive",
      description: "cd /tmp/project && tools/check_changed.sh --tests=all",
      startedAtMs: 2_000,
      command: "tools/check_changed.sh --tests=all",
    })
    expect(snapshot.items[1]).toEqual({
      id: "mon_ABC123",
      kind: "monitor",
      state: "open",
      description: "PR checks settle",
      startedAtMs: 1_000,
      command: "while :; do sleep 10; done; echo DONE",
      filter: "^DONE$",
      timeoutMs: 3_600_000,
      persistent: true,
    })
  })

  test("#given several custody records for one source #when parsed #then the newest record wins", () => {
    const text = joined(
      custody("terminal-monitors", "open", [{ id: "mon_OLD", description: "old", startedAtMs: 1 }]),
      custody("terminal-monitors", "passive", []),
    )
    expect(parseTerminals(text).items).toEqual([])
  })

  test("#given a foreground bash result #when parsed #then it is not a shell", () => {
    const text = joined(
      resultMessage(bashCall("446e43d57b0382ea", { run_in_background: false })),
      custody("terminal-background-sessions", "open", [
        { id: "bash_7", label: "make test", startedAt: 1_700_000_000 },
      ]),
    )
    const items = parseTerminals(text).items
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      id: "bash_7",
      kind: "shell",
      state: "open",
      description: "make test",
      startedAtMs: 1_700_000_000_000,
    })
  })

  test("#given lifecycle and unrelated wake sources #when parsed #then only terminal sources are used", () => {
    const text = joined(
      lifecycle("waiting_background"),
      custody("senpi-task", "open", [{ id: "st_1", description: "child", startedAtMs: 1 }]),
      custody("terminal-monitors", "open", [{ id: "mon_A", description: "watch", startedAtMs: 1 }]),
    )
    const snapshot = parseTerminals(text)
    expect(snapshot.sessionState).toBe("waiting_background")
    expect(snapshot.items.map((item) => item.id)).toEqual(["mon_A"])
  })

  test("#given malformed JSON #when parsed #then the rest of the file still parses", () => {
    const text = joined(
      "{not json",
      custody("terminal-monitors", "open", [{ id: "mon_A", description: "watch", startedAtMs: 1 }]),
      "[" + "]",
    )
    expect(parseTerminals(text).items[0]?.id).toBe("mon_A")
  })
})
