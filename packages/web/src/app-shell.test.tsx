import { cleanup, fireEvent, render } from "@testing-library/react"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { AppShell } from "./components/app-shell"

GlobalRegistrator.register()

afterEach(cleanup)
afterAll(async () => GlobalRegistrator.unregister())

describe("application shell", () => {
  it("shows every primary destination and its active page", () => {
    const view = render(
      <AppShell activePath="/projects" pageTitle="Projects">
        <p>Route content</p>
      </AppShell>,
    )

    expect(view.getByRole("navigation", { name: "Primary" })).toBeTruthy()
    expect(view.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/projects")
    expect(view.getByRole("link", { name: "Sessions" }).getAttribute("href")).toBe("/sessions")
    expect(view.getByRole("link", { name: "Graph" }).getAttribute("href")).toBe("/graph")
    expect(view.getByRole("link", { name: "Schedules" }).getAttribute("href")).toBe("/schedules")
    expect(view.getByRole("link", { name: "Loops" }).getAttribute("href")).toBe("/loops")
    expect(view.getByRole("link", { name: "Runs" }).getAttribute("href")).toBe("/runs")
    expect(view.getByRole("link", { name: "Audit" }).getAttribute("href")).toBe("/audit")
    expect(view.getByRole("link", { name: "Admin" }).getAttribute("href")).toBe("/admin")
    expect(view.getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page")
    expect(view.getByRole("heading", { level: 1, name: "Projects" })).toBeTruthy()
  })

  it("closes the account menu when Escape is pressed", () => {
    const view = render(
      <AppShell activePath="/projects" pageTitle="Projects">
        <p>Route content</p>
      </AppShell>,
    )
    const account = view.getByRole("button", { name: "Account" })

    fireEvent.click(account)
    expect(account.getAttribute("aria-expanded")).toBe("true")

    fireEvent.keyDown(account, { key: "Escape" })

    expect(account.getAttribute("aria-expanded")).toBe("false")
  })

  it("moves focus into the account menu and restores it when dismissed", () => {
    const view = render(
      <AppShell activePath="/projects" pageTitle="Projects">
        <p>Route content</p>
      </AppShell>,
    )
    const account = view.getByRole("button", { name: "Account" })

    fireEvent.click(account)
    fireEvent.keyDown(account, { key: "ArrowDown" })

    const signOut = view.getByRole("menuitem", { name: "Sign out" })
    expect(document.activeElement).toBe(signOut)
    fireEvent.keyDown(signOut, { key: "Escape" })

    expect(view.queryByRole("menu")).toBeNull()
    expect(document.activeElement).toBe(account)
  })

  it("hides account actions from the sign-in page", () => {
    const view = render(
      <AppShell activePath="/login" pageTitle="Sign in">
        <p>Route content</p>
      </AppShell>,
    )

    expect(view.queryByRole("button", { name: "Account" })).toBeNull()
  })
})
