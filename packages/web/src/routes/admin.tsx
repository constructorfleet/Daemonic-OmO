import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/admin")({
  component: () => (
    <RoutePage
      title="Admin"
      description="Administrators can manage provisioned users here."
      nextStep="Configure authentication and connect the daemon to load administration data."
    />
  ),
})
