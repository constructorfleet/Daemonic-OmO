import type { Database } from "bun:sqlite"
import { homedir } from "node:os"

import { expandTilde } from "../config/paths"
import type { Config, Env } from "../config/types"
import type { Clock, Fs, Gateway } from "../core/ports"
import type { EventLedger } from "../db/ledger"
import { BridgeClient } from "../omo/bridge-client"
import { readCompatReport, saveCompatReport } from "../omo/compat"
import { OmoCli } from "../omo/host"
import { runCompatProbe, type CompatReport } from "../omo/probe"

export interface OmoFeatureContext {
  readonly config: Config
  readonly db: Database
  readonly ledger: EventLedger
  readonly clock: Clock
  readonly fs: Fs
  /** The daemon's environment; omo children only ever see its allowlisted keys. */
  readonly env: Env
}

export interface OmoFeature {
  /** The Gateway for one agent dir: one bridge child per agent dir, shared by every caller. */
  gatewayFor(agentDir: string): Gateway
  /** Probes every user's agent dir; call once on daemon start. */
  start(): Promise<CompatReport>
  probe(): Promise<CompatReport>
  /** The newest stored report, as `/health` serves it. */
  compat(): CompatReport | null
  stop(): Promise<void>
}

/**
 * omo gateway feature: per-agent-dir bridge clients, the compatibility probe on start and on every omo-ai
 * version change, and the stored CompatReport (`meta`, `daemon.compat` events).
 */
export function register(ctx: OmoFeatureContext): OmoFeature {
  const clients = new Map<string, BridgeClient>()
  let running: Promise<CompatReport> | null = null
  let rerun = false

  const gatewayFor = (agentDir: string): BridgeClient => {
    const existing = clients.get(agentDir)
    if (existing !== undefined) return existing
    const client = new BridgeClient({
      agentDir,
      omo: ctx.config.omo,
      clock: ctx.clock,
      fs: ctx.fs,
      baseEnv: ctx.env,
      onVersionChange: async () => {
        // A change seen by a probe's own calls must not await that probe: rerun it after it finishes instead.
        if (running !== null) rerun = true
        else await probe()
      },
    })
    clients.set(agentDir, client)
    return client
  }

  const agentDirs = (): readonly string[] => {
    const users = ctx.db.query<{ agent_dir: string }, []>("SELECT DISTINCT agent_dir FROM users ORDER BY agent_dir").all()
    const bootstrap = expandTilde(ctx.config.users.bootstrapAdmin.agentDir, ctx.env.HOME ?? homedir())
    return [...new Set([...users.map((row) => row.agent_dir), bootstrap])]
  }

  const probeOnce = async (): Promise<CompatReport> => {
    const targets = agentDirs().map((agentDir) => ({
      agentDir,
      gateway: gatewayFor(agentDir),
      cli: new OmoCli({ bin: ctx.config.omo.bin, agentDir, baseEnv: ctx.env, clock: ctx.clock }),
    }))
    const report = await runCompatProbe({ clock: ctx.clock, fs: ctx.fs, targets })
    saveCompatReport(ctx.db, ctx.ledger, report)
    return report
  }

  const probe = (): Promise<CompatReport> => {
    if (running !== null) {
      rerun = true
      return running
    }
    running = (async () => {
      try {
        let report = await probeOnce()
        while (rerun) {
          rerun = false
          report = await probeOnce()
        }
        return report
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    gatewayFor,
    start: probe,
    probe,
    compat: () => readCompatReport(ctx.db),
    stop: async () => {
      await Promise.all([...clients.values()].map((client) => client.stop()))
      clients.clear()
    },
  }
}
