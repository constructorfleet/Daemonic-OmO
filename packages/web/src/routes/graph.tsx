import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/graph")({
  component: () => (
    <RoutePage
      title="Graph"
      description="Task trees and workflow runs will appear here when project activity is available."
      nextStep="Register a project to make its agent and workflow activity available."
    />
  ),
})
