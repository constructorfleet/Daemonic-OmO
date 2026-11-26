import { describe, expect, it } from "bun:test"
import { ApiError, createApiClient } from "./api"
import type { DiscoveredProject } from "./api"

describe("web API client", () => {
  it("loads CSRF state before a mutation and sends an idempotency key", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const client = createApiClient({
      fetcher: async (input, init) => {
        requests.push({ url: String(input), init })
        if (String(input) === "/api/v1/me") {
          return Response.json({
            user: { id: "user-1", name: "Ari", email: "ari@example.test", role: "member" },
            role: "member",
            csrfToken: "csrf-1",
          })
        }
        return Response.json({
          id: "project-1",
          userId: "user-1",
          name: "demo",
          cwd: "/tmp/demo",
          agentDir: "/tmp/agent",
          stateDir: "/tmp/agent/projects/demo",
          settings: {
            fullAccessOptIn: false,
            maxRunning: 1,
            worktreeForAdhoc: false,
          },
          state: "active",
          revision: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
      },
      redirect: () => {},
    })

    const project = await client.createProject({ cwd: "/tmp/demo" })

    expect(project.id).toBe("project-1")
    expect(requests).toHaveLength(2)
    expect(requests[0]?.init?.method).toBeUndefined()
    const mutation = requests[1]
    expect(mutation?.url).toBe("/api/v1/projects")
    expect(mutation?.init?.method).toBe("POST")
    const headers = new Headers(mutation?.init?.headers)
    expect(headers.get("X-CSRF-Token")).toBe("csrf-1")
    expect(headers.get("Idempotency-Key")).not.toBeNull()
    expect(mutation?.init?.credentials).toBe("same-origin")
  })

  it("preserves the daemon error code and message", async () => {
    const client = createApiClient({
      fetcher: async () => Response.json(
        { error: { code: "revision_conflict", message: "project changed" } },
        { status: 409 },
      ),
      redirect: () => {},
    })

    try {
      await client.getProject("project-1")
      throw new Error("expected the request to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      if (!(error instanceof ApiError)) throw error
      expect(error.code).toBe("revision_conflict")
      expect(error.message).toBe("project changed")
    }
  })

  it("redirects unauthenticated API requests to the OIDC endpoint", async () => {
    const redirects: string[] = []
    const client = createApiClient({
      fetcher: async () => new Response(null, { status: 401 }),
      redirect: (path) => redirects.push(path),
    })

    await expect(client.me()).rejects.toBeInstanceOf(ApiError)

    expect(redirects).toEqual(["/auth/login"])
  })

  it("preserves the signed-in user's configured transcript read budget", async () => {
    const client = createApiClient({
      fetcher: async () => Response.json({
        user: {
          id: "user-1",
          name: "Ari",
          email: "ari@example.test",
          role: "member",
          settings: { readBytes: 65_536 },
        },
        role: "member",
        csrfToken: null,
      }),
      redirect: () => {},
    })

    const identity = await client.me()

    expect(identity.user.settings?.readBytes).toBe(65_536)
  })

  it("updates the user's transcript read budget with CSRF protection", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const client = createApiClient({
      fetcher: async (input, init) => {
        const url = String(input)
        requests.push({ url, init })
        if (url === "/api/v1/me") {
          return Response.json({
            user: { id: "user-1", name: "Ari", email: "ari@example.test", role: "member" },
            role: "member",
            csrfToken: "csrf-1",
          })
        }
        return Response.json({ readBytes: 65_536 })
      },
      redirect: () => {},
    })

    const settings = await client.updateUserSettings({ readBytes: 131_072 })

    expect(settings).toEqual({ readBytes: 65_536 })
    expect(requests[1]?.url).toBe("/api/v1/me/settings")
    expect(requests[1]?.init?.method).toBe("PATCH")
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ readBytes: 131_072 }))
    expect(new Headers(requests[1]?.init?.headers).get("X-CSRF-Token")).toBe("csrf-1")
  })

  it("sends document subscribe and unsubscribe requests with mutation headers", async () => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const client = createApiClient({
      fetcher: async (input, init) => {
        const url = String(input)
        requests.push({ url, init })
        if (url === "/api/v1/me") {
          return Response.json({
            user: { id: "user-1", name: "Ari", email: "ari@example.test", role: "member" },
            role: "member",
            csrfToken: "csrf-1",
          })
        }
        return new Response(null, { status: 204 })
      },
      redirect: () => {},
    })

    await client.subscribeDoc("stream/1", { docId: "doc-1", epoch: 4, rev: 9 })
    await client.unsubscribeDoc("stream/1", "doc-1")

    expect(requests[1]?.url).toBe("/api/v1/stream/stream%2F1/docs")
    expect(requests[2]?.url).toBe("/api/v1/stream/stream%2F1/docs/doc-1")
    expect(requests[1]?.init?.method).toBe("POST")
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ docId: "doc-1", epoch: 4, rev: 9 }))
    expect(requests[2]?.init?.method).toBe("DELETE")
    expect(new Headers(requests[1]?.init?.headers).get("X-CSRF-Token")).toBe("csrf-1")
    expect(new Headers(requests[2]?.init?.headers).get("Idempotency-Key")).not.toBeNull()
  })

  it("scopes discovered project listings to the selected admin user", async () => {
    const urls: string[] = []
    const discovered: DiscoveredProject = {
      cwd: "/tmp/discovered",
      name: "discovered",
      stateDir: "/tmp/agent/projects/discovered",
      latestSessionId: "session-1",
      latestSessionAt: 1,
      registered: false,
    }
    const client = createApiClient({
      fetcher: async (input) => {
        const url = String(input)
        urls.push(url)
        return url === "/api/v1/projects"
          ? Response.json({ items: [], headSeq: 42 })
          : Response.json({ items: [discovered], headSeq: 1 })
      },
      redirect: () => {},
    })

    const result = await client.listProjects(true, "user-1")

    expect(urls).toEqual([
      "/api/v1/projects",
      "/api/v1/projects?include=discovered&userId=user-1",
    ])
    expect(result).toEqual({ items: [discovered], headSeq: 42 })
  })

  it("loads the project task document used by the observer stream", async () => {
    const urls: string[] = []
    const client = createApiClient({
      fetcher: async (input) => {
        urls.push(String(input))
        return Response.json({
          docId: "project:project-1:tasks",
          epoch: 8,
          rev: 3,
          snapshot: {
            items: [{
              id: "qa-task-1",
              kind: "task",
              rootSessionId: "root-session",
              depth: 1,
              task: {
                task_id: "qa-task-1",
                parent_session_id: "root-session",
                root_session_id: "root-session",
                status: "running",
                created_at: "2026-11-25T08:00:00.000Z",
                name: "Live task",
              },
            }],
            invalidRecords: 0,
            agentDirHash: "agent-hash",
          },
        })
      },
      redirect: () => {},
    })

    const document = await client.getProjectTaskDocument("project-1")

    expect(urls).toEqual(["/api/v1/docs/project%3Aproject-1%3Atasks"])
    expect(document.snapshot.items).toMatchObject([{ id: "qa-task-1", task: { status: "running" } }])
    expect([document.epoch, document.rev]).toEqual([8, 3])
  })

  it("loads creating and active runs from the project-scoped run API", async () => {
    const urls: string[] = []
    const client = createApiClient({
      fetcher: async (input) => {
        const url = String(input)
        urls.push(url)
        const state = new URL(url, "http://localhost").searchParams.get("state")
        const id = state === "creating" ? "run-creating" : "run-active"
        return Response.json({
          items: [{ id, projectId: "project-1", state }],
          headSeq: 4,
        })
      },
      redirect: () => {},
    })

    const runs = await client.listProjectRunningRuns("project-1")

    expect(urls.sort()).toEqual([
      "/api/v1/runs?projectId=project-1&state=active&limit=1000",
      "/api/v1/runs?projectId=project-1&state=creating&limit=1000",
    ])
    expect(runs.map((run) => run.state).sort()).toEqual(["active", "creating"])
  })
})
