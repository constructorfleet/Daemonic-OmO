import { EmptyState } from "./empty-state"

type RoutePageProps = {
  readonly title: string
  readonly description: string
  readonly nextStep: string
}

export function RoutePage({ title, description, nextStep }: RoutePageProps) {
  return (
    <section className="route-page" aria-label={`${title} overview`}>
      <p className="route-page__status">
        <span className="status-dot" aria-hidden="true" />
        Waiting for daemon data
      </p>
      <EmptyState description={description} nextStep={nextStep} />
    </section>
  )
}
