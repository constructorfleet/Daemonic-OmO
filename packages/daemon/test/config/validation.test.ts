import { afterEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { ConfigError } from "../../src/config"
import { captureError, cleanupTempHomes, load, tempHome } from "./helpers"

afterEach(async () => {
  await cleanupTempHomes()
})

function asConfigError(error: unknown): ConfigError {
  expect(error).toBeInstanceOf(ConfigError)
  if (!(error instanceof ConfigError)) throw new Error("expected ConfigError")
  expect(error.code).toBe("invalid_config")
  return error
}

const CASES: readonly {
  readonly name: string
  readonly jsonc: string
  readonly paths: readonly string[]
  readonly message: string
}[] = [
  {
    name: "port above the TCP range",
    jsonc: `{ "listen": { "port": 70000 } }`,
    paths: ["listen.port"],
    message: "listen.port",
  },
  {
    name: "port is not a number",
    jsonc: `{ "listen": { "port": "8787" } }`,
    paths: ["listen.port"],
    message: "must be an integer",
  },
  {
    name: "unknown key inside a section",
    jsonc: `{ "listen": { "hots": "127.0.0.1" } }`,
    paths: ["listen.hots"],
    message: "unknown key",
  },
  {
    name: "unknown top-level key",
    jsonc: `{ "nope": 1 }`,
    paths: ["nope"],
    message: "unknown key",
  },
  {
    name: "unknown key inside oidc",
    jsonc: `{ "oidc": { "issuer": "https://issuer.example.test", "clientId": "x", "clientSecretFile": "s", "clientSecret": "leak" } }`,
    paths: ["oidc.clientSecret"],
    message: "unknown key",
  },
  {
    name: "unsupported overlap policy",
    jsonc: `{ "defaults": { "overlap": "sometimes" } }`,
    paths: ["defaults.overlap"],
    message: "skip, queue, parallel",
  },
  {
    name: "unsupported misfire policy",
    jsonc: `{ "defaults": { "misfire": "retry" } }`,
    paths: ["defaults.misfire"],
    message: "skip, fire_once, fire_all",
  },
  {
    name: "default above its admin hard cap",
    jsonc: `{ "defaults": { "maxRunning": 33 } }`,
    paths: ["defaults.maxRunning"],
    message: "hardCaps.maxRunning",
  },
  {
    name: "default readBytes below the 64 KiB floor",
    jsonc: `{ "defaults": { "readBytes": 1024 } }`,
    paths: ["defaults.readBytes"],
    message: "65536",
  },
  {
    name: "oidc without a client secret file",
    jsonc: `{ "oidc": { "issuer": "https://issuer.example.test", "clientId": "omo-daemonic" } }`,
    paths: ["oidc.clientSecretFile"],
    message: "oidc.clientSecretFile",
  },
  {
    name: "adminGroup without groupsClaim",
    jsonc: `{ "oidc": { "issuer": "https://issuer.example.test", "clientId": "x", "clientSecretFile": "s", "adminGroup": "ops" } }`,
    paths: ["oidc.adminGroup"],
    message: "groupsClaim",
  },
  {
    name: "trustedHosts must be an array",
    jsonc: `{ "trustedHosts": "example.test" }`,
    paths: ["trustedHosts"],
    message: "array",
  },
  {
    name: "admin subject entries carry explicit paths",
    jsonc: `{ "oidc": { "issuer": "https://issuer.example.test", "clientId": "x", "clientSecretFile": "s", "adminSubjects": [{ "issuer": "not-a-url", "sub": "" }] } }`,
    paths: ["oidc.adminSubjects[0].issuer", "oidc.adminSubjects[0].sub"],
    message: "oidc.adminSubjects[0]",
  },
  {
    name: "publicUrl must be an absolute URL",
    jsonc: `{ "publicUrl": "/daemon" }`,
    paths: ["publicUrl"],
    message: "publicUrl",
  },
  {
    name: "limits must stay positive",
    jsonc: `{ "limits": { "machineMaxRunning": 0 } }`,
    paths: ["limits.machineMaxRunning"],
    message: "limits.machineMaxRunning",
  },
  {
    name: "observerMaxOpenDocs rejects zero",
    jsonc: `{ "limits": { "observerMaxOpenDocs": 0 } }`,
    paths: ["limits.observerMaxOpenDocs"],
    message: "limits.observerMaxOpenDocs",
  },
  {
    name: "observerImageCacheBytes rejects a negative size",
    jsonc: `{ "limits": { "observerImageCacheBytes": -1 } }`,
    paths: ["limits.observerImageCacheBytes"],
    message: "limits.observerImageCacheBytes",
  },
  {
    name: "omo.pluginRoot must be absolute",
    jsonc: `{ "omo": { "pluginRoot": "relative/plugin" } }`,
    paths: ["omo.pluginRoot"],
    message: "omo.pluginRoot",
  },
]

describe("loadConfig validation", () => {
  for (const scenario of CASES) {
    test(`${scenario.name} names the offending path`, async () => {
      const home = await tempHome()
      await home.writeConfig(scenario.jsonc)

      const error = asConfigError(await captureError(() => load(home.home)))

      expect(error.issues.map((issue) => issue.path)).toContain(scenario.paths[0] ?? "")
      for (const path of scenario.paths) {
        expect(error.issues.map((issue) => issue.path)).toContain(path)
      }
      expect(error.message).toContain(scenario.message)
      await expect(stat(join(home.home, "runs"))).rejects.toMatchObject({ code: "ENOENT" })
    })
  }

  test("malformed JSONC reports the file and location", async () => {
    const home = await tempHome()
    await home.writeConfig(`{\n  "listen": { "port": }\n}\n`)

    const error = asConfigError(await captureError(() => load(home.home)))

    expect(error.issues.length).toBeGreaterThan(0)
    expect(error.issues[0]?.path.startsWith("config.jsonc:2:")).toBe(true)
    expect(error.message).toContain("config.jsonc")
  })

  test("a comments-only config file loads the defaults", async () => {
    const home = await tempHome()
    await home.writeConfig(`// everything is the default\n`)

    const loaded = await load(home.home)

    expect(loaded.config.listen).toEqual({ host: "127.0.0.1", port: 8787 })
  })
})
