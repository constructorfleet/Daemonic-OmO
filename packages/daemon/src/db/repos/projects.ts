import type { Database } from "bun:sqlite"
import type { EventLedger } from "../ledger"
import type { Project } from "../../core/types"
import { parseUlid } from "../../core/ids"
import { RepositoryDataError, RevisionConflictError } from "./errors"
import { parseRecord } from "./json"

function decodeProject(json: string): Project {
  const row = parseRecord(json, "project")
  const id = typeof row.id === "string" ? parseUlid(row.id) : null
  const userId = typeof row.userId === "string" ? parseUlid(row.userId) : null
  if (
    id === null || userId === null || typeof row.name !== "string" ||
    typeof row.cwd !== "string" || typeof row.agentDir !== "string" ||
    typeof row.stateDir !== "string" || typeof row.maxRunning !== "number" ||
    (row.state !== "active" && row.state !== "archived") ||
    typeof row.revision !== "number" || typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string"
  ) throw new RepositoryDataError("project")
  return {
    id,
    userId,
    name: row.name,
    cwd: row.cwd,
    agentDir: row.agentDir,
    stateDir: row.stateDir,
    maxRunning: row.maxRunning,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function createProjectRepository(db: Database, ledger: EventLedger) {
  return {
    get(id: Project["id"]): Project | null {
      const row = db.query<{ readonly json: string }, [string]>(
        "SELECT json FROM projects WHERE id = ?",
      ).get(id)
      return row === null ? null : decodeProject(row.json)
    },
    listByUser(userId: Project["userId"]): readonly Project[] {
      return db.query<{ readonly json: string }, [string]>(
        "SELECT json FROM projects WHERE user_id = ? ORDER BY name, id",
      ).all(userId).map(({ json }) => decodeProject(json))
    },
    put(project: Project): void {
      ledger.transact((transaction) => {
        transaction.execute(
          `INSERT INTO projects(id, user_id, name, cwd, state, updated_at, json, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [project.id, project.userId, project.name, project.cwd, project.state,
            project.updatedAt, JSON.stringify(project), project.revision],
        )
        transaction.emit({
          at: project.updatedAt,
          type: "project.upserted",
          entityKind: "project",
          entityId: project.id,
          userId: project.userId,
          projectId: project.id,
          data: { ...project },
        })
      })
    },
    update(project: Project, expectedRevision: number): void {
      if (project.revision !== expectedRevision + 1) {
        throw new RangeError("project revision must advance by one")
      }
      ledger.transact((transaction) => {
        const changed = transaction.execute(
          `UPDATE projects SET name = ?, cwd = ?, state = ?, updated_at = ?, json = ?, revision = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
          [project.name, project.cwd, project.state, project.updatedAt,
            JSON.stringify(project), project.revision, project.id, project.userId, expectedRevision],
        )
        if (changed !== 1) throw new RevisionConflictError(project.id, expectedRevision)
        transaction.emit({
          at: project.updatedAt,
          type: "project.upserted",
          entityKind: "project",
          entityId: project.id,
          userId: project.userId,
          projectId: project.id,
          data: { ...project },
        })
      })
    },
  }
}
