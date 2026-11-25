import { cleanup, render } from "@testing-library/react"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { LoginPage } from "./routes/login"

GlobalRegistrator.register()

afterEach(cleanup)
afterAll(async () => GlobalRegistrator.unregister())

describe("login landing page", () => {
  it("sends the user to the daemon's OIDC login route", () => {
    const view = render(<LoginPage />)

    expect(view.queryByRole("heading")).toBeNull()
    expect(view.getByRole("link", { name: "Continue with your identity provider" }).getAttribute("href"))
      .toBe("/auth/login")
  })
})
