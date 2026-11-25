import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/sessions")({
  component: () => (
    <RoutePage
      title="Sessions"
      description="Live and completed agent sessions from your projects will appear here."
      nextStep="Register a project to see its agent activity."
    />
  ),
})
