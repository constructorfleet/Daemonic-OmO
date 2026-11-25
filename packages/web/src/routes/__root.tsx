import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { AppShell, NAVIGATION } from "../components/app-shell"
import { NotFoundPage } from "../components/not-found"

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const pageTitle = NAVIGATION.find((item) => item.href === pathname)?.label ?? "Page not found"

  return (
    <AppShell activePath={pathname} pageTitle={pageTitle}>
      <Outlet />
    </AppShell>
  )
}

function RootNotFound() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return <NotFoundPage pathname={pathname} />
}

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: RootNotFound,
})
