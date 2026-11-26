import { execFile, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { finished } from "node:stream/promises"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"

const E2E_DIR = dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

export type ParityServer = {
  readonly url: string
  readonly home: string
  readonly agentDir: string
}

export type RegisteredFixtureProject = {
  readonly cwd: string
  readonly id: string
  readonly stateDir: string
}

type TaskFixtureAppend = {
  readonly server: ParityServer
  readonly project: RegisteredFixtureProject
  readonly taskId: string
  readonly record: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseReady(line: string): ParityServer {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || typeof value["url"] !== "string" || typeof value["home"] !== "string") {
    throw new TypeError("Parity e2e server did not return its ready record")
  }
  return { url: value["url"], home: value["home"], agentDir: join(value["home"], "agent") }
}

export async function startParityServer(): Promise<{
  readonly server: ParityServer
  readonly stop: () => Promise<void>
}> {
  const projectRoot = resolve(E2E_DIR, "../../..")
  const child = spawn(resolve(projectRoot, "scripts/bun"), [
    resolve(E2E_DIR, "../../daemon/test/support/e2e-server.ts"),
    "--fixtures",
    resolve(E2E_DIR, "fixtures/agent"),
    "--port",
    "0",
    "--staticDir",
    resolve(E2E_DIR, "../dist"),
    "--sub",
    "e2e-admin",
  ], {
    cwd: projectRoot,
    env: { ...process.env, GIT_MASTER: "1", OMO_DAEMONIC_E2E: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (child.stdout === null) throw new TypeError("Parity e2e server stdout is unavailable")
  const outputClosed = finished(child.stdout)
  const lines = createInterface({ input: child.stdout })
  const first = await lines[Symbol.asyncIterator]().next()
  if (first.done) throw new Error(`Parity e2e server exited with code ${child.exitCode}`)
  const server = parseReady(first.value)
  return {
    server,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill("SIGTERM")
      await outputClosed
    },
  }
}

export async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/login`)
  await page.getByRole("link", { name: "Continue with your identity provider" }).click()
  await page.waitForURL((url) => url.origin === origin && url.pathname === "/")
}

export async function createFixtureProject(page: Page, origin: string): Promise<RegisteredFixtureProject> {
  const cwd = await mkdtemp(join(tmpdir(), "todo21-parity-"))
  try {
    await execFileAsync("sh", ["-c", "GIT_MASTER=1 git -C \"$1\" init --quiet", "git-init", cwd], {
      cwd: resolve(E2E_DIR, "../../.."),
      env: process.env,
    })
    const identityResponse = await page.request.get(`${origin}/api/v1/me`)
    const identity: unknown = await identityResponse.json()
    if (!isRecord(identity) || typeof identity["csrfToken"] !== "string") {
      throw new TypeError("Parity test identity is missing its CSRF token")
    }
    const response = await page.request.post(`${origin}/api/v1/projects`, {
      headers: {
        Origin: origin,
        "X-CSRF-Token": identity["csrfToken"],
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: { cwd },
    })
    const project: unknown = await response.json()
    if (!response.ok() || !isRecord(project) || typeof project["id"] !== "string" || typeof project["stateDir"] !== "string") {
      throw new TypeError("Parity test project registration failed")
    }
    return { cwd, id: project["id"], stateDir: project["stateDir"] }
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }
}

export async function appendFixture(server: ParityServer, path: string, line: string): Promise<void> {
  const response = await fetch(`${server.url}/__test/fixtures/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, line }),
  })
  if (response.status !== 204) throw new Error(`Fixture append failed with ${response.status}`)
}

export async function appendLines(server: ParityServer, path: string, source: string): Promise<void> {
  for (const line of (await readFile(source, "utf8")).split("\n").filter((entry) => entry.length > 0)) {
    await appendFixture(server, path, line)
  }
}

export async function addTask({ server, project, taskId, record }: TaskFixtureAppend): Promise<void> {
  const path = relative(server.agentDir, join(project.stateDir, "tasks", `${taskId}.json`))
  await appendFixture(server, path, record)
}

export async function advanceClock(page: Page, server: ParityServer, ms: number): Promise<void> {
  const response = await page.request.post(`${server.url}/__test/clock/advance`, { data: { ms } })
  if (response.status() !== 200) throw new Error(`Fake clock advance failed with ${response.status()}`)
}

