import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ApiError, createApiClient } from "../lib/api"

const NAVIGATION = [
  { label: "Projects", href: "/projects" },
  { label: "Sessions", href: "/sessions" },
  { label: "Graph", href: "/graph" },
  { label: "Schedules", href: "/schedules" },
  { label: "Loops", href: "/loops" },
  { label: "Runs", href: "/runs" },
  { label: "Audit", href: "/audit" },
  { label: "Admin", href: "/admin" },
] as const
const api = createApiClient()

type AppShellProps = {
  readonly activePath: string
  readonly pageTitle: string
  readonly children: ReactNode
}

export function AppShell({ activePath, pageTitle, children }: AppShellProps) {
  const [accountOpen, setAccountOpen] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const accountTrigger = useRef<HTMLButtonElement>(null)
  const signOutAction = useRef<HTMLButtonElement>(null)
  const focusSignOutAction = useCallback((element: HTMLButtonElement | null): void => {
    signOutAction.current = element
    element?.focus()
  }, [])

  function closeAccountMenu(): void {
    setAccountOpen(false)
    accountTrigger.current?.focus()
  }

  function accountMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault()
      closeAccountMenu()
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      signOutAction.current?.focus()
    }
  }

  function signOut(): void {
    setLogoutError(null)
    void api.logout().catch((error: unknown) => {
      if (error instanceof ApiError || error instanceof Error) setLogoutError(error.message)
      else setLogoutError("Sign out could not be completed")
    })
  }

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <a className="brand min-w-0 max-w-full overflow-hidden" href="/projects" aria-label="omo-daemonic home" data-testid="home-link">
          <span className="brand__mark" aria-hidden="true" />
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">omo-daemonic</span>
        </a>
        <nav className="primary-nav min-w-0" aria-label="Primary">
          {NAVIGATION.map(({ label, href }) => (
            <a
              className="primary-nav__link min-w-0 max-w-full overflow-hidden"
              href={href}
              aria-current={activePath === href ? "page" : undefined}
              data-testid={`nav-${label.toLowerCase()}`}
              key={href}
            >
              <span className="primary-nav__marker" aria-hidden="true" />
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            </a>
          ))}
        </nav>
        <p className="sidebar-note">Local agent workspace</p>
      </aside>
      <div className="workspace">
        <header className="workspace__header">
          <div className="workspace__context">
            <p className="workspace__connection" role="status">
              <span className="status-dot" aria-hidden="true" />
              <span className="max-w-prose min-w-0 break-words">
                Daemon status appears here after a connection is configured.
              </span>
            </p>
          </div>
          {activePath !== "/login" && (
            <div className="account max-w-40">
              <button
                ref={accountTrigger}
                className="account__trigger"
                style={{ borderColor: "var(--color-control-edge)" }}
                type="button"
                aria-label="Account"
                aria-expanded={accountOpen}
                aria-haspopup="true"
                aria-controls="account-menu"
                data-testid="account-menu-trigger"
                onClick={() => setAccountOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") closeAccountMenu()
                  if (event.key === "ArrowDown") setAccountOpen(true)
                }}
              >
                <span className="account__initial" aria-hidden="true" />
                <span className="account__label" aria-hidden="true" />
                <span className="account__chevron" aria-hidden="true">{accountOpen ? "−" : "+"}</span>
              </button>
              {accountOpen && (
                <>
                  <button
                    className="hidden max-[30rem]:fixed max-[30rem]:inset-0 max-[30rem]:z-40 max-[30rem]:block max-[30rem]:border-0 max-[30rem]:p-0"
                    type="button"
                    aria-label="Close account menu"
                    tabIndex={-1}
                    onClick={closeAccountMenu}
                    style={{ backgroundColor: "color-mix(in srgb, var(--color-scrim) 48%, transparent)" }}
                  />
                  <div
                    className="absolute right-0 top-[calc(100%_+_var(--space-2))] z-50 grid min-w-0 max-w-full w-[min(18rem,calc(100vw_-_var(--space-8)))] gap-2 rounded-[var(--radius-surface)] border border-control-edge bg-surface p-3 text-text max-[30rem]:fixed max-[30rem]:inset-x-4 max-[30rem]:bottom-0 max-[30rem]:top-auto max-[30rem]:w-auto max-[30rem]:rounded-b-none max-[30rem]:pb-[calc(var(--space-4)_+_env(safe-area-inset-bottom))]"
                    id="account-menu"
                    role="menu"
                    onKeyDown={accountMenuKeyDown}
                  >
                    <p className="account__menu-title min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap">Account</p>
                    {logoutError !== null && <p className="mt-2 min-w-0 max-w-full break-words text-sm text-error" role="alert">{logoutError}</p>}
                    <button
                      ref={focusSignOutAction}
                      className="min-h-11 min-w-0 max-w-full w-full whitespace-normal [overflow-wrap:anywhere] rounded-[var(--radius-control)] border border-control-edge bg-panel px-3 py-2 text-left text-heading hover:bg-selection"
                      type="button"
                      role="menuitem"
                      onClick={signOut}
                    >
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </header>
        <main className="workspace__content" id="main-content">
          <div className="page-content">
            <h1>{pageTitle}</h1>
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}

export { NAVIGATION }
