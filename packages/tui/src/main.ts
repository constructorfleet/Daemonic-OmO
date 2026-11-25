#!/usr/bin/env bun

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runViewer } from "./viewer.js"
import { resolveAgentDir, resolveTaskStateDir } from "@omo-daemonic/store"
import { buildTmuxPlan, runTmuxPlan } from "./wrapper.js"

const HELP = `OmO Agent Viewer

Usage: omo-agents [--project <path>] [--state-dir <path>] [--refresh-ms <ms>]
       omo-agents --wrap [viewer options] [-- <omo arguments...>]

Options:
  --project <path>    Project whose delegated tasks to watch (default: current directory)
  --agent-dir <path>  OmO Native agent directory (default: configured agent directory)
  --state-dir <path>  Explicit Senpi task state directory
  --refresh-ms <ms>   Read interval from 250 to 10000 ms (default: 1000)
  --read-bytes <n>    Transcript bytes read per session file, 64 KiB to 64 MiB (default: 4 MiB)
  --wrap              Launch omo and this viewer side-by-side in tmux
  -- <args...>        Pass remaining arguments to omo when using --wrap
  -h, --help          Show this help

Keys: ↑/↓ select or scroll, Enter/→ expand main or open agent, o open, ← back, Tab panes, 1/2/3 filters, 4 todo done, t newest turn, l todo, j/k scroll, g latest, p pause, r refresh, q quit
Mouse: wheel scrolls the focused pane; click a task or transcript line to open it
`

export interface CliOptions {
  readonly projectDir: string
  readonly agentDir?: string
  readonly stateDir?: string
  readonly refreshMs: number
  readonly readBytes: number
  readonly help: boolean
  readonly wrap: boolean
  readonly omoArgs: readonly string[]
}

export function parseArgs(args: readonly string[], cwd = process.cwd()): CliOptions {
  let projectDir = cwd
  let agentDir: string | undefined
  let stateDir: string | undefined
  let refreshMs = 1_000
  let readBytes = 4 * 1024 * 1024
  let help = false
  let wrap = false
  let omoArgs: readonly string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--") {
      if (!wrap) throw new Error("-- can only be used with --wrap")
      omoArgs = args.slice(index + 1)
      break
    } else if (arg === "-h" || arg === "--help") help = true
    else if (arg === "--wrap") wrap = true
    else if (arg === "--project") projectDir = requiredValue(args, ++index, arg)
    else if (arg === "--agent-dir") agentDir = requiredValue(args, ++index, arg)
    else if (arg === "--state-dir") stateDir = requiredValue(args, ++index, arg)
    else if (arg === "--refresh-ms") {
      const value = Number(requiredValue(args, ++index, arg))
      if (!Number.isInteger(value) || value < 250 || value > 10_000) {
        throw new Error("--refresh-ms must be an integer from 250 to 10000")
      }
      refreshMs = value
    } else if (arg === "--read-bytes") {
      const value = Number(requiredValue(args, ++index, arg))
      if (!Number.isInteger(value) || value < 64 * 1024 || value > 64 * 1024 * 1024) {
        throw new Error("--read-bytes must be an integer from 65536 to 67108864")
      }
      readBytes = value
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  return {
    projectDir: resolve(cwd, projectDir),
    ...(agentDir === undefined ? {} : { agentDir: resolve(cwd, agentDir) }),
    ...(stateDir === undefined ? {} : { stateDir: resolve(cwd, stateDir) }),
    refreshMs,
    readBytes,
    help,
    wrap,
    omoArgs,
  }
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} needs a value`)
  return value
}

export async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(HELP)
      return
    }
    const agentDir = resolveAgentDir({ ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }) })
    const stateDir = resolveTaskStateDir(options.projectDir, { stateDir: options.stateDir, agentDir })
    if (options.wrap) {
      const viewerCommand = [
        process.execPath,
        fileURLToPath(import.meta.url),
        "--project",
        options.projectDir,
        "--agent-dir",
        agentDir,
        "--state-dir",
        stateDir,
        "--refresh-ms",
        String(options.refreshMs),
        "--read-bytes",
        String(options.readBytes),
      ]
      const sessionName = `omo-agents-${process.pid}-${Date.now()}`
      runTmuxPlan(
        buildTmuxPlan({
          projectDir: options.projectDir,
          sessionName,
          omoArgs: options.omoArgs,
          viewerCommand,
          insideTmux: (process.env.TMUX?.length ?? 0) > 0,
        }),
      )
      return
    }
    await runViewer({
      projectDir: options.projectDir,
      agentDir,
      stateDir,
      refreshMs: options.refreshMs,
      readBytes: options.readBytes,
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\nRun omo-agents --help for usage.\n`)
    process.exitCode = 2
  }
}

if (import.meta.main) await main()
