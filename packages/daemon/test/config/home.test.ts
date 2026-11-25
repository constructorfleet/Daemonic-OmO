import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { ensureHome, resolveHome } from "../../src/config"
import { cleanupTempHomes, load, modeOf, tempHome, TEST_HOME_DIR } from "./helpers"

afterEach(async () => {
  await cleanupTempHomes()
})

describe("resolveHome", () => {
  test("OMO_DAEMONIC_HOME wins when set", () => {
    expect(resolveHome({ OMO_DAEMONIC_HOME: "/srv/omo-daemonic" }, TEST_HOME_DIR)).toBe(
      "/srv/omo-daemonic",
    )
  })

  test("an empty OMO_DAEMONIC_HOME falls back to ~/.omo-daemonic", () => {
    expect(resolveHome({ OMO_DAEMONIC_HOME: "" }, TEST_HOME_DIR)).toBe(
      `${TEST_HOME_DIR}/.omo-daemonic`,
    )
    expect(resolveHome({}, TEST_HOME_DIR)).toBe(`${TEST_HOME_DIR}/.omo-daemonic`)
  })
})

describe("ensureHome", () => {
  test("creates a 0700 home with runs, secrets and logs", async () => {
    const parent = await tempHome()
    const home = join(parent.home, "nested", "daemon-home")

    const layout = await ensureHome(home)

    expect(layout.home).toBe(home)
    expect(await modeOf(layout.home)).toBe(0o700)
    expect(await modeOf(layout.runsDir)).toBe(0o700)
    expect(await modeOf(layout.secretsDir)).toBe(0o700)
    expect(await modeOf(layout.logsDir)).toBe(0o700)
    await expect(stat(layout.databaseFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("tightens a pre-existing loose home and private directories", async () => {
    const parent = await tempHome()
    const home = join(parent.home, "loose-home")
    await mkdir(join(home, "secrets"), { recursive: true })
    await chmod(home, 0o755)
    await chmod(join(home, "secrets"), 0o755)

    const layout = await ensureHome(home)

    expect(await modeOf(layout.home)).toBe(0o700)
    expect(await modeOf(layout.secretsDir)).toBe(0o700)
  })

  test("is idempotent", async () => {
    const parent = await tempHome()
    const home = join(parent.home, "daemon-home")

    const first = await ensureHome(home)
    const second = await ensureHome(home)

    expect(second).toEqual(first)
    expect(await modeOf(second.runsDir)).toBe(0o700)
  })
})

describe("loadConfig home resolution", () => {
  test("honours OMO_DAEMONIC_HOME when no home option is given", async () => {
    const home = await tempHome()

    const loaded = await load(home.home, { home: undefined, env: { OMO_DAEMONIC_HOME: home.home } })

    expect(loaded.home.home).toBe(home.home)
    expect(await modeOf(home.home)).toBe(0o700)
  })

  test("falls back to ~/.omo-daemonic under the injected OS home", async () => {
    const osHome = await tempHome()
    const expected = join(osHome.home, ".omo-daemonic")

    const loaded = await load(expected, { home: undefined, env: {}, homeDir: osHome.home })

    expect(loaded.home.home).toBe(expected)
    expect(await modeOf(expected)).toBe(0o700)
  })
})
