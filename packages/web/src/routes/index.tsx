import { createFileRoute } from "@tanstack/react-router"
import { RoutePage } from "../components/route-page"

export const Route = createFileRoute("/")({
  component: () => (
    <RoutePage
      title="Projects"
      description="Projects registered with omo-daemonic will appear here."
      nextStep="Connect the daemon to discover and manage local projects."
    />
  ),
})
