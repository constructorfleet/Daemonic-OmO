import type { createApiClient } from "./api-client"

export type ProjectsApi = Pick<
  ReturnType<typeof createApiClient>,
  | "me"
  | "health"
  | "getProject"
  | "listProjects"
  | "getProjectTaskDocument"
  | "listProjectRunningRuns"
  | "createProject"
  | "updateProject"
  | "logout"
  | "subscribeDoc"
  | "unsubscribeDoc"
>
