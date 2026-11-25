import { afterEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempHomes, load, modeOf, tempHome, TEST_HOME_DIR, TEST_OMO } from "./helpers"

afterEach(async () => {
  await cleanupTempHomes()
})

describe("loadConfig defaults", () => {
  test("a home with no config.jsonc resolves every plan default", async () => {
    const home = await tempHome()

    const loaded = await load(home.home)

    expect(loaded.config).toEqual({
      listen: { host: "127.0.0.1", port: 8787 },
      publicUrl: "http://127.0.0.1:8787",
      trustedHosts: ["127.0.0.1:8787", "127.0.0.1", "localhost:8787", "localhost"],
      trustedProxies: [],
      users: {
        defaultAgentDirRoot: `${TEST_HOME_DIR}/.omo-daemonic/agents`,
        allowSelfSignup: false,
        bootstrapAdmin: { agentDir: `${TEST_HOME_DIR}/.omo/agent` },
      },
      defaults: {
        maxRunning: 3,
        maxRunningPerProject: 1,
        loopMaxIterations: 10,
        loopMaxWallMs: 14_400_000,
        runTimeoutMs: 7_200_000,
        overlap: "skip",
        misfire: "fire_once",
        misfireGraceMs: 3_600_000,
        skipMisfireGraceMs: 60_000,
        onceMisfireGraceMs: 86_400_000,
        queueMax: 1,
        queueMinExpiryMs: 3_600_000,
        maxCatchup: 50,
        readBytes: 4_194_304,
      },
      hardCaps: {
        maxRunning: 32,
        maxRunningPerProject: 16,
        loopMaxIterations: 100,
        loopMaxWallMs: 172_800_000,
        runTimeoutMs: 86_400_000,
        readBytes: 67_108_864,
      },
      limits: {
        sessionTtlMs: 43_200_000,
        eventRetentionDays: 30,
        eventRetentionMinRows: 100_000,
        sseSubscriberMaxFrames: 5_000,
        sseSubscriberMaxBytes: 8_388_608,
        idempotencyTtlMs: 86_400_000,
        machineMaxRunning: 8,
        maxKeptWorktreesPerProject: 50,
        auditRetentionDays: 180,
        loopCheckTimeoutMs: 600_000,
        observerActivePollMs: 1_000,
        observerIdlePollMs: 10_000,
        observerMaxOpenDocs: 32,
        observerIdleEvictMs: 300_000,
        observerMaxTurns: 500,
        observerMaxEventLines: 10_000,
        observerMaxOlderTurns: 5_000,
        observerPageMaxTurns: 500,
        observerImageCacheBytes: 67_108_864,
        threadMessageMaxBytes: 1_048_576,
        threadQueueTtlMs: 86_400_000,
        omoCommandTimeoutMs: 120_000,
        omoCommandStderrTailChars: 500,
        schedulerMaxTickIntervalMs: 30_000,
        schedulerClockJumpMs: 5_000,
        scheduleHorizonMs: 157_680_000_000,
        schedulePreviewMaxCount: 1_000,
      },
      omo: { bin: TEST_OMO.bin, pluginRoot: TEST_OMO.pluginRoot },
    })
    expect(loaded.config.oidc).toBeUndefined()
    expect(loaded.home.home).toBe(home.home)
    expect(loaded.home.configFile).toBe(join(home.home, "config.jsonc"))
    expect(loaded.home.databaseFile).toBe(join(home.home, "daemon.sqlite"))
    expect(loaded.home.runsDir).toBe(join(home.home, "runs"))
    expect(loaded.home.secretsDir).toBe(join(home.home, "secrets"))
    expect(loaded.home.logsDir).toBe(join(home.home, "logs"))
  })

  test("a missing config file is not created by loading", async () => {
    const home = await tempHome()

    await load(home.home)

    await expect(stat(join(home.home, "config.jsonc"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("config.jsonc overrides individual fields and keeps the rest of the defaults", async () => {
    const home = await tempHome()
    await home.writeConfig(`{
      // JSONC comments and trailing commas are allowed.
      "listen": { "host": "127.0.0.1", "port": 9123 },
      "users": { "allowSelfSignup": true },
      "defaults": { "maxRunning": 5, "overlap": "queue" },
      "limits": { "schedulePreviewMaxCount": 24 },
      "trustedProxies": ["10.0.0.2"],
    }`)

    const loaded = await load(home.home)

    expect(loaded.config.listen.port).toBe(9123)
    expect(loaded.config.trustedHosts).toEqual([
      "127.0.0.1:8787",
      "127.0.0.1",
      "127.0.0.1:9123",
      "localhost:9123",
      "localhost",
    ])
    expect(loaded.config.users.allowSelfSignup).toBe(true)
    expect(loaded.config.users.defaultAgentDirRoot).toBe(`${TEST_HOME_DIR}/.omo-daemonic/agents`)
    expect(loaded.config.defaults.maxRunning).toBe(5)
    expect(loaded.config.defaults.overlap).toBe("queue")
    expect(loaded.config.defaults.misfire).toBe("fire_once")
    expect(loaded.config.limits.schedulePreviewMaxCount).toBe(24)
    expect(loaded.config.trustedProxies).toEqual(["10.0.0.2"])
    expect(loaded.config.hardCaps.maxRunning).toBe(32)
  })

  test("paths expand ~ from the OS home and resolve relative paths against the daemon home", async () => {
    const home = await tempHome()
    await home.writeConfig(`{
      "oidc": {
        "issuer": "https://issuer.example.test",
        "clientId": "omo-daemonic",
        "clientSecretFile": "secrets/oidc-client-secret"
      },
      "users": {
        "defaultAgentDirRoot": "~/agents",
        "bootstrapAdmin": { "agentDir": "~/omo-agent" }
      }
    }`)

    const loaded = await load(home.home)

    expect(loaded.config.oidc?.clientSecretFile).toBe(join(home.home, "secrets/oidc-client-secret"))
    expect(loaded.config.oidc?.scopes).toEqual(["openid", "profile", "email"])
    expect(loaded.config.oidc?.redirectPath).toBe("/auth/callback")
    expect(loaded.config.oidc?.adminSubjects).toEqual([])
    expect(loaded.config.users.defaultAgentDirRoot).toBe(`${TEST_HOME_DIR}/agents`)
    expect(loaded.config.users.bootstrapAdmin.agentDir).toBe(`${TEST_HOME_DIR}/omo-agent`)
  })

  test("observer limits parse from config.jsonc", async () => {
    const home = await tempHome()
    await home.writeConfig(`{
      "limits": {
        "observerActivePollMs": 250,
        "observerIdlePollMs": 2000,
        "observerMaxOpenDocs": 4,
        "observerIdleEvictMs": 9000,
        "observerMaxTurns": 50,
        "observerMaxEventLines": 100,
        "observerMaxOlderTurns": 25,
        "observerPageMaxTurns": 20,
        "observerImageCacheBytes": 1048576
      }
    }`)

    const loaded = await load(home.home)

    expect(loaded.config.limits).toMatchObject({
      observerActivePollMs: 250,
      observerIdlePollMs: 2_000,
      observerMaxOpenDocs: 4,
      observerIdleEvictMs: 9_000,
      observerMaxTurns: 50,
      observerMaxEventLines: 100,
      observerMaxOlderTurns: 25,
      observerPageMaxTurns: 20,
      observerImageCacheBytes: 1_048_576,
    })
    expect(loaded.config.limits.sessionTtlMs).toBe(43_200_000)
  })

  test("limits overrides the thread message cap and queued expiry", async () => {
    const home = await tempHome()
    await home.writeConfig(`{ "limits": { "threadMessageMaxBytes": 2048, "threadQueueTtlMs": 60000 } }`)

    const loaded = await load(home.home)

    expect(loaded.config.limits.threadMessageMaxBytes).toBe(2048)
    expect(loaded.config.limits.threadQueueTtlMs).toBe(60_000)
    expect(loaded.config.limits.sessionTtlMs).toBe(43_200_000)
  })

  test("the thread message cap accepts one byte through the upstream 1 MiB ceiling", async () => {
    const atCeiling = await tempHome()
    await atCeiling.writeConfig(`{ "limits": { "threadMessageMaxBytes": 1048576 } }`)
    expect((await load(atCeiling.home)).config.limits.threadMessageMaxBytes).toBe(1_048_576)

    const atFloor = await tempHome()
    await atFloor.writeConfig(`{ "limits": { "threadMessageMaxBytes": 1 } }`)
    expect((await load(atFloor.home)).config.limits.threadMessageMaxBytes).toBe(1)
  })

  test("omo command bounds parse from config.jsonc", async () => {
    const home = await tempHome()
    await home.writeConfig(`{
      "limits": { "omoCommandTimeoutMs": 45000, "omoCommandStderrTailChars": 1200 }
    }`)

    const loaded = await load(home.home)

    expect(loaded.config.limits.omoCommandTimeoutMs).toBe(45_000)
    expect(loaded.config.limits.omoCommandStderrTailChars).toBe(1_200)
    expect(loaded.config.limits.sessionTtlMs).toBe(43_200_000)
  })

  test("the home layout is private: 0700 directories, no database file yet", async () => {
    const home = await tempHome()

    const loaded = await load(home.home)

    expect(await modeOf(loaded.home.home)).toBe(0o700)
    expect(await modeOf(loaded.home.runsDir)).toBe(0o700)
    expect(await modeOf(loaded.home.secretsDir)).toBe(0o700)
    expect(await modeOf(loaded.home.logsDir)).toBe(0o700)
    await expect(stat(loaded.home.databaseFile)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
