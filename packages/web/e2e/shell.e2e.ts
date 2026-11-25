import { expect, test } from "@playwright/test"

const destinations = [
  { name: "Projects", path: "/projects", heading: "Projects" },
  { name: "Sessions", path: "/sessions", heading: "Sessions" },
  { name: "Graph", path: "/graph", heading: "Graph" },
  { name: "Schedules", path: "/schedules", heading: "Schedules" },
  { name: "Loops", path: "/loops", heading: "Loops" },
  { name: "Runs", path: "/runs", heading: "Runs" },
  { name: "Audit", path: "/audit", heading: "Audit" },
  { name: "Admin", path: "/admin", heading: "Admin" },
] as const

test.describe("application shell", () => {
  test("renders the Projects heading at the root route", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible()
  })

  test("marks Projects as active at the root route", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByTestId("nav-projects")).toHaveAttribute("aria-current", "page")
  })

  test("exposes a stable selector for the home link", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByTestId("home-link")).toHaveAttribute("href", "/projects")
  })

  test("routes every primary navigation item to its page", async ({ page }) => {
    await page.goto("/")

    for (const destination of destinations) {
      await page.getByRole("link", { name: destination.name, exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`${destination.path}$`))
      await expect(page.getByRole("heading", { level: 1, name: destination.heading })).toBeVisible()
    }
  })

  test("shows a not-found page for unknown paths", async ({ page }) => {
    await page.goto("/does-not-exist")

    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible()
    await expect(page.getByText(/does not exist/i)).toBeVisible()
    await expect(page.getByTestId("not-found-recovery")).toHaveAttribute("href", "/projects")
  })
})
