import {
  API_ERROR_CODES,
  isRecord,
  parseMe,
  parseProject,
  parseProjectListItem,
  parseProjectRunList,
  parseProjectTaskDocument,
  requiredInteger,
  requiredString,
} from "./api-model"
import type {
  ApiErrorCode,
  DocSubscription,
  MeResponse,
  Project,
  ProjectListItem,
  ProjectRunSummary,
  ProjectTaskDocument,
  ProjectSettingsInput,
} from "./api-model"

export type ApiErrorOptions = {
  readonly status: number
  readonly details?: Readonly<Record<string, unknown>>
}

export class ApiError extends Error {
  readonly name = "ApiError"
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    options: ApiErrorOptions,
  ) {
    super(message)
    this.status = options.status
    this.details = options.details
  }

  readonly status: number
}

export interface ApiClientOptions {
  readonly fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  readonly redirect?: (path: string) => void
}

function apiErrorFrom(status: number, body: unknown): ApiError {
  const error = isRecord(body) ? body["error"] : undefined
  if (isRecord(error)) {
    const code = API_ERROR_CODES.find((candidate) => candidate === error["code"])
    const message = error["message"]
    if (code !== undefined && typeof message === "string") {
      const details = isRecord(error["details"]) ? error["details"] : undefined
      return details === undefined
        ? new ApiError(code, message, { status })
        : new ApiError(code, message, { status, details })
    }
  }
  return new ApiError("internal", `Request failed with status ${status}`, { status })
}

function parseProjectList(value: unknown): { readonly items: readonly ProjectListItem[]; readonly headSeq: number } {
  if (!isRecord(value) || !Array.isArray(value["items"])) {
    throw new TypeError("API projects response must include items")
  }
  return { items: value["items"].map(parseProjectListItem), headSeq: requiredInteger(value, "headSeq") }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const fetcher = options.fetcher ?? fetch
  const redirect = options.redirect ?? ((path: string) => window.location.assign(path))
  let currentUser: MeResponse | null = null

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    const response = await fetcher(path, {
      ...init,
      headers,
      credentials: "same-origin",
    })
    if (response.status === 401) {
      redirect("/auth/login")
      throw new ApiError("unauthenticated", "Sign in to continue", { status: 401 })
    }
    if (!response.ok) {
      const body: unknown = await response.json()
      throw apiErrorFrom(response.status, body)
    }
    return response
  }

  async function json(response: Response): Promise<unknown> {
    const body: unknown = await response.json()
    return body
  }

  async function csrfHeaders(): Promise<Headers> {
    const identity = await client.me()
    if (identity.csrfToken === null) {
      throw new ApiError("unauthenticated", "This operation requires a browser session", { status: 401 })
    }
    return new Headers({
      "content-type": "application/json",
      "X-CSRF-Token": identity.csrfToken,
      "Idempotency-Key": crypto.randomUUID(),
    })
  }

  const client = {
    async me(): Promise<MeResponse> {
      if (currentUser !== null) return currentUser
      currentUser = parseMe(await json(await request("/api/v1/me")))
      return currentUser
    },

    async health(): Promise<{ readonly version: string; readonly headSeq: number; readonly omo: unknown }> {
      const body = await json(await request("/api/v1/health"))
      if (!isRecord(body) || (!isRecord(body["omo"]) && body["omo"] !== null)) {
        throw new TypeError("API health response is invalid")
      }
      return {
        version: requiredString(body, "version"),
        headSeq: requiredInteger(body, "headSeq"),
        omo: body["omo"],
      }
    },

    async listProjects(
      includeDiscovered = true,
      userId?: string,
    ): Promise<{ readonly items: readonly ProjectListItem[]; readonly headSeq: number }> {
      if (includeDiscovered && userId !== undefined) {
        const [allProjects, userProjects] = await Promise.all([
          request("/api/v1/projects").then(json),
          request(`/api/v1/projects?include=discovered&userId=${encodeURIComponent(userId)}`).then(json),
        ])
        const all = parseProjectList(allProjects)
        const own = parseProjectList(userProjects)
        return { items: [...all.items, ...own.items.filter((item) => "registered" in item)], headSeq: all.headSeq }
      }
      const query = new URLSearchParams()
      if (includeDiscovered) query.set("include", "discovered")
      if (userId !== undefined) query.set("userId", userId)
      const params = query.toString()
      const path = params.length === 0 ? "/api/v1/projects" : `/api/v1/projects?${params}`
      return parseProjectList(await json(await request(path)))
    },

    async getProject(id: string): Promise<Project> {
      return parseProject(await json(await request(`/api/v1/projects/${encodeURIComponent(id)}`)))
    },

    async getProjectTaskDocument(projectId: string): Promise<ProjectTaskDocument> {
      const docId = `project:${projectId}:tasks`
      return parseProjectTaskDocument(await json(await request(`/api/v1/docs/${encodeURIComponent(docId)}`)))
    },

    async listProjectRunningRuns(projectId: string): Promise<readonly ProjectRunSummary[]> {
      const states = ["creating", "active"] as const
      const lists = await Promise.all(states.map(async (state) => {
        const query = new URLSearchParams({ projectId, state, limit: "1000" })
        return parseProjectRunList(await json(await request(`/api/v1/runs?${query}`)))
      }))
      return lists.flat()
    },

    async createProject(input: { readonly cwd: string; readonly name?: string }): Promise<Project> {
      const headers = await csrfHeaders()
      return parseProject(await json(await request("/api/v1/projects", {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      })))
    },

    async updateProject(id: string, input: { readonly revision: number; readonly name?: string; readonly settings?: ProjectSettingsInput }): Promise<Project> {
      const headers = await csrfHeaders()
      return parseProject(await json(await request(`/api/v1/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(input),
      })))
    },

    async subscribeDoc(streamId: string, subscription: DocSubscription): Promise<void> {
      const headers = await csrfHeaders()
      await request(`/api/v1/stream/${encodeURIComponent(streamId)}/docs`, {
        method: "POST",
        headers,
        body: JSON.stringify(subscription),
      })
    },

    async unsubscribeDoc(streamId: string, docId: string): Promise<void> {
      const headers = await csrfHeaders()
      await request(
        `/api/v1/stream/${encodeURIComponent(streamId)}/docs/${encodeURIComponent(docId)}`,
        { method: "DELETE", headers },
      )
    },

    async logout(): Promise<void> {
      const headers = await csrfHeaders()
      await request("/auth/logout", { method: "POST", headers, body: "{}" })
      currentUser = null
      redirect("/login")
    },
  }

  return client
}
