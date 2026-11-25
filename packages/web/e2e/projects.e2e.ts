import { execFile, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { finished } from "node:stream/promises"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { expect, test, type BrowserContext, type Page } from "@playwright/test"

const E2E_ADMIN_SUB = "e2e-admin"
const E2E_DIR = dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

type E2eServerInfo = {
  readonly url: string
  readonly home: string
  readonly issuer: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseServerInfo(line: string): E2eServerInfo {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || typeof value["url"] !== "string" || typeof value["home"] !== "string" || typeof value["issuer"] !== "string") {
    throw new TypeError("e2e server did not print a valid ready record")
  }
  return { url: value["url"], home: value["home"], issuer: value["issuer"] }
}

let serverInfo: E2eServerInfo | undefined
let serverProcess: ReturnType<typeof spawn> | undefined
let serverOutputClosed: Promise<void> | undefined

async function startE2eServer(): Promise<E2eServerInfo> {
  const projectRoot = resolve(E2E_DIR, "../../..")
  const script = resolve(E2E_DIR, "../../daemon/test/support/e2e-server.ts")
  const child = spawn(resolve(projectRoot, "scripts/bun"), [
    script,
    "--port", "0",
    "--staticDir", resolve(E2E_DIR, "../dist"),
    "--sub", E2E_ADMIN_SUB,
  ], {
    cwd: projectRoot,
    env: { ...process.env, GIT_MASTER: "1", OMO_DAEMONIC_E2E: "1" },
    stdio: ["ignore", "pipe", "ignore"],
  })
  serverProcess = child
  const stdout = child.stdout
  if (stdout === null) throw new Error("e2e server stdout was not piped")
  serverOutputClosed = finished(stdout)
  const lines = createInterface({ input: stdout })
  for await (const line of lines) return parseServerInfo(line)
  throw new Error(`e2e server exited before readiness with code ${child.exitCode}`)
}

async function signIn(page: Page, origin: string): Promise<void> {
  const streamResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/stream")
  await page.goto(`${origin}/login`)
  await page.getByRole("link", { name: "Continue with your identity provider" }).click()
  await page.waitForURL((url) => url.origin === origin && url.pathname === "/")
  await page.goto(`${origin}/projects`)
  await streamResponse
  await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible()
}

async function projectDetails(page: Page, origin: string, name: string): Promise<{ readonly id: string; readonly stateDir: string }> {
  const response = await page.request.get(`${origin}/api/v1/projects`)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body["items"])) throw new TypeError("project list response is invalid")
  const project = body["items"].find((item) => isRecord(item) && item["name"] === name)
  if (!isRecord(project) || typeof project["id"] !== "string" || typeof project["stateDir"] !== "string") {
    throw new TypeError("registered project details are missing")
  }
  return { id: project["id"], stateDir: project["stateDir"] }
}

async function startProjectRun(page: Page, origin: string, projectId: string): Promise<void> {
  const identityResponse = await page.request.get(`${origin}/api/v1/me`)
  const identity: unknown = await identityResponse.json()
  if (!isRecord(identity) || typeof identity["csrfToken"] !== "string") {
    throw new TypeError("browser identity response is missing its CSRF token")
  }
  const response = await page.request.post(`${origin}/api/v1/projects/${encodeURIComponent(projectId)}/runs`, {
    headers: {
      Origin: origin,
      "X-CSRF-Token": identity["csrfToken"],
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: { prompt: "Wait for the Todo 20 task stream fixture." },
  })
  expect(response.status()).toBe(201)
}

async function createGitProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "todo20-project-"))
  try {
    await execFileAsync("git", ["-C", cwd, "init", "--quiet"], {
      cwd: resolve(E2E_DIR, "../../.."),
      env: { ...process.env, GIT_MASTER: "1" },
    })
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }
  return cwd
}

async function closeServer(): Promise<void> {
  const child = serverProcess
  const outputClosed = serverOutputClosed
  serverProcess = undefined
  serverOutputClosed = undefined
  if (child === undefined || outputClosed === undefined) return
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await outputClosed
}

async function closeContexts(contexts: readonly (BrowserContext | undefined)[]): Promise<void> {
  for (const context of contexts) await context?.close()
}

