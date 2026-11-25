import { afterEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { ConfigError } from "../../src/config"
import { captureError, cleanupTempHomes, load, tempHome } from "./helpers"

afterEach(async () => {
  await cleanupTempHomes()
})

const OIDC = `"oidc": {
  "issuer": "https://issuer.example.test",
  "clientId": "omo-daemonic",
  "clientSecretFile": "secrets/oidc-client-secret"
}`

function asConfigError(error: unknown, code: ConfigError["code"], path: string): ConfigError {
  expect(error).toBeInstanceOf(ConfigError)
  if (!(error instanceof ConfigError)) throw new Error("expected ConfigError")
  expect(error.code).toBe(code)
  expect(error.path).toBe(path)
  return error
}

describe("exposure guards", () => {
  test("a wildcard bind without oidc is refused as unauthenticated", async () => {
    const home = await tempHome()
    await home.writeConfig(`{ "listen": { "host": "0.0.0.0" } }`)

    const error = asConfigError(
      await captureError(() => load(home.home)),
      "unauthenticated_exposure_refused",
      "listen.host",
    )

    expect(error.message).toContain("0.0.0.0")
    expect(error.message).toContain("oidc")
    await expect(stat(join(home.home, "runs"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(join(home.home, "secrets"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("an IPv6 wildcard bind without oidc is refused as unauthenticated", async () => {
    const home = await tempHome()
    await home.writeConfig(`{ "listen": { "host": "::" } }`)

    asConfigError(
      await captureError(() => load(home.home)),
      "unauthenticated_exposure_refused",
      "listen.host",
    )
  })

  test("a wildcard bind with oidc but an http publicUrl is refused as insecure", async () => {
    const home = await tempHome()
    await home.writeConfig(`{ "listen": { "host": "0.0.0.0" }, ${OIDC} }`)

    const error = asConfigError(
      await captureError(() => load(home.home)),
      "insecure_exposure_refused",
      "publicUrl",
    )

    expect(error.message).toContain("https")
  })

  test("a wildcard bind with oidc and an https publicUrl starts", async () => {
    const home = await tempHome()
    await home.writeConfig(
      `{ "listen": { "host": "0.0.0.0" }, "publicUrl": "https://agents.example.test", ${OIDC} }`,
    )

    const loaded = await load(home.home)

    expect(loaded.config.listen.host).toBe("0.0.0.0")
    expect(loaded.config.publicUrl).toBe("https://agents.example.test")
    expect(loaded.config.oidc?.issuer).toBe("https://issuer.example.test")
    expect(loaded.config.trustedHosts).toEqual([
      "agents.example.test",
      "127.0.0.1:8787",
      "127.0.0.1",
      "localhost:8787",
      "localhost",
    ])
  })

  test("the unauthenticated refusal wins over the insecure one", async () => {
    const home = await tempHome()
    await home.writeConfig(`{ "listen": { "host": "0.0.0.0" }, "publicUrl": "http://agents.example.test" }`)

    asConfigError(
      await captureError(() => load(home.home)),
      "unauthenticated_exposure_refused",
      "listen.host",
    )
  })

  test("loopback binds keep their plain http default", async () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const home = await tempHome()
      await home.writeConfig(`{ "listen": { "host": "${host}" } }`)

      const loaded = await load(home.home)

      expect(loaded.config.listen.host).toBe(host)
    }
  })
})
