import { MISFIRE_POLICIES, OVERLAP_POLICIES, type MisfirePolicy, type OverlapPolicy } from "../../core/types"
import type { Reader } from "../reader"
import {
  DEFAULT_DEFAULTS,
  DEFAULT_HARD_CAPS,
  READ_BYTES_FLOOR,
  type DefaultsConfig,
  type HardCapsConfig,
} from "../types"

export function readHardCaps(reader: Reader, raw: Record<string, unknown>): HardCapsConfig {
  return {
    maxRunning: reader.integer("hardCaps.maxRunning", raw.maxRunning, DEFAULT_HARD_CAPS.maxRunning),
    maxRunningPerProject: reader.integer(
      "hardCaps.maxRunningPerProject",
      raw.maxRunningPerProject,
      DEFAULT_HARD_CAPS.maxRunningPerProject,
    ),
    loopMaxIterations: reader.integer(
      "hardCaps.loopMaxIterations",
      raw.loopMaxIterations,
      DEFAULT_HARD_CAPS.loopMaxIterations,
    ),
    loopMaxWallMs: reader.integer(
      "hardCaps.loopMaxWallMs",
      raw.loopMaxWallMs,
      DEFAULT_HARD_CAPS.loopMaxWallMs,
    ),
    loopMaxConsecutiveFailures: reader.integer(
      "hardCaps.loopMaxConsecutiveFailures",
      raw.loopMaxConsecutiveFailures,
      DEFAULT_HARD_CAPS.loopMaxConsecutiveFailures,
    ),
    loopCheckTimeoutMs: reader.integer(
      "hardCaps.loopCheckTimeoutMs",
      raw.loopCheckTimeoutMs,
      DEFAULT_HARD_CAPS.loopCheckTimeoutMs,
    ),
    loopCadenceMs: reader.integer(
      "hardCaps.loopCadenceMs",
      raw.loopCadenceMs,
      DEFAULT_HARD_CAPS.loopCadenceMs,
      0,
    ),
    loopBackoffMs: reader.integer(
      "hardCaps.loopBackoffMs",
      raw.loopBackoffMs,
      DEFAULT_HARD_CAPS.loopBackoffMs,
      0,
    ),
    loopBackoffFactor: reader.integer(
      "hardCaps.loopBackoffFactor",
      raw.loopBackoffFactor,
      DEFAULT_HARD_CAPS.loopBackoffFactor,
    ),
    loopCarryForwardBytes: reader.integer(
      "hardCaps.loopCarryForwardBytes",
      raw.loopCarryForwardBytes,
      DEFAULT_HARD_CAPS.loopCarryForwardBytes,
      0,
    ),
    runTimeoutMs: reader.integer(
      "hardCaps.runTimeoutMs",
      raw.runTimeoutMs,
      DEFAULT_HARD_CAPS.runTimeoutMs,
    ),
    readBytes: reader.integer(
      "hardCaps.readBytes",
      raw.readBytes,
      DEFAULT_HARD_CAPS.readBytes,
      READ_BYTES_FLOOR,
    ),
  }
}

