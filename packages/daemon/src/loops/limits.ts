import type { Config } from "../config"
import type { LoopBackoff, UserSettings } from "../core/types"
import { READ_BYTES_FLOOR } from "../config/types"

export interface EffectiveLoopLimits {
  readonly maxIterations: number
  readonly maxWallMs: number
  readonly maxConsecutiveFailures: number
  readonly checkTimeoutMs: number
  readonly cadenceMs: number
  readonly backoff: LoopBackoff
  readonly carryForwardBytes: number
  readonly readBytes: number
  readonly runTimeoutMs: number
}

/** Resolves global defaults and user overrides under the configured administrator ceilings. */
export function effectiveLoopLimits(
  config: Pick<Config, "defaults" | "hardCaps" | "limits">,
  settings: UserSettings,
): EffectiveLoopLimits {
  const { defaults, hardCaps } = config
  return {
    maxIterations: Math.min(settings.loopMaxIterations ?? defaults.loopMaxIterations, hardCaps.loopMaxIterations),
    maxWallMs: Math.min(settings.loopMaxWallMs ?? defaults.loopMaxWallMs, hardCaps.loopMaxWallMs),
    maxConsecutiveFailures: Math.min(
      settings.loopMaxConsecutiveFailures ?? defaults.loopMaxConsecutiveFailures,
      hardCaps.loopMaxConsecutiveFailures,
    ),
    checkTimeoutMs: Math.min(
      settings.loopCheckTimeoutMs ?? config.limits.loopCheckTimeoutMs,
      hardCaps.loopCheckTimeoutMs,
    ),
    cadenceMs: Math.min(settings.loopCadenceMs ?? defaults.loopCadenceMs, hardCaps.loopCadenceMs),
    backoff: {
      initialMs: Math.min(settings.loopBackoffInitialMs ?? defaults.loopBackoffInitialMs, hardCaps.loopBackoffMs),
      factor: Math.min(settings.loopBackoffFactor ?? defaults.loopBackoffFactor, hardCaps.loopBackoffFactor),
      maxMs: Math.min(settings.loopBackoffMaxMs ?? defaults.loopBackoffMaxMs, hardCaps.loopBackoffMs),
    },
    carryForwardBytes: Math.min(
      settings.loopCarryForwardBytes ?? defaults.loopCarryForwardBytes,
      hardCaps.loopCarryForwardBytes,
    ),
    readBytes: Math.max(READ_BYTES_FLOOR, Math.min(settings.readBytes ?? defaults.readBytes, hardCaps.readBytes)),
    runTimeoutMs: Math.min(settings.runTimeoutMs ?? defaults.runTimeoutMs, hardCaps.runTimeoutMs),
  }
}
