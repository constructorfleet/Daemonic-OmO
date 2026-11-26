import { createFileRoute } from "@tanstack/react-router"
import { SessionsPageView } from "../features/sessions/sessions-page-view"

export const Route = createFileRoute("/sessions")({
  component: () => <SessionsPageView />,
})
