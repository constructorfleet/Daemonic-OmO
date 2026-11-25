import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/login")({
  component: LoginPage,
})

export function LoginPage() {
  return (
    <section className="grid max-w-xl gap-6" aria-label="Sign in">
      <div className="grid gap-3">
        <p className="max-w-prose text-base leading-relaxed text-text">
          Use the identity provider configured for this daemon.
        </p>
      </div>
      <a
        className="inline-flex min-h-11 w-fit items-center justify-center rounded-[var(--radius-control)] bg-accent px-5 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        style={{ color: "var(--color-panel)" }}
        href="/auth/login"
      >
        Continue with your identity provider
      </a>
    </section>
  )
}
