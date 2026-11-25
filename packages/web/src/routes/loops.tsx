import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/loops")({
  component: () => (
    <RoutePage
      title="Loops"
      description="Active loop iterations will appear here."
      nextStep="Connect the daemon to view loop activity."
    />
  ),
})
