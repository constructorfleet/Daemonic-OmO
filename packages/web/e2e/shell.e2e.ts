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
    await expect(page.getByRole("link", { name: "Back to projects" })).toHaveAttribute("href", "/projects")
  })
})
