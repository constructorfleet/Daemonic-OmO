import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { dagLibraryDirectories, loadDagLibrary, readTaskStoreIndex } from "../src/index.js"

const roots: string[] = []
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "omo-store-index-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("readTaskStoreIndex", () => {
  test("#given a version one rpc index #when read #then it returns indexed store paths", () => {
    const agent = temp()
    const rpc = join(agent, "rpc")
    mkdirSync(rpc)
    writeFileSync(join(rpc, "task-stores.json"), readFileSync(join(import.meta.dir, "fixtures", "task-stores.json")))

    expect(readTaskStoreIndex(agent)).toEqual({
      stores: {
        "/tmp/project-fixture/senpi-task": {
          firstSeen: "2026-11-25T08:00:00.000Z",
          lastSeen: "2026-11-25T08:01:00.000Z",
        },
      },
      invalidRecords: 0,
    })
  })
})

describe("dagLibraryDirectories", () => {
  test("#given configured and fallback libraries #when resolved #then directories follow lookup precedence", () => {
    const root = temp()
    const home = temp()
    const customA = join(root, "custom-a")
    const customB = join(root, "custom-b")

    expect(dagLibraryDirectories({
      env: { OMO_DAG_LIBRARY: [customA, customB].join(delimiter), HOME: home },
      cwd: root,
      home,
    })).toEqual([customA, customB, join(root, ".omo", "dags"), join(home, ".omo", "dags")])
  })
})

describe("loadDagLibrary", () => {
  test("#given duplicate names across library directories #when loaded #then the first definition wins", () => {
    const root = temp()
    const home = temp()
    const configured = join(root, "configured")
    const project = join(root, ".omo", "dags")
    const user = join(home, ".omo", "dags")
    mkdirSync(configured, { recursive: true })
    mkdirSync(project, { recursive: true })
    mkdirSync(user, { recursive: true })
    writeFileSync(join(configured, "audit.json"), JSON.stringify({ key: "configured", name: "Configured", nodes: [] }))
    writeFileSync(join(project, "audit.json"), JSON.stringify({ key: "project", name: "Project", nodes: [] }))
    writeFileSync(join(user, "audit.json"), JSON.stringify({ key: "user", name: "User", nodes: [] }))

    expect(loadDagLibrary({
      env: { OMO_DAG_LIBRARY: configured, HOME: home },
      cwd: root,
      home,
    }).definitions).toEqual([{ key: "configured", name: "Configured", nodes: [] }])
  })
})
