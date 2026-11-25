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
    maxCatchup: reader.integer("defaults.maxCatchup", raw.maxCatchup, DEFAULT_DEFAULTS.maxCatchup),
    readBytes: reader.integer("defaults.readBytes", raw.readBytes, DEFAULT_DEFAULTS.readBytes, {
      min: READ_BYTES_FLOOR,
      max: hardCaps.readBytes,
      maxLabel: "hardCaps.readBytes",
    }),
  }
}
