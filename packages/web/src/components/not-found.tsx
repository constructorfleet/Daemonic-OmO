export function NotFoundPage({ pathname }: { readonly pathname: string }) {
  return (
    <section className="not-found" aria-label="Not found">
      <p className="not-found__code">404 / ROUTE</p>
      <p>The path <code>{pathname}</code> does not exist in this workspace.</p>
      <a className="not-found__link" href="/projects" data-testid="not-found-recovery">Back to projects</a>
    </section>
  )
}
