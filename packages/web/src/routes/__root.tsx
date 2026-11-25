import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { AppShell, NAVIGATION } from "../components/app-shell"
import { NotFoundPage } from "../components/not-found"

function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const activePath = pathname === "/" ? "/projects" : pathname
  const pageTitle = NAVIGATION.find((item) => item.href === activePath)?.label ?? "Page not found"

  return (
    <AppShell activePath={activePath} pageTitle={pageTitle}>
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
