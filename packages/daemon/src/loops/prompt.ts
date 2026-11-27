import { parseSessionTurns } from "@omo-daemonic/store"

import { FsError, type Fs } from "../core/ports"
import type { Loop, Run, LoopTemplate } from "../core/types"

export function decisionPrompt(template: LoopTemplate, loop: Loop, previous: string): string {
  const prompt = previous.length === 0
    ? template.spec.prompt
    : `Previous iteration ended with:\n${previous}\n\n${template.spec.prompt}`
  if (!loop.doneWhen.some((predicate) => predicate.kind === "marker")) return prompt
  return `${prompt}\n\nEnd the final assistant turn with exactly one whole line:\nLOOP_DONE ${loop.nonce}\nLOOP_CONTINUE ${loop.nonce}\nLOOP_BLOCKED ${loop.nonce}: <reason>`
}

export async function carryForward(run: Run, fs: Fs, maxBytes: number): Promise<string> {
  if (run.sessionFile === undefined || maxBytes === 0) return ""
  try {
    const { size } = await fs.stat(run.sessionFile)
    const start = Math.max(run.transcriptBaselineBytes ?? 0, size - maxBytes)
    const content = new TextDecoder().decode(await fs.readFileRange(run.sessionFile, start, size - start))
    const turns = parseSessionTurns(content)
    const finalTurn = turns.at(-1)
    const text = finalTurn?.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n") ?? ""
    return new TextDecoder().decode(new TextEncoder().encode(text).subarray(-maxBytes))
  } catch (error) {
    if (error instanceof FsError && error.code === "not_found") return ""
    throw error
  }
}
