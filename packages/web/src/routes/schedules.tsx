import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/schedules")({
  component: () => (
    <RoutePage
      title="Schedules"
      description="Schedules configured for your projects will appear here."
      nextStep="Register a project and connect the daemon to load schedule data."
    />
  ),
})
