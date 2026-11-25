import { existsSync, readdirSync, readFileSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"
import { homedir } from "node:os"

export type DagDefinition = {
  readonly key: string
  readonly name: string
  readonly nodes: readonly Readonly<Record<string, unknown>>[]
}
export type DagLibraryOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
  readonly home?: string
}
export type DagLibrarySnapshot = {
  readonly definitions: readonly DagDefinition[]
  readonly invalidDefinitions: number
}

export function dagLibraryDirectories(options: DagLibraryOptions = {}): readonly string[] {
  const env = options.env ?? process.env
  const home = options.home ?? env.HOME ?? homedir()
  const paths = [
    ...(env.OMO_DAG_LIBRARY ?? "").split(delimiter).filter((path) => path.length > 0),
    join(options.cwd ?? process.cwd(), ".omo", "dags"),
    join(home, ".omo", "dags"),
  ].map((path) => resolve(path))
  return [...new Set(paths)]
}

export function loadDagLibrary(options: DagLibraryOptions = {}): DagLibrarySnapshot {
  const definitions = new Map<string, DagDefinition>()
  let invalidDefinitions = 0
  for (const directory of dagLibraryDirectories(options)) {
    if (!existsSync(directory)) continue
    for (const filename of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
      const name = filename.slice(0, -5)
      if (!/^[A-Za-z0-9._-]+$/.test(name) || definitions.has(name)) continue
      try {
        const definition = decodeDefinition(JSON.parse(readFileSync(join(directory, filename), "utf8")))
        if (definition === undefined) invalidDefinitions += 1
        else definitions.set(name, definition)
      } catch {
        invalidDefinitions += 1
      }
    }
  }
  return { definitions: [...definitions.values()], invalidDefinitions }
}

function decodeDefinition(value: unknown): DagDefinition | undefined {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.name !== "string" ||
    !Array.isArray(value.nodes) || !value.nodes.every(isRecord)) return undefined
  return { key: value.key, name: value.name, nodes: value.nodes }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
