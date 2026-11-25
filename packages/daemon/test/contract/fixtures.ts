import { expect } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { CONTRACT, isRecord, type ContractContext } from "./harness"

const FIXTURES = join(import.meta.dir, "..", "fixtures", "omo")

/**
 * OMO_CONTRACT_RECORD=1 rewrites the scrubbed fixture; otherwise the live value must still carry
 * every top-level key (and the same `kind`) the pinned fixture has, so shape drift in omo fails here.
 */
export function matchFixture(ctx: ContractContext, name: string, live: unknown): void {
  const scrubbed: unknown = JSON.parse(scrub(ctx, JSON.stringify(live)))
  const path = join(FIXTURES, `${name}.json`)
  if (process.env.OMO_CONTRACT_RECORD === "1" && CONTRACT.live) {
    mkdirSync(FIXTURES, { recursive: true })
    writeFileSync(path, `${JSON.stringify(scrubbed, null, 2)}\n`)
    return
  }
  const pinned: unknown = JSON.parse(readFileSync(path, "utf8"))
  expect(Array.isArray(scrubbed)).toBe(Array.isArray(pinned))
  if (isRecord(pinned) && isRecord(scrubbed)) {
    expect(Object.keys(scrubbed)).toEqual(expect.arrayContaining(Object.keys(pinned)))
    if ("kind" in pinned) expect(scrubbed.kind).toBe(pinned.kind)
  }
}

function scrub(ctx: ContractContext, text: string): string {
  return text
    .replaceAll(realpathSync.native(ctx.root), "<ROOT>")
    .replaceAll(ctx.root, "<ROOT>")
    .replaceAll(process.env.HOME ?? homedir(), "<HOME>")
}
