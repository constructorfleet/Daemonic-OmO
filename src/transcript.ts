export function parseEventTranscript(text: string): readonly string[] {
  const lines: string[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(entry) || !isRecord(entry.payload)) continue
    const { payload } = entry
    if (entry.type === "assistant_message" && typeof payload.text === "string") {
      lines.push(...safeText(payload.text).split("\n").map((part) => `assistant: ${part}`))
    } else if (entry.type === "tool_execution" && typeof payload.tool === "string") {
      lines.push(`${payload.is_error === true ? "tool[error]" : "tool"}: ${safeText(payload.tool)}`)
    } else if (entry.type === "child_error" && typeof payload.message === "string") {
      lines.push(`error: ${safeText(payload.message)}`)
    }
  }
  return lines
}

export function parseSessionTranscript(text: string): readonly string[] {
  const lines: string[] = []
  for (const line of text.split("\n")) {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue
    const message = entry.message
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    const content = message.content
      .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => safeText(part.text))
      .join("")
    if (content.length > 0) lines.push(...content.split("\n").map((part) => `assistant: ${part}`))
  }
  return lines
}

export function visibleTranscript(lines: readonly string[], rows: number, offset: number): readonly string[] {
  if (rows <= 0) return []
  const end = Math.max(0, lines.length - Math.max(0, offset))
  return lines.slice(Math.max(0, end - rows), end)
}

export function safeText(text: string): string {
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
