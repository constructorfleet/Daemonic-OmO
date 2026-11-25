import type { Reader } from "../reader"
import { DEFAULT_LIMITS, type LimitsConfig } from "../types"

export function readLimits(reader: Reader, raw: Record<string, unknown>): LimitsConfig {
  return {
    sessionTtlMs: reader.integer("limits.sessionTtlMs", raw.sessionTtlMs, DEFAULT_LIMITS.sessionTtlMs),
    eventRetentionDays: reader.integer(
      "limits.eventRetentionDays",
      raw.eventRetentionDays,
      DEFAULT_LIMITS.eventRetentionDays,
    ),
    eventRetentionMinRows: reader.integer(
      "limits.eventRetentionMinRows",
      raw.eventRetentionMinRows,
      DEFAULT_LIMITS.eventRetentionMinRows,
      0,
    ),
    sseSubscriberMaxFrames: reader.integer(
      "limits.sseSubscriberMaxFrames",
      raw.sseSubscriberMaxFrames,
      DEFAULT_LIMITS.sseSubscriberMaxFrames,
    ),
    sseSubscriberMaxBytes: reader.integer(
      "limits.sseSubscriberMaxBytes",
      raw.sseSubscriberMaxBytes,
      DEFAULT_LIMITS.sseSubscriberMaxBytes,
    ),
    idempotencyTtlMs: reader.integer(
      "limits.idempotencyTtlMs",
      raw.idempotencyTtlMs,
      DEFAULT_LIMITS.idempotencyTtlMs,
    ),
    machineMaxRunning: reader.integer(
      "limits.machineMaxRunning",
      raw.machineMaxRunning,
      DEFAULT_LIMITS.machineMaxRunning,
    ),
    maxKeptWorktreesPerProject: reader.integer(
      "limits.maxKeptWorktreesPerProject",
      raw.maxKeptWorktreesPerProject,
      DEFAULT_LIMITS.maxKeptWorktreesPerProject,
    ),
    auditRetentionDays: reader.integer(
      "limits.auditRetentionDays",
      raw.auditRetentionDays,
      DEFAULT_LIMITS.auditRetentionDays,
    ),
    loopCheckTimeoutMs: reader.integer(
      "limits.loopCheckTimeoutMs",
      raw.loopCheckTimeoutMs,
      DEFAULT_LIMITS.loopCheckTimeoutMs,
    ),
  }
}