test.beforeAll(async () => {
  serverInfo = await startE2eServer()
})

test.afterAll(async () => {
  await closeServer()
})

test("registration toggle keeps its width at 390 pixels", async ({ browser }) => {
  const server = serverInfo; if (server === undefined) throw new Error("e2e daemon did not start")
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  try { const page = await context.newPage()
    await signIn(page, server.url)
    const register = page.getByRole("button", { name: "Register project" })
    const registerWidth = await register.evaluate((button) => button.getBoundingClientRect().width); await register.click()
    const cancel = page.getByRole("button", { name: "Cancel registration" })
    const cancelWidth = await cancel.evaluate((button) => button.getBoundingClientRect().width)

    console.log(`Registration toggle widths at 390 x 844: ${registerWidth}px and ${cancelWidth}px`); expect(cancelWidth).toBe(registerWidth)
  } finally { await context.close() }
})

test("projects login, registration, settings, and stream recovery", async ({ browser }) => {
  const server = serverInfo
  if (server === undefined) throw new Error("e2e daemon did not start")
  const evidenceDir = resolve(E2E_DIR, "../../../.omo/evidence")
  const temporaryProjects: string[] = []
  let firstContext: BrowserContext | undefined
  let secondContext: BrowserContext | undefined

  try {
    const firstProject = await createGitProject()
    temporaryProjects.push(firstProject)
    const secondProject = await createGitProject()
    temporaryProjects.push(secondProject)
    firstContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    secondContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const firstPage = await firstContext.newPage()
    const secondPage = await secondContext.newPage()
    await firstPage.goto(`${server.url}/login`)
    await expect(firstPage.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible()
    const signInLink = firstPage.getByRole("link", { name: "Continue with your identity provider" })
    const lightScheme = await firstPage.evaluate(() => window.matchMedia("(prefers-color-scheme: light)").matches)
    await expect(signInLink).toHaveCSS("color", lightScheme ? "rgb(246, 248, 251)" : "rgb(11, 16, 32)")
    await firstPage.screenshot({ path: `${evidenceDir}/task-20-omo-daemonic-login-1440.png` })
    await firstPage.setViewportSize({ width: 390, height: 844 })
    await firstPage.screenshot({ path: `${evidenceDir}/task-20-omo-daemonic-login-390.png` })
    await firstPage.setViewportSize({ width: 1440, height: 900 })
    await Promise.all([signIn(firstPage, server.url), signIn(secondPage, server.url)])

    await firstPage.getByRole("button", { name: "Register project" }).first().click()
    await firstPage.getByLabel("Project directory").fill(firstProject)
    await firstPage.getByLabel("Project name").fill("project-one")
    await firstPage.getByRole("button", { name: "Register project" }).last().click()
    await expect(firstPage.getByRole("button", { name: "Edit settings for project-one" })).toBeVisible()
    await expect(
      secondPage.getByRole("button", { name: "Edit settings for project-one" }),
    ).toBeVisible({ timeout: 2_000 })

    const registered = await projectDetails(firstPage, server.url, "project-one")
    await startProjectRun(firstPage, server.url, registered.id)
    const taskPath = relative(join(server.home, "agent"), join(registered.stateDir, "tasks", "qa-task-1.json"))
    const taskRecord = JSON.stringify({
      task_id: "qa-task-1",
      parent_session_id: "qa-root-session",
      root_session_id: "qa-root-session",
      status: "running",
      created_at: "2026-11-25T08:00:00.000Z",
      name: "Live task fixture",
    })
    const appended = await firstPage.request.post(`${server.url}/__test/fixtures/append`, {
      data: { path: taskPath, line: taskRecord },
    })
    expect(appended.status()).toBe(204)
    const advanced = await firstPage.request.post(`${server.url}/__test/clock/advance`, { data: { ms: 60_000 } })
    expect(advanced.status()).toBe(200)
    await expect(secondPage.locator('[data-testid="task-row"][data-task-id="qa-task-1"]'))
      .toBeVisible({ timeout: 2_000 })
    await expect(secondPage.locator(`[data-testid="project-task-counts"][data-project-id="${registered.id}"]`))
      .toContainText("1 running")
    await expect(secondPage.locator(`[data-testid="project-running-runs"][data-project-id="${registered.id}"]`))
      .toContainText("1")

    const recoveredStream = secondPage.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/v1/stream", { timeout: 10_000 })
    const closed = await fetch(`${server.url}/__test/stream/close`, { method: "POST" })
    expect(closed.status).toBe(204)
    await firstPage.getByRole("button", { name: "Register project" }).first().click()
    await firstPage.getByLabel("Project directory").fill(secondProject)
    await firstPage.getByLabel("Project name").fill("project-two")
    await firstPage.getByRole("button", { name: "Register project" }).last().click()
    await recoveredStream
    await expect(
      secondPage.getByRole("button", { name: "Edit settings for project-two" }),
    ).toBeVisible({ timeout: 5_000 })

    await firstPage.screenshot({ path: `${evidenceDir}/task-20-omo-daemonic-projects-list-1440.png` })
    await firstPage.getByRole("button", { name: "Edit settings for project-one" }).click()
    await firstPage.getByRole("spinbutton", { name: "Maximum parallel runs" }).fill("3")
    await firstPage.getByRole("button", { name: "Save settings" }).click()
    await expect(firstPage.getByText("Settings saved")).toBeVisible()
    const fullAccess = firstPage.getByLabel("Allow full-access loop checks")
    const fullAccessDialog = firstPage.getByRole("dialog", { name: "Allow loop checks" })
    const confirmFullAccess = firstPage.getByRole("button", { name: "Confirm full access" })
    await fullAccess.click()
    await expect(fullAccessDialog).toBeVisible()
    const confirmWasFocused = await confirmFullAccess.evaluate((button) => button === document.activeElement)
    await firstPage.keyboard.press("Enter")
    await expect(fullAccessDialog).toBeVisible(); await expect(fullAccess).not.toBeChecked()
    expect(confirmWasFocused).toBe(false)
    await firstPage.keyboard.press("Shift+Tab")
    await firstPage.keyboard.press("Tab")
    await expect(confirmFullAccess).toBeFocused(); await firstPage.keyboard.press("Enter")
    await expect(fullAccessDialog).toBeHidden(); await expect(fullAccess).toBeChecked()
    await fullAccess.uncheck()
    await fullAccess.click()
    await expect(fullAccessDialog).toBeVisible()
    await firstPage.keyboard.press("Escape")
    await expect(fullAccessDialog).toBeHidden()
    await expect(fullAccess).not.toBeChecked()
    await expect(fullAccess).toBeFocused()
    await fullAccess.click()
    await expect(fullAccessDialog).toBeVisible()
    await confirmFullAccess.click()
    await firstPage.getByRole("button", { name: "Save settings" }).click()
    await expect(firstPage.getByText("Settings saved")).toBeVisible()
    await firstPage.screenshot({ path: `${evidenceDir}/task-20-omo-daemonic-project-settings-1440.png` })

    await secondPage.getByRole("button", { name: "Edit settings for project-one" }).click()
    await expect(secondPage.getByRole("spinbutton", { name: "Maximum parallel runs" })).toHaveValue("3", { timeout: 2_000 })

    await firstPage.getByRole("button", { name: "Back to projects" }).click()
    await firstPage.setViewportSize({ width: 390, height: 844 })
    await firstPage.screenshot({ path: `${evidenceDir}/task-20-omo-daemonic-projects-list-390.png` })
    await firstPage.getByRole("button", { name: "Edit settings for project-one" }).click()
    await expect(firstPage.getByRole("heading", { name: "Project settings" })).toBeVisible()
    await expect(firstPage.getByRole("dialog")).toBeHidden()
    await firstPage.screenshot({ path: `${evidenceDir}/task-20-omo-daemonic-project-settings-390.png` })

    await firstPage.getByRole("button", { name: "Account" }).click()
    await firstPage.getByRole("menuitem", { name: "Sign out" }).click()
    await expect(firstPage).toHaveURL(`${server.url}/login`)
    await expect(firstPage.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible()
  } finally {
    await closeContexts([firstContext, secondContext])
    for (const directory of temporaryProjects) await rm(directory, { recursive: true, force: true })
  }
})
