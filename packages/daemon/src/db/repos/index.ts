import type { Database } from "bun:sqlite"
import { EventLedger } from "../ledger"
import { createAuditRepository } from "./audit"
import { createIdempotencyRepository } from "./idempotency"
import { createLoopRepository } from "./loops"
import { createProjectRepository } from "./projects"
import { createRunRepository } from "./runs"
import { createScheduleRepository } from "./schedules"
import { createSessionRepository } from "./sessions"
import { createUserRepository } from "./users"

export function createRepositories(db: Database, ledger = new EventLedger(db)) {
  const userRepository = createUserRepository(db, ledger)
  return {
    users: userRepository,
    sessions: createSessionRepository(db),
    projects: createProjectRepository(db, ledger),
    schedules: createScheduleRepository(db, ledger),
    loops: createLoopRepository(db, ledger),
    runs: createRunRepository(db, ledger),
    audit: createAuditRepository(db),
    idempotency: createIdempotencyRepository(db),
  }
}
