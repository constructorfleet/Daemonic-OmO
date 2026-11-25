import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"

import { validateConfig } from "../../src/config/validate"
import { ulid } from "../../src/core/ids"
import type { User } from "../../src/core/types"
import { EventLedger } from "../../src/db/ledger"
import { migrate } from "../../src/db/migrations"
import { createRepositories } from "../../src/db/repos"
import { register, type OmoFeature } from "../../src/features/omo"
import { COMPAT_META_KEY, readCompatReport } from "../../src/omo/compat"
import { FakeClock, SeededRng } from "../support/fakes"
import { PARENT_ENV, STUB_OMO, stubInstall, type StubInstall } from "./support"

let install: StubInstall
let clock: FakeClock
let db: Database
let ledger: EventLedger
let user: User
let feature: OmoFeature | undefined

beforeEach(async () => {
  install = await stubInstall()
  clock = new FakeClock({ wallMs: Date.parse("2026-11-25T09:00:00.000Z") })
  db = new Database(":memory:", { strict: true })
  db.exec("PRAGMA foreign_keys = ON")
  migrate(db)
  ledger = new EventLedger(db)
  const now = new Date(clock.now()).toISOString()
  user = {
    id: ulid(new SeededRng(7), clock.now()),
    oidcIssuer: "https://issuer.test",
    oidcSub: "member-1",
    email: "member@example.test",
    name: "Member",
    role: "member",
    agentDir: install.agentDir,
    allowedRoots: [],
    settings: {},
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  }
  createRepositories(db, ledger).users.put(user)
})

afterEach(async () => {
  await feature?.stop()
  feature = undefined
  db.close()
  await install.dispose()
})

function start(pluginRoot = install.pluginRoot): OmoFeature {
  const config = validateConfig(
    { users: { bootstrapAdmin: { agentDir: install.agentDir } } },
    { home: join(install.root, "home"), homeDir: install.root, omo: { bin: STUB_OMO, pluginRoot } },
  )
  feature = register({ config, db, ledger, clock, fs: install.fs, env: PARENT_ENV })
  return feature
}

const compatEvents = () => ledger.readAfter(0, 100).filter((event) => event.type === "daemon.compat")

describe("omo feature", () => {
  test("start probes each agent dir once, stores the CompatReport in meta and emits daemon.compat to each user", async () => {
    const report = await start().start()
    expect(report.checks.every((check) => check.ok)).toBe(true)
    expect(feature?.compat()).toEqual(report)
    expect(readCompatReport(db)).toEqual(report)
    expect(db.query<{ key: string }, [string]>("SELECT key FROM meta WHERE key = ?").get(COMPAT_META_KEY)).toEqual({ key: COMPAT_META_KEY })
    expect(compatEvents().map((event) => [event.userId, event.entityKind, event.entityId, event.data])).toEqual([[user.id, "daemon", "compat", report]])
  })

  test("a plugin root whose SDK cannot load stores a degraded report naming sdk.load", async () => {
    const report = await start(join(install.root, "missing-plugin")).start()
    expect(report.checks.find((check) => check.name === "sdk.load")).toMatchObject({ ok: false, agentDir: install.agentDir })
    expect(readCompatReport(db)?.checks.find((check) => check.name === "sdk.load")?.ok).toBe(false)
  })

  test("an omo-ai version change seen by a gateway call re-runs the probe and emits a new daemon.compat", async () => {
    const started = start()
    await started.start()
    await install.setVersion("5.1.100")
    await install.touch("stub-omo-version", "omo 5.1.100 (engine: senpi stub)\n")

    const listed = await started.gatewayFor(install.agentDir).list()
    expect(listed.kind).toBe("ok")
    expect(compatEvents().map((event) => event.data.omoVersion)).toEqual(["5.1.79", "5.1.100"])
    expect(started.compat()?.omoVersion).toBe("5.1.100")
  })
})
