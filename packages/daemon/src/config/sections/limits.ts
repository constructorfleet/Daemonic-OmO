import type { Reader } from "../reader"
import { DEFAULT_LIMITS, type LimitsConfig } from "../types"

// omo itself refuses thread messages above 1 MiB, so config may lower the cap but never raise it.
// DEFAULT_LIMITS.threadMessageMaxBytes equals this ceiling.
const THREAD_MESSAGE_MAX_BYTES_CEILING = 1_048_576

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
    observerActivePollMs: reader.integer(
      "limits.observerActivePollMs",
      raw.observerActivePollMs,
      DEFAULT_LIMITS.observerActivePollMs,
    ),
    observerIdlePollMs: reader.integer(
      "limits.observerIdlePollMs",
      raw.observerIdlePollMs,
      DEFAULT_LIMITS.observerIdlePollMs,
    ),
    observerMaxOpenDocs: reader.integer(
      "limits.observerMaxOpenDocs",
      raw.observerMaxOpenDocs,
      DEFAULT_LIMITS.observerMaxOpenDocs,
    ),
    observerIdleEvictMs: reader.integer(
      "limits.observerIdleEvictMs",
      raw.observerIdleEvictMs,
      DEFAULT_LIMITS.observerIdleEvictMs,
    ),
    observerMaxTurns: reader.integer(
      "limits.observerMaxTurns",
      raw.observerMaxTurns,
      DEFAULT_LIMITS.observerMaxTurns,
    ),
    observerMaxEventLines: reader.integer(
      "limits.observerMaxEventLines",
      raw.observerMaxEventLines,
      DEFAULT_LIMITS.observerMaxEventLines,
    ),
    observerMaxOlderTurns: reader.integer(
      "limits.observerMaxOlderTurns",
      raw.observerMaxOlderTurns,
      DEFAULT_LIMITS.observerMaxOlderTurns,
    ),
    observerPageMaxTurns: reader.integer(
      "limits.observerPageMaxTurns",
      raw.observerPageMaxTurns,
      DEFAULT_LIMITS.observerPageMaxTurns,
    ),
    observerImageCacheBytes: reader.integer(
      "limits.observerImageCacheBytes",
      raw.observerImageCacheBytes,
      DEFAULT_LIMITS.observerImageCacheBytes,
    ),
    threadMessageMaxBytes: reader.integer(
      "limits.threadMessageMaxBytes",
      raw.threadMessageMaxBytes,
      DEFAULT_LIMITS.threadMessageMaxBytes,
      { max: THREAD_MESSAGE_MAX_BYTES_CEILING, maxLabel: "the upstream omo 1 MiB thread message limit" },
    ),
    threadQueueTtlMs: reader.integer(
      "limits.threadQueueTtlMs",
      raw.threadQueueTtlMs,
      DEFAULT_LIMITS.threadQueueTtlMs,
    ),
  }
}
