import { ApiError } from "../api/errors"
import type { Project, User } from "../core/types"
import type { RunEngine } from "./engine"

/** The run side of `archive?force=true`: cancels the project's unfinished runs; 409 if one stays uninterruptible. */
export async function cancelRunsForArchive(engine: RunEngine, actor: User, project: Project): Promise<void> {
  const uninterruptible = await engine.cancelProject(actor, project.id)
  if (uninterruptible.length > 0) {
    throw new ApiError("state_conflict", "some runs could not be stopped", { uninterruptible: [...uninterruptible] })
  }
}
