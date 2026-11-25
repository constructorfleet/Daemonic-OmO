type EmptyStateProps = {
  readonly description: string
  readonly nextStep: string
}

export function EmptyState({ description, nextStep }: EmptyStateProps) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <div className="empty-state__symbol" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h2 id="empty-state-title">Nothing to show yet</h2>
      <p className="empty-state__description">{description}</p>
      <p className="empty-state__next">{nextStep}</p>
    </section>
  )
}
