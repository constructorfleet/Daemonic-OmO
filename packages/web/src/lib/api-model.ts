import { isRecord, requiredInteger, requiredString } from "./api-model-primitives"

export { isRecord, requiredInteger, requiredString } from "./api-model-primitives"
export {
  RUN_STATES,
  parseProjectRunList,
  parseProjectTaskDocument,
  parseProjectTaskItem,
} from "./project-activity-model"
export type {
  ProjectRunSummary,
  ProjectTaskDocument,
  ProjectTaskItem,
  RunState,
} from "./project-activity-model"

export const API_ERROR_CODES = [
  "invalid_arguments",
  "unauthenticated",
  "forbidden",
  "not_found",
  "revision_conflict",
  "state_conflict",
  "idempotency_conflict",
  "internal",
] as const

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export type ProjectSettings = {
  readonly fullAccessOptIn: boolean
  readonly maxRunning: number
  readonly defaultModel?: string
  readonly defaultReasoning?: ThinkingLevel
  readonly worktreeForAdhoc: boolean
}

export type Project = {
  readonly id: string
  readonly userId: string
  readonly name: string
  readonly cwd: string
  readonly agentDir: string
  readonly stateDir: string
  readonly settings: ProjectSettings
  readonly state: "active" | "archived"
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type DiscoveredProject = {
  readonly cwd: string
  readonly name: string
  readonly stateDir: string
  readonly latestSessionId: string
  readonly latestSessionAt: number
  readonly registered: false
}

export type ProjectListItem = Project | DiscoveredProject

export type CurrentUser = {
  readonly id: string
  readonly name: string
  readonly email: string
  readonly role: "admin" | "member"
}

export type MeResponse = {
  readonly user: CurrentUser
  readonly role: CurrentUser["role"]
  readonly csrfToken: string | null
}

export type ProjectSettingsInput = Partial<ProjectSettings>

export type DocSubscription = {
  readonly docId: string
  readonly epoch?: number
  readonly rev?: number
}

function parseSettings(value: unknown): ProjectSettings {
  if (!isRecord(value)) throw new TypeError("API project settings must be an object")
  const { fullAccessOptIn, maxRunning, worktreeForAdhoc, defaultModel, defaultReasoning } = value
  if (typeof fullAccessOptIn !== "boolean" || typeof worktreeForAdhoc !== "boolean") {
    throw new TypeError("API project settings contain invalid boolean values")
  }
  if (typeof maxRunning !== "number" || !Number.isSafeInteger(maxRunning)) {
    throw new TypeError("API project settings.maxRunning must be an integer")
  }
  if (defaultModel !== undefined && typeof defaultModel !== "string") {
    throw new TypeError("API project settings.defaultModel must be a string")
  }
  if (defaultReasoning !== undefined && !THINKING_LEVELS.some((level) => level === defaultReasoning)) {
    throw new TypeError("API project settings.defaultReasoning is unknown")
  }
  const reasoning = THINKING_LEVELS.find((level) => level === defaultReasoning)
  return {
    fullAccessOptIn,
    maxRunning,
    worktreeForAdhoc,
    ...(typeof defaultModel === "string" ? { defaultModel } : {}),
    ...(reasoning === undefined ? {} : { defaultReasoning: reasoning }),
  }
}

export function parseProject(value: unknown): Project {
  if (!isRecord(value)) throw new TypeError("API project must be an object")
  const state = value["state"]
  if (state !== "active" && state !== "archived") throw new TypeError("API project state is unknown")
  return {
    id: requiredString(value, "id"),
    userId: requiredString(value, "userId"),
    name: requiredString(value, "name"),
    cwd: requiredString(value, "cwd"),
    agentDir: requiredString(value, "agentDir"),
    stateDir: requiredString(value, "stateDir"),
    settings: parseSettings(value["settings"]),
    state,
    revision: requiredInteger(value, "revision"),
    createdAt: requiredString(value, "createdAt"),
    updatedAt: requiredString(value, "updatedAt"),
  }
}

export function parseProjectListItem(value: unknown): ProjectListItem {
  if (!isRecord(value)) throw new TypeError("API project list item must be an object")
  if (value["registered"] === false) {
    return {
      cwd: requiredString(value, "cwd"),
      name: requiredString(value, "name"),
      stateDir: requiredString(value, "stateDir"),
      latestSessionId: requiredString(value, "latestSessionId"),
      latestSessionAt: requiredInteger(value, "latestSessionAt"),
      registered: false,
    }
  }
  return parseProject(value)
}

export function parseMe(value: unknown): MeResponse {
  if (!isRecord(value) || !isRecord(value["user"])) throw new TypeError("API /me response must include a user")
  const user = value["user"]
  const role = value["role"]
  if ((role !== "admin" && role !== "member") || user["role"] !== role) {
    throw new TypeError("API /me response contains an unknown role")
  }
  const csrfToken = value["csrfToken"]
  if (csrfToken !== null && typeof csrfToken !== "string") {
    throw new TypeError("API /me csrfToken must be a string or null")
  }
  return {
    user: {
      id: requiredString(user, "id"),
      name: requiredString(user, "name"),
      email: requiredString(user, "email"),
      role,
    },
    role,
    csrfToken,
  }
}
