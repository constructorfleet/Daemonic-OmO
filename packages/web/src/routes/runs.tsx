import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/runs")({
  component: () => (
    <RoutePage
      title="Runs"
      description="Runs started through omo-daemonic will appear here with their current state."
      nextStep="Register a project to make it available for agent runs."
    />
  ),
})
