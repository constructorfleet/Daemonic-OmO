import type { Database } from "bun:sqlite"
import type { EventLedger } from "../ledger"
import type { Project } from "../../core/types"
import { parseUlid } from "../../core/ids"
import { projectSettingsFromRow, projectSettingsJson } from "../../projects/settings"
import { RepositoryDataError, RevisionConflictError } from "./errors"
import { parseRecord } from "./json"
import type { JsonObject } from "../../core/types"

function decodeProject(json: string): Project {
  const row = parseRecord(json, "project")
  const id = typeof row.id === "string" ? parseUlid(row.id) : null
  const userId = typeof row.userId === "string" ? parseUlid(row.userId) : null
  const settings = projectSettingsFromRow(row)
  if (
    id === null || userId === null || settings === null ||
    typeof row.name !== "string" || typeof row.cwd !== "string" ||
    typeof row.agentDir !== "string" || typeof row.stateDir !== "string" ||
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
    settings,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function projectSnapshot(project: Project): JsonObject {
  return {
    id: project.id,
    userId: project.userId,
    name: project.name,
    cwd: project.cwd,
    agentDir: project.agentDir,
    stateDir: project.stateDir,
    settings: projectSettingsJson(project.settings),
    state: project.state,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
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
    listAll(): readonly Project[] {
      return db.query<{ readonly json: string }, []>(
        "SELECT json FROM projects ORDER BY user_id, name, id",
      ).all().map(({ json }) => decodeProject(json))
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
          data: projectSnapshot(project),
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
          data: projectSnapshot(project),
        })
      })
    },
    remove(project: Project): void {
      ledger.transact((transaction) => {
        const changed = transaction.execute(
          "DELETE FROM projects WHERE id = ? AND user_id = ?",
          [project.id, project.userId],
        )
        if (changed !== 1) throw new RevisionConflictError(project.id, project.revision)
        transaction.emit({
          at: project.updatedAt,
          type: "project.deleted",
          entityKind: "project",
          entityId: project.id,
          userId: project.userId,
          projectId: null,
          data: { id: project.id },
        })
      })
    },
  }
}
