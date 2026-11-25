import type { Clock, Fs, Gateway } from "../core/ports"
import type { Iso } from "../core/types"
import { countDagJournals, countSessionFiles, countTaskRecords, type DecodeCount } from "./decoders"
import type { OmoCli } from "./host"

/** The omo release the todo 5 contract suite pinned (FINDINGS.md "Environment"). */
export const TESTED_OMO_VERSION = "5.1.79"

export type CompatCheck = {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
  /** The agent dir the check ran against; `null` for machine-wide checks. */
  readonly agentDir: string | null
}

/** Stored in `meta`, served by `/health` and emitted as the `daemon.compat` entity event. */
export type CompatReport = {
  readonly omoVersion: string | null
  readonly testedVersion: string
  /** Display only: spawns never pass a preset (decision gate resolution 2026-11-25). */
  readonly presets: readonly string[]
  readonly permissionMode: "agent-dir-default"
  readonly checkedAt: Iso
  readonly checks: readonly CompatCheck[]
}

export interface ProbeTarget {
  readonly agentDir: string
  readonly gateway: Gateway
  readonly cli: OmoCli
}

export interface ProbeDeps {
  readonly clock: Clock
  readonly fs: Fs
  readonly targets: readonly ProbeTarget[]
}

/** Runs on daemon start and on an omo-ai version change. Never throws: a failing step is a failing check. */
export async function runCompatProbe(deps: ProbeDeps): Promise<CompatReport> {
  const first = deps.targets[0]
  const version = first === undefined ? { version: null, detail: "no agent dir to run omo with" } : await first.cli.version()
  const checks: CompatCheck[] = [versionCheck(version)]
  let presets: readonly string[] = []
  for (const target of deps.targets) {
    const probe = await target.gateway.probe()
    if (probe.sdkLoad === "ok" && presets.length === 0) presets = probe.presetNames
    checks.push(...(await targetChecks(deps.fs, target, probe.sdkLoad === "ok", probe.detail)))
  }
  return {
    omoVersion: version.version,
    testedVersion: TESTED_OMO_VERSION,
    presets,
    permissionMode: "agent-dir-default",
    checkedAt: new Date(deps.clock.now()).toISOString(),
    checks,
  }
}

function versionCheck(found: { readonly version: string | null; readonly detail: string }): CompatCheck {
  const ok = found.version === TESTED_OMO_VERSION
  const detail = found.version === null
    ? `omo --version failed: ${found.detail}`
    : ok ? found.detail : `omo ${found.version}; contract tested against ${TESTED_OMO_VERSION}`
  return { name: "omo.version", ok, detail, agentDir: null }
}

async function targetChecks(fs: Fs, target: ProbeTarget, sdkLoaded: boolean, sdkDetail: string | null): Promise<readonly CompatCheck[]> {
  const check = async (name: string, run: () => Promise<{ readonly ok: boolean; readonly detail: string }>): Promise<CompatCheck> => {
    try {
      return { name, ...(await run()), agentDir: target.agentDir }
    } catch (error) {
      return { name, ok: false, detail: error instanceof Error ? error.message : String(error), agentDir: target.agentDir }
    }
  }
  return [
    { name: "sdk.load", ok: sdkLoaded, detail: sdkDetail ?? (sdkLoaded ? "loaded" : "failed"), agentDir: target.agentDir },
    await check("thread.list", async () => {
      if (!sdkLoaded) return { ok: false, detail: "skipped: sdk.load failed" }
      const listed = await target.gateway.list({ allScope: true })
      return listed.kind === "ok" ? { ok: true, detail: `${listed.value.length} threads listed` } : { ok: false, detail: `${listed.code}: ${listed.message}` }
    }),
    await check("schedule.list", async () => {
      const listed = await target.cli.scheduleList()
      if (listed.kind === "error") return { ok: false, detail: `${listed.code}: ${listed.message}` }
      return counted({ total: listed.value.jobs + listed.value.invalid, invalid: listed.value.invalid }, "schedules")
    }),
    await check("task.records", async () => counted(await countTaskRecords(fs, target.agentDir), "task records")),
    await check("session.files", async () => counted(await countSessionFiles(fs, target.agentDir), "session files")),
    await check("dag.schemaVersion", async () => {
      const journals = await countDagJournals(fs, target.agentDir)
      if (journals.invalid === 0) return { ok: true, detail: `${journals.total} DAG journals, all schemaVersion 1` }
      const versions = journals.unknownVersions.length > 0 ? journals.unknownVersions.join(", ") : "missing"
      return { ok: false, detail: `${journals.invalid} of ${journals.total} DAG journals have an unknown schemaVersion (${versions})` }
    }),
  ]
}

function counted(count: DecodeCount, noun: string): { readonly ok: boolean; readonly detail: string } {
  return count.invalid === 0
    ? { ok: true, detail: `${count.total} ${noun}, none invalid` }
    : { ok: false, detail: `${count.invalid} of ${count.total} ${noun} invalid` }
}