export function readDefaults(
  reader: Reader,
  raw: Record<string, unknown>,
  hardCaps: HardCapsConfig,
): DefaultsConfig {
  return {
    maxRunning: reader.integer("defaults.maxRunning", raw.maxRunning, DEFAULT_DEFAULTS.maxRunning, {
      max: hardCaps.maxRunning,
      maxLabel: "hardCaps.maxRunning",
    }),
    maxRunningPerProject: reader.integer(
      "defaults.maxRunningPerProject",
      raw.maxRunningPerProject,
      DEFAULT_DEFAULTS.maxRunningPerProject,
      { max: hardCaps.maxRunningPerProject, maxLabel: "hardCaps.maxRunningPerProject" },
    ),
    loopMaxIterations: reader.integer(
      "defaults.loopMaxIterations",
      raw.loopMaxIterations,
      DEFAULT_DEFAULTS.loopMaxIterations,
      { max: hardCaps.loopMaxIterations, maxLabel: "hardCaps.loopMaxIterations" },
    ),
    loopMaxWallMs: reader.integer(
      "defaults.loopMaxWallMs",
      raw.loopMaxWallMs,
      DEFAULT_DEFAULTS.loopMaxWallMs,
      { max: hardCaps.loopMaxWallMs, maxLabel: "hardCaps.loopMaxWallMs" },
    ),
    loopMaxConsecutiveFailures: reader.integer(
      "defaults.loopMaxConsecutiveFailures",
      raw.loopMaxConsecutiveFailures,
      DEFAULT_DEFAULTS.loopMaxConsecutiveFailures,
      { max: hardCaps.loopMaxConsecutiveFailures, maxLabel: "hardCaps.loopMaxConsecutiveFailures" },
    ),
    loopCadenceMs: reader.integer(
      "defaults.loopCadenceMs",
      raw.loopCadenceMs,
      DEFAULT_DEFAULTS.loopCadenceMs,
      { min: 0, max: hardCaps.loopCadenceMs, maxLabel: "hardCaps.loopCadenceMs" },
    ),
    loopBackoffInitialMs: reader.integer(
      "defaults.loopBackoffInitialMs",
      raw.loopBackoffInitialMs,
      DEFAULT_DEFAULTS.loopBackoffInitialMs,
      { min: 0, max: hardCaps.loopBackoffMs, maxLabel: "hardCaps.loopBackoffMs" },
    ),
    loopBackoffFactor: reader.integer(
      "defaults.loopBackoffFactor",
      raw.loopBackoffFactor,
      DEFAULT_DEFAULTS.loopBackoffFactor,
      { max: hardCaps.loopBackoffFactor, maxLabel: "hardCaps.loopBackoffFactor" },
    ),
    loopBackoffMaxMs: reader.integer(
      "defaults.loopBackoffMaxMs",
      raw.loopBackoffMaxMs,
      DEFAULT_DEFAULTS.loopBackoffMaxMs,
      { min: 0, max: hardCaps.loopBackoffMs, maxLabel: "hardCaps.loopBackoffMs" },
    ),
    loopCarryForwardBytes: reader.integer(
      "defaults.loopCarryForwardBytes",
      raw.loopCarryForwardBytes,
      DEFAULT_DEFAULTS.loopCarryForwardBytes,
      { min: 0, max: hardCaps.loopCarryForwardBytes, maxLabel: "hardCaps.loopCarryForwardBytes" },
    ),
    runTimeoutMs: reader.integer(
      "defaults.runTimeoutMs",
      raw.runTimeoutMs,
      DEFAULT_DEFAULTS.runTimeoutMs,
      { max: hardCaps.runTimeoutMs, maxLabel: "hardCaps.runTimeoutMs" },
    ),
    overlap: reader.enumValue<OverlapPolicy>(
      "defaults.overlap",
      raw.overlap,
      OVERLAP_POLICIES,
      DEFAULT_DEFAULTS.overlap,
    ),
    misfire: reader.enumValue<MisfirePolicy>(
      "defaults.misfire",
      raw.misfire,
      MISFIRE_POLICIES,
      DEFAULT_DEFAULTS.misfire,
    ),
    misfireGraceMs: reader.integer(
      "defaults.misfireGraceMs",
      raw.misfireGraceMs,
      DEFAULT_DEFAULTS.misfireGraceMs,
      0,
    ),
    skipMisfireGraceMs: reader.integer(
      "defaults.skipMisfireGraceMs",
      raw.skipMisfireGraceMs,
      DEFAULT_DEFAULTS.skipMisfireGraceMs,
      0,
    ),
    onceMisfireGraceMs: reader.integer(
      "defaults.onceMisfireGraceMs",
      raw.onceMisfireGraceMs,
      DEFAULT_DEFAULTS.onceMisfireGraceMs,
      0,
    ),
    queueMax: reader.integer("defaults.queueMax", raw.queueMax, DEFAULT_DEFAULTS.queueMax, 1),
    queueMinExpiryMs: reader.integer(
      "defaults.queueMinExpiryMs",
      raw.queueMinExpiryMs,
      DEFAULT_DEFAULTS.queueMinExpiryMs,
      1,
    ),
    maxCatchup: reader.integer("defaults.maxCatchup", raw.maxCatchup, DEFAULT_DEFAULTS.maxCatchup),
    readBytes: reader.integer("defaults.readBytes", raw.readBytes, DEFAULT_DEFAULTS.readBytes, {
      min: READ_BYTES_FLOOR,
      max: hardCaps.readBytes,
      maxLabel: "hardCaps.readBytes",
    }),
  }
}