export async function createSessionFixtures(
  page: Page,
  server: ParityServer,
): Promise<{ readonly project: RegisteredFixtureProject; readonly sessionPath: string }> {
  const project = await createFixtureProject(page, server.url)
  const sessionPath = relative(
    server.agentDir,
    join(server.agentDir, "sessions", "--parity-project--", "2026-11-25T08-00-00-000Z_qa-root-session.jsonl"),
  )
  await appendFixture(server, sessionPath, JSON.stringify({
    type: "session",
    version: 3,
    id: "qa-root-session",
    cwd: project.cwd,
  }))
  return { project, sessionPath }
}

export async function removeFixture(server: ParityServer, path: string): Promise<void> {
  const response = await fetch(`${server.url}/__test/fixtures/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  })
  if (response.status !== 204) throw new Error(`Fixture removal failed with ${response.status}`)
}

export function fixtureAgentPath(server: ParityServer, absolutePath: string): string {
  return relative(server.agentDir, absolutePath)
}

export async function saveTuiParityFixture(
  server: ParityServer,
  project: RegisteredFixtureProject,
): Promise<void> {
  const tempRoot = process.env["RUN_TMP"]
  if (tempRoot === undefined) throw new Error("RUN_TMP is required for the parity terminal capture")
  const root = join(tempRoot, "task-21-parity-fixture")
  const agentDir = join(root, "agent")
  const stateDir = join(root, "state")
  const projectDir = join(root, "project")
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await cp(join(server.agentDir, "sessions"), join(agentDir, "sessions"), { recursive: true })
  await cp(project.stateDir, stateDir, { recursive: true })
  await cp(project.cwd, projectDir, { recursive: true })
  await writeFile(join(root, "paths.json"), JSON.stringify({ agentDir, stateDir, projectDir }))
}

export async function saveStaticPageForDetection(page: Page, server: ParityServer): Promise<void> {
  const runTmp = process.env["RUN_TMP"]
  if (runTmp === undefined) throw new Error("RUN_TMP is required for rendered-page detection")
  const links = await page.locator('link[rel="stylesheet"]').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const href = element.getAttribute("href")
      return href === null ? [] : [href]
    }))
  const styles = await Promise.all(links.map(async (href) => {
    const response = await page.request.get(new URL(href, server.url).href)
    if (!response.ok()) throw new Error(`Stylesheet fetch failed with ${response.status()}`)
    return response.text()
  }))
  const imageData = await page.locator(".transcript-image img").evaluate(async (image) => {
    if (!(image instanceof HTMLImageElement)) throw new TypeError("Parity image preview is not an image")
    const response = await fetch(image.src)
    const blob = await response.blob()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")
    return `data:${blob.type};base64,${btoa(binary)}`
  })
  const html = (await page.content())
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b(?=[^>]*rel=["']stylesheet["'])[^>]*>/gi, "")
    .replace(/src="blob:[^"]+"/, `src="${imageData}"`)
    .replace("<head>", `<head><base href="${server.url}/"><style>${styles.join("\n")}</style>`)
  await writeFile(join(runTmp, "task21-sessions.html"), html)
}

export async function captureSessionsMatrix(page: Page, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ] as const) {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: scheme })
      await page.evaluate(() => {
        if (innerWidth >= 768) document.querySelector<HTMLElement>("main.workspace__content")?.scrollTo(0, 0)
        else document.scrollingElement?.scrollTo(0, 0)
      })
      const prefix = `task-21-sessions-${viewport.width}-${scheme}`
      await page.screenshot({ path: join(outDir, `${prefix}.png`) })
      if (viewport.width === 1440 && scheme === "light") {
        await page.screenshot({ path: join(outDir, "task-21-omo-daemonic-parity.png") })
      }
      await page.evaluate(() => {
        if (innerWidth >= 768) {
          const main = document.querySelector<HTMLElement>("main.workspace__content")
          if (main !== null) main.scrollTo(0, main.scrollHeight)
        } else document.scrollingElement?.scrollTo(0, document.scrollingElement.scrollHeight)
      })
      await page.screenshot({ path: join(outDir, `${prefix}-end.png`) })
    }
  }
}
