import { expect, test, type BrowserContext } from "@playwright/test"
import { readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  addTask,
  advanceClock,
  appendFixture,
  appendLines,
  captureSessionsMatrix,
  createSessionFixtures,
  fixtureAgentPath,
  removeFixture,
  saveStaticPageForDetection,
  saveTuiParityFixture,
  signIn,
  startParityServer,
} from "./session-parity-support"
import type { ParityServer } from "./session-parity-support"

const E2E_DIR = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = resolve(E2E_DIR, "../../../.omo/evidence")
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAE0lEQVR4nGP4z8DwHxkzoPH/AwAHKQ/xs/M1WgAAAABJRU5ErkJggg=="

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

let server: ParityServer
let stopServer: (() => Promise<void>) | undefined
const projects: string[] = []

test.beforeAll(async () => {
  const started = await startParityServer()
  server = started.server
  stopServer = started.stop
})

test.afterAll(async () => {
  await stopServer?.()
  for (const cwd of projects.splice(0)) await rm(cwd, { recursive: true, force: true })
})

test("sessions parity shows task, todo, transcript, image, paging and keyboard state", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const page = await context.newPage()
    await signIn(page, server.url)
    const { project, sessionPath } = await createSessionFixtures(page, server)
    projects.push(project.cwd)
    for (const [index, text] of Array.from({ length: 55 }, (_, index) => [index, `Older turn ${index + 1}`] as const)) {
      await appendFixture(server, sessionPath, JSON.stringify({
        type: "message",
        id: `older-${index + 1}`,
        message: { role: "assistant", content: [{ type: "text", text }] },
      }))
    }
    await appendLines(server, sessionPath, join(E2E_DIR, "fixtures/root-session-entries.jsonl"))
    const running = await readFile(join(E2E_DIR, "fixtures/task-running.json"), "utf8")
    const taskValue: unknown = JSON.parse(running)
    if (!isRecord(taskValue)) throw new TypeError("Recorded task fixture is invalid")
    const completed = JSON.stringify({
      ...taskValue,
      task_id: "qa-completed",
      status: "completed",
      name: "Completed parity task",
      child_session_id: undefined,
    })
    const paused = JSON.stringify({
      ...taskValue,
      task_id: "qa-paused",
      status: "paused",
      name: "Stopped parity task",
      child_session_id: undefined,
    })
    await addTask({ server, project, taskId: "qa-completed", record: completed })
    await addTask({ server, project, taskId: "qa-paused", record: paused })
    const childSessionPath = fixtureAgentPath(
      server,
      join(project.stateDir, "children", "qa-task-1", "sessions", "qa-task-1", "2026-11-25T08-01-00-000Z_child.jsonl"),
    )
    await appendLines(server, childSessionPath, join(E2E_DIR, "fixtures/child-session.jsonl"))
    await appendLines(server,
      fixtureAgentPath(server, join(project.stateDir, "logs", "qa-task-1.jsonl")),
      join(E2E_DIR, "fixtures/child-events.jsonl"),
    )

    await page.goto(`${server.url}/sessions`)
    await expect(page.getByRole("button", { name: /Main qa-root-sess/ })).toBeVisible()
    await expect(page.getByText("Completed parity task")).toBeVisible()
    await expect(page.getByText("Stopped parity task")).toBeVisible()
    await expect(page.locator(".sessions-tree__main .sessions-tree__meta")).toContainText("completed")
    await expect(page.locator(".sessions-tree__main .sessions-tree__meta")).toContainText("paused")
    const runningTask = JSON.stringify(taskValue)
    await addTask({ server, project, taskId: "qa-task-1", record: runningTask })
    await advanceClock(page, server, 1_000)
    await expect(page.locator('[data-testid="task-row"][data-task-id="qa-task-1"]')).toBeVisible({ timeout: 2_000 })
    await expect(page.locator(".sessions-tree__main .sessions-tree__meta")).toContainText("running")
    await saveTuiParityFixture(server, project)

    await page.getByTestId("sessions-page").focus()
    const mainSessionRow = page.getByRole("button", { name: /Main qa-root-sess/ })
    await mainSessionRow.focus()
    await page.keyboard.press("ArrowDown")
    await expect(page.locator('[data-testid="task-row"][data-task-id="qa-completed"]')).toHaveAttribute("data-selected", "true")
    await page.keyboard.press("ArrowUp")
    await expect(mainSessionRow).toHaveAttribute("data-selected", "true")
    await page.keyboard.press("Enter")
    await expect(page.locator(".transcript-line--assistant").filter({ hasText: "The fixture is ready for transcript parity." })).toBeVisible()
    await page.keyboard.press("l")
    await expect(page.getByTestId("todo-pane")).toHaveCount(0)
    await page.keyboard.press("l")
    await expect(page.getByTestId("todo-pane")).toBeVisible()
    await page.keyboard.press("1")
    await expect(page.getByText("Completed parity task")).toHaveCount(0)
    await page.keyboard.press("1")
    await page.keyboard.press("3")
    await expect(page.getByText("Stopped parity task")).toHaveCount(0)
    await page.keyboard.press("3")
    await page.locator('[data-testid="task-row"][data-task-id="qa-task-1"]').click()
    await expect(page.getByText("Status running")).toBeVisible()
    await expect(page.getByText(/^Started /)).toBeVisible()
    await expect(page.getByText(/^Elapsed /)).toBeVisible()
    await expect(page.getByText("Category quick")).toBeVisible()
    await expect(page.getByText("Agent type task")).toBeVisible()
    await expect(page.getByText("Model test-model")).toBeVisible()
    await expect(page.getByText("Task ID qa-task-1")).toBeVisible()
    await expect(page.locator(".transcript-line--assistant").filter({ hasText: "Child task transcript fixture." })).toBeVisible()
    await expect(page.getByText("error: child process failed")).toBeVisible()
    await page.keyboard.press("2")
    await expect(page.locator('[data-testid="task-row"][data-task-id="qa-task-1"]')).toBeVisible()
    await page.keyboard.press("2")
    await page.keyboard.press("ArrowLeft")
    await expect(page.locator(".transcript-line--assistant").filter({ hasText: "The fixture is ready for transcript parity." })).toBeVisible()
    await page.keyboard.press("ArrowRight")
    await expect(page.locator(".transcript-line--assistant").filter({ hasText: "The fixture is ready for transcript parity." })).toBeVisible()

    await mainSessionRow.click()
    await expect(page.locator(".transcript-line--assistant").filter({ hasText: "The fixture is ready for transcript parity." })).toBeVisible()
    await expect(page.getByText("Found the session transcript fixture.")).toBeVisible()
    await expect(page.getByText("TODO 1/3")).toBeVisible()
    await expect(page.getByText("Verify 0/2")).toBeVisible()
    await expect(page.getByText(/Now.*Verify transcript details/)).toBeVisible()
    await expect(page.getByText(/Next.*Capture responsive screenshots/)).toBeVisible()
    await expect(page.getByRole("combobox", { name: "Read budget" })).toHaveValue("4194304")
    await page.locator('[data-testid="transcript-turn"][data-turn-id="turn-01"] button').click()
    await expect(page.locator(".transcript-line--thinking").filter({ hasText: "I will inspect the source and report the matching image." })).toBeVisible()
    await expect(page.locator(".transcript-turn__detail pre")).toContainText("CALL read")
    await expect(page.locator(".transcript-turn__detail pre")).toContainText("command: echo parity")
    await expect(page.locator(".transcript-turn__detail pre")).toContainText("path: src/parity.ts")
    await expect(page.getByText("IMAGE 4×2 image/png")).toBeVisible()
    await expect(page.getByText(PNG, { exact: true })).toHaveCount(0)
    await expect(page.getByText("TURN 49 / 50")).toBeVisible()
    await page.getByTestId("sessions-page").focus()
    await page.keyboard.press("4")
    await expect(page.getByText("Read the project context")).toHaveCount(0)
    await page.keyboard.press("4")
    await page.keyboard.press("Tab")
    await expect(page.locator('[data-pane="todo"]')).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.locator('[data-pane="tree"]')).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.locator('[data-pane="transcript"]')).toBeFocused()
    await page.keyboard.press("t")
    await expect(page.locator('[data-testid="transcript-turn"] button[aria-expanded="true"]')).toBeVisible()
    await page.keyboard.press("Escape")
    await page.keyboard.press("g")
    await expect(page.getByText("TURN 50 / 50")).toBeVisible()
    const workspaceScrollTop = () => page.evaluate(() => {
      const content = document.querySelector<HTMLElement>("main.workspace__content")
      return content !== null && getComputedStyle(content).overflowY !== "visible"
        ? content.scrollTop
        : document.scrollingElement?.scrollTop ?? 0
    })
    await expect.poll(workspaceScrollTop).toBeGreaterThan(0)
    const atLatest = await workspaceScrollTop()
    await page.keyboard.press("k")
    await expect.poll(workspaceScrollTop).toBeLessThan(atLatest)
    const scrollAfterUp = await workspaceScrollTop()
    await page.keyboard.press("j")
    await expect.poll(workspaceScrollTop).toBeGreaterThan(scrollAfterUp)
    await page.keyboard.press("p")
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible()
    await page.keyboard.press("p")
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible()
    await page.keyboard.press("r")
    await page.getByRole("button", { name: "Load older turns" }).click()
    await expect(page.locator(".transcript-line--assistant").filter({ hasText: /^assistant: Older turn 1$/ })).toBeVisible()

    await captureSessionsMatrix(page, EVIDENCE_DIR)
    await page.setViewportSize({ width: 320, height: 844 })
    const pageFits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    expect(pageFits).toBe(true)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: "dark" })
    await page.locator('[data-testid="transcript-turn"][data-turn-id="turn-01"] button').click()
    await expect(page.locator(".transcript-turn__detail")).toBeVisible()
    await expect(page.locator(".transcript-image img")).toBeVisible()
    await page.locator(".transcript-image").scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(EVIDENCE_DIR, "task-21-sessions-turn-image.png") })

    await appendFixture(server, sessionPath, JSON.stringify({
      type: "message",
      id: "live-turn",
      message: { role: "assistant", content: [{ type: "text", text: "A live turn appeared." }] },
    }))
    await advanceClock(page, server, 1_000)
    await expect(page.locator(".transcript-line--assistant").filter({ hasText: "A live turn appeared." })).toBeVisible({ timeout: 2_000 })
    await saveStaticPageForDetection(page, server)
  } finally {
    await context.close()
  }
})

test("sessions parity reports a removed session file without crashing", async ({ browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const page = await context.newPage()
    await signIn(page, server.url)
    const { project, sessionPath } = await createSessionFixtures(page, server)
    projects.push(project.cwd)
    await addTask({ server, project, taskId: "qa-root-task", record: JSON.stringify({
      task_id: "qa-root-task",
      parent_session_id: "qa-root-session",
      root_session_id: "qa-root-session",
      status: "running",
      created_at: "2026-11-25T08:00:00.000Z",
      name: "Root session anchor",
    }) })
    await appendFixture(server, sessionPath, JSON.stringify({
      type: "message",
      id: "before-remove",
      message: { role: "assistant", content: [{ type: "text", text: "Session is present." }] },
    }))
    await page.goto(`${server.url}/sessions`)
    await expect(page.locator(".transcript-pane .transcript-line--assistant").filter({ hasText: "Session is present." })).toBeVisible()
    await removeFixture(server, sessionPath)
    await advanceClock(page, server, 1_000)
    await expect(page.getByText("session file gone")).toBeVisible({ timeout: 2_000 })
  } finally {
    await context.close()
  }
})
