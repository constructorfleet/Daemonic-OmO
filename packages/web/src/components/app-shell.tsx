import { useState, type ReactNode } from "react"

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

type AppShellProps = {
  readonly activePath: string
  readonly pageTitle: string
  readonly children: ReactNode
}

export function AppShell({ activePath, pageTitle, children }: AppShellProps) {
  const [accountOpen, setAccountOpen] = useState(false)

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <a className="brand" href="/projects" aria-label="omo-daemonic home" data-testid="home-link">
          <span className="brand__mark" aria-hidden="true" />
          <span>omo-daemonic</span>
        </a>
        <nav className="primary-nav" aria-label="Primary">
          {NAVIGATION.map(({ label, href }) => (
            <a
              className="primary-nav__link"
              href={href}
              aria-current={activePath === href ? "page" : undefined}
              data-testid={`nav-${label.toLowerCase()}`}
              key={href}
            >
              <span className="primary-nav__marker" aria-hidden="true" />
              <span>{label}</span>
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
              Daemon status appears here after a connection is configured.
            </p>
          </div>
          <div className="account">
            <button
              className="account__trigger"
              type="button"
              aria-label="Account"
              aria-expanded={accountOpen}
              aria-haspopup="true"
              aria-controls="account-menu"
              data-testid="account-menu-trigger"
              onClick={() => setAccountOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setAccountOpen(false)
              }}
            >
              <span className="account__initial" aria-hidden="true" />
              <span className="account__label" aria-hidden="true" />
              <span className="account__chevron" aria-hidden="true">{accountOpen ? "−" : "+"}</span>
            </button>
            {accountOpen && (
              <div className="account__menu" id="account-menu" role="menu">
                <p className="account__menu-title">Account</p>
                <p className="account__menu-copy">Account details will appear after authentication is configured.</p>
              </div>
            )}
          </div>
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
