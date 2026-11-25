import { afterEach, describe, expect, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureHome, ensureSecrets, redactSecrets } from "../../src/config"
import { SeededRng } from "../support/fakes"
import { captureError, cleanupTempHomes, load, modeOf, tempHome } from "./helpers"

afterEach(async () => {
  await cleanupTempHomes()
})

const HEX_256 = /^[0-9a-f]{64}$/

describe("secrets generation", () => {
  test("first start generates a 0600 break-glass token and session key", async () => {
    const home = await tempHome()

    const loaded = await load(home.home)

    expect(loaded.secrets.breakglassToken).toMatch(HEX_256)
    expect(loaded.secrets.sessionKey).toMatch(HEX_256)
    expect(loaded.secrets.breakglassToken).not.toBe(loaded.secrets.sessionKey)
    expect(await modeOf(join(loaded.home.secretsDir, "breakglass.token"))).toBe(0o600)
    expect(await modeOf(join(loaded.home.secretsDir, "session.key"))).toBe(0o600)
    expect(await modeOf(loaded.home.secretsDir)).toBe(0o700)
    expect(await readFile(join(loaded.home.secretsDir, "breakglass.token"), "utf8")).toContain(
      loaded.secrets.breakglassToken,
    )
  })

  test("later starts reuse the persisted secrets", async () => {
    const home = await tempHome()

    const first = await load(home.home)
    const second = await load(home.home)

    expect(second.secrets).toEqual(first.secrets)
  })

  test("secrets come from the injected Rng, so a seed is reproducible", async () => {
    const firstHome = await tempHome()
    const first = await load(firstHome.home)
    const secondHome = await tempHome()
    const second = await load(secondHome.home, { rng: new SeededRng(7) })
    const thirdHome = await tempHome()
    const third = await load(thirdHome.home, { rng: new SeededRng(8) })

    expect(second.secrets).toEqual(first.secrets)
    expect(third.secrets.breakglassToken).not.toBe(first.secrets.breakglassToken)
  })

  test("a pre-existing loose token file is kept and tightened to 0600", async () => {
    const home = await tempHome()
    const layout = await ensureHome(home.home)
    const tokenPath = join(layout.secretsDir, "breakglass.token")
    await writeFile(tokenPath, "pre-existing-token\n")
    await chmod(tokenPath, 0o644)

    const secrets = await ensureSecrets(layout, new SeededRng(7))

    expect(secrets.breakglassToken).toBe("pre-existing-token")
    expect(await modeOf(tokenPath)).toBe(0o600)
    expect(await readFile(tokenPath, "utf8")).toBe("pre-existing-token\n")
  })

  test("a blank secret file is regenerated instead of starting with no token", async () => {
    const home = await tempHome()
    const layout = await ensureHome(home.home)
    await writeFile(join(layout.secretsDir, "breakglass.token"), "")

    const secrets = await ensureSecrets(layout, new SeededRng(7))

    expect(secrets.breakglassToken).toMatch(HEX_256)
  })
})

describe("secret hygiene", () => {
  test("redacted output never contains the secret values", async () => {
    const home = await tempHome()
    await home.writeConfig(`{
      "oidc": {
        "issuer": "https://issuer.example.test",
        "clientId": "omo-daemonic",
        "clientSecretFile": "secrets/oidc-client-secret"
      }
    }`)
    const loaded = await load(home.home)

    const redacted = redactSecrets(loaded)
    const printed = JSON.stringify(redacted)

    expect(redacted.secrets.breakglassToken).toBe("[redacted]")
    expect(redacted.secrets.sessionKey).toBe("[redacted]")
    expect(printed).not.toContain(loaded.secrets.breakglassToken)
    expect(printed).not.toContain(loaded.secrets.sessionKey)
    expect(loaded.secrets.breakglassToken).toMatch(HEX_256)
  })

  test("loading never writes secrets into config.jsonc", async () => {
    const home = await tempHome()
    await home.writeConfig(`{ "publicUrl": "http://127.0.0.1:8787" }`)

    const loaded = await load(home.home)
    const configText = await readFile(join(home.home, "config.jsonc"), "utf8")

    expect(configText).not.toContain(loaded.secrets.breakglassToken)
    expect(configText).not.toContain(loaded.secrets.sessionKey)
  })

  test("a failure before secrets exist leaves no secret files behind", async () => {
    const home = await tempHome()
    await home.writeConfig(`{ "listen": { "host": "0.0.0.0" } }`)

    const error = await captureError(() => load(home.home))

    expect(error).not.toBeNull()
    await expect(
      readFile(join(home.home, "secrets", "breakglass.token"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })
})
