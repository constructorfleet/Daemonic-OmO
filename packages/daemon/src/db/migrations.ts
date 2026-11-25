import type { Database } from "bun:sqlite"

type Migration = {
  readonly version: number
  readonly sql: string
}

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        oidc_issuer TEXT NOT NULL,
        oidc_sub TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        agent_dir TEXT NOT NULL,
        allowed_roots_json TEXT NOT NULL CHECK (json_valid(allowed_roots_json)),
        settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        UNIQUE (oidc_issuer, oidc_sub)
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user_expiry ON sessions(user_id, expires_at);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL CHECK (json_valid(json)),
        revision INTEGER NOT NULL CHECK (revision > 0)
      );
      CREATE INDEX projects_user_state ON projects(user_id, state, name);
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        next_fire_at INTEGER,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL CHECK (json_valid(json)),
        revision INTEGER NOT NULL CHECK (revision > 0)
      );
      CREATE INDEX schedules_due ON schedules(state, next_fire_at);
      CREATE INDEX schedules_user_project ON schedules(user_id, project_id);
      CREATE TABLE loops (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        next_iteration_at INTEGER,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL CHECK (json_valid(json)),
        revision INTEGER NOT NULL CHECK (revision > 0)
      );
      CREATE INDEX loops_due ON loops(state, next_iteration_at);
      CREATE INDEX loops_user_project ON loops(user_id, project_id);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
        loop_id TEXT REFERENCES loops(id) ON DELETE SET NULL,
        state TEXT NOT NULL,
        fire_key TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL CHECK (json_valid(json)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        UNIQUE (fire_key, attempt)
      );
      CREATE INDEX runs_user_created ON runs(user_id, created_at DESC);
      CREATE INDEX runs_project_state ON runs(project_id, state, created_at DESC);
      CREATE TABLE audit (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail_json TEXT NOT NULL CHECK (json_valid(detail_json))
      );
      CREATE INDEX audit_user_at ON audit(user_id, at DESC);
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        user_seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        data TEXT NOT NULL CHECK (json_valid(data)),
        UNIQUE (user_id, user_seq)
      );
      CREATE INDEX events_user_seq ON events(user_id, user_seq);
      CREATE INDEX events_project_seq ON events(project_id, seq);
      CREATE TABLE idempotency (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response TEXT NOT NULL CHECK (json_valid(response)),
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE INDEX idempotency_expiry ON idempotency(expires_at);
      CREATE TABLE event_heads (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        seq INTEGER NOT NULL CHECK (seq >= 0)
      );
      INSERT INTO event_heads(id, seq) VALUES (1, 0);
      CREATE TABLE user_event_heads (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        user_seq INTEGER NOT NULL CHECK (user_seq >= 0)
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta(key, value) VALUES ('incarnation', lower(hex(randomblob(16))));
    `,
  },
] as const satisfies readonly Migration[]

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  for (const migration of MIGRATIONS) {
    const applied = db.query<{ version: number }, [number]>(
      "SELECT version FROM schema_migrations WHERE version = ?",
    ).get(migration.version)
    if (applied !== null) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.query("INSERT INTO schema_migrations(version) VALUES (?)").run(migration.version)
    }).immediate()
  }
}
