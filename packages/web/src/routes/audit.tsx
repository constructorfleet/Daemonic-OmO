import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/audit")({
  component: () => (
    <RoutePage
      title="Audit"
      description="Recorded agent actions will appear here once authentication is configured."
      nextStep="Configure authentication before enabling audited actions."
    />
  ),
})
