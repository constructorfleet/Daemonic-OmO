#!/usr/bin/env bun

import { resolve } from "node:path"

import { runViewer } from "./viewer.js"
import { resolveAgentDir, resolveTaskStateDir } from "./storage.js"

const HELP = `OmO Agent Viewer

Usage: omo-agents [--project <path>] [--state-dir <path>] [--refresh-ms <ms>]

Options:
  --project <path>    Project whose delegated tasks to watch (default: current directory)
  --state-dir <path>  Explicit Senpi task state directory
  --refresh-ms <ms>   Read interval from 250 to 10000 ms (default: 1000)
  -h, --help          Show this help

Keys: ↑/↓ select, Enter follow, Esc main, j/k scroll, g latest, p pause, r refresh, q quit
`

export interface CliOptions {
  readonly projectDir: string
  readonly stateDir?: string
  readonly refreshMs: number
  readonly help: boolean
}

export function parseArgs(args: readonly string[], cwd = process.cwd()): CliOptions {
  let projectDir = cwd
  let stateDir: string | undefined
  let refreshMs = 1_000
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "-h" || arg === "--help") help = true
    else if (arg === "--project") projectDir = requiredValue(args, ++index, arg)
    else if (arg === "--state-dir") stateDir = requiredValue(args, ++index, arg)
    else if (arg === "--refresh-ms") {
      const value = Number(requiredValue(args, ++index, arg))
      if (!Number.isInteger(value) || value < 250 || value > 10_000) {
        throw new Error("--refresh-ms must be an integer from 250 to 10000")
      }
      refreshMs = value
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  return {
    projectDir: resolve(cwd, projectDir),
    ...(stateDir === undefined ? {} : { stateDir: resolve(cwd, stateDir) }),
    refreshMs,
    help,
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
    const agentDir = resolveAgentDir()
    const stateDir = resolveTaskStateDir(options.projectDir, { stateDir: options.stateDir, agentDir })
    await runViewer({ projectDir: options.projectDir, agentDir, stateDir, refreshMs: options.refreshMs })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\nRun omo-agents --help for usage.\n`)
    process.exitCode = 2
  }
}

if (import.meta.main) await main()
