import type { Reader } from "../reader"
import type { OmoConfig } from "../types"

export function readOmo(
  reader: Reader,
  raw: Record<string, unknown>,
  fallback: OmoConfig,
): OmoConfig {
  const bin = reader.binPath("omo.bin", raw.bin, fallback.bin)
  if (bin.trim().length === 0) {
    reader.issue("omo.bin", "must be a non-empty command or path")
  }
  return {
    bin,
    pluginRoot: reader.absolutePath(
      "omo.pluginRoot",
      raw.pluginRoot,
      fallback.pluginRoot,
      "point it at <omo-ai>/plugin",
    ),
  }
}
