> Copied from omo task result st_01a210a2 (ultrabrain advisory, 2026-11-25) so it survives omo's 24 h task TTL.
> SUPERSEDED by the plan's "Run lifecycle (thread model)": section 1 process fields (pid, pgid, procStartedAt, exitCode, signal, runDir), section 2 "Process supervision" and ps-based recovery, section 3 cancel steps 2-3, section 4 auth (bearer /login?t=, SameSite=Strict, loopback-only Host allowlist), and test 20's waiting-loop slot rule. Everything else stands as referenced by the plan.

Ask: an advisory-only detail design for a local daemon that schedules omo sessions and serves a webapp. Wanted: six sections of exact interfaces and edge-case handling, grounded in the cited files. For you: all six sections are below. I edited no files. Claims taken from the files are marked **[G: file]**, things I saw on disk are **[Obs]**, and anything unverified is **[ASSUMPTION]**. Two findings could change the plan:
- **The viewer looks in the wrong place for root sessions.** `readRootDocument` reads `<agentDir>/sessions/<sessionId>.jsonl` **[G: task-store.ts:109]**. On disk the files are actually at `<agentDir>/sessions/--Users-tglenn-src-omo-daemonic--/2026-11-25T02-49-24-620Z_<sessionId>.jsonl` **[Obs]**. So the TUI's main-session transcript is probably empty on this install. That is a viewer follow-up. The daemon must find root sessions by matching `*_<sessionId>.jsonl` inside the folder for the working directory.
- **omo already has a scheduler.** `omo schedule <list|cancel|run>` exists, with a store at `~/.omo/agent/schedule/{pending,runners}` **[Obs]**. I could not inspect it: `omo schedule --help` failed with `senpi rpc host: internal_key_unavailable`. Check it before building, so the two don't overlap. My recommendation is still to schedule inside the daemon, because it needs cross-project caps, loops and the web API.

Now: no task remains. Next: no task remains.

---

## Bottom line

Use one Bun process with one SQLite writer (bun:sqlite, WAL mode, `synchronous=FULL`). An `events` table with a gap-free global `seq` is the only source of truth for entity state, and the SSE stream replays from it. Every run gets its `--session-id` UUID **before** it is spawned, and that ID is on the process command line. This gives three things:
- an idempotent fire key in the database;
- a way to find the process again after a crash, by searching the process table for that UUID;
- a known session file path.

Together these make "decided to fire, then crashed" safe. Transcripts stay on disk where omo writes them. The daemon only projects them incrementally and pushes revisioned deltas that are not stored.

**Effort: Large** (about 2-3 weeks). Suggested order: scheduler and run engine (Medium), then API and event ledger (Short), then the transcript projector (Medium), then loops (Short).

## Action plan

1. Build the SQLite schema, the state machines and the event ledger, with an injectable `Clock`, `Spawner`, `ProcTable` and `Fs`.
2. Build the scheduler tick and dispatcher, with fire keys and crash failpoints.
3. Build the run supervisor: process group, exit file, timeouts, and adopting processes that survived a restart.
4. Build the HTTP API and the SSE stream (catch-up, reset, overflow).
5. Build the projector: byte cursors, partial-line carry, rotation detection, turn byte ranges, todo tracking.
6. Build loops: done checks, budgets, backoff, and cancelling everything a run started.

---

## 1. Data model and state machines

```ts
type Ulid = string; type Ms = number /* UTC epoch ms */; type Iso = string

interface Project {
  id: Ulid; name: string
  cwd: string                 // realpath.native, same canonicalization as resolveTaskStateDir [G: task-store.ts]
  agentDir: string            // resolveAgentDir(): OMO_/SENPI_/PI_CODING_AGENT_DIR or ~/.omo/agent [G]
  stateDir: string            // derived once with resolveTaskStateDir(cwd) and re-checked on start
  maxRunning: number          // default 1
  state: "active" | "archived"
  revision: number; createdAt: Iso; updatedAt: Iso
}

interface RunSpec {           // what one spawned omo session runs
  prompt: string              // <= 1 MiB (same as the thread send cap) [G: omo-thread.md]
  model?: string; thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"
  permissionPreset?: "full-access"|"workspace"|"accept-edits"|"auto"|"read-only"
  extraArgs?: string[]        // allowlisted flags only, validated at the API boundary
  timeoutMs: number           // default 2h, hard max 24h
  nameTemplate?: string       // -> --name, e.g. "{schedule} · {slotLocal}"
}

interface Schedule {
  id: Ulid; projectId: Ulid; name: string
  trigger:
    | { kind: "cron"; expr: string; tz: string }               // 5-field, IANA tz
    | { kind: "once"; at: Iso }
    | { kind: "interval"; everyMs: number; anchorAt: Iso }     // everyMs >= 60_000
  target: { kind: "run"; spec: RunSpec } | { kind: "loop"; template: LoopTemplate }
  overlap: "skip" | "queue" | "parallel"; queueMax: number     // queue default 1
  misfire: "skip" | "fire_once" | "fire_all"; misfireGraceMs: number; maxCatchup: number
  endAt?: Iso; maxFires?: number; fireCount: number
  state: "active" | "paused" | "completed" | "errored"; errorReason?: string
  nextFireAt: Ms | null       // next slot not yet decided
  lastSlotAt: Ms | null       // newest slot already decided (fired or skipped)
  revision: number; deletedAt?: Iso
}

interface LoopTemplate {
  spec: RunSpec
  doneWhen: DonePredicate[]   // any of these -> done
  maxIterations: number       // required, 1..100
  maxWallMs?: number; maxConsecutiveFailures: number   // default 3
  cadenceMs: number           // pause after a clean "not done" iteration, default 0
  backoff: { initialMs: number; factor: number; maxMs: number }   // after failed iterations
  sessionMode: "fresh" | "continue"
  carryForwardBytes: number   // for fresh mode: last assistant text injected into next prompt, default 8 KiB
}
type DonePredicate =
  | { kind: "marker" }                                    // nonce-bound sentinel, see section 3
  | { kind: "goal" }                                      // .omo/goal/<sessionId>.json [G: features.md:368]
  | { kind: "check"; command: string[]; timeoutMs: number } // exit 0 = done

interface Loop extends LoopTemplate {
  id: Ulid; projectId: Ulid; scheduleId?: Ulid; fireKey: string; nonce: string
  state: "pending"|"running"|"waiting"|"cancelling"|"succeeded"|"blocked"|"exhausted"|"failed"|"cancelled"
  iteration: number; consecutiveFailures: number
  nextIterationAt: Ms | null; activeRunId?: Ulid; evaluatedRunId?: Ulid
  startedAt?: Iso; endedAt?: Iso; stopReason?: string; revision: number
}

interface Run {
  id: Ulid; projectId: Ulid; scheduleId?: Ulid; loopId?: Ulid; iteration?: number
  fireKey: string; attempt: number              // UNIQUE(fire_key, attempt)
  slotAt?: Ms                                   // schedule slot this run serves
  sessionId: string                             // UUIDv7, set when the row is created
  name: string; argv: string[]                  // frozen when the run enters spawning
  state: "queued"|"spawning"|"running"|"cancelling"|"succeeded"|"failed"|"cancelled"|"timed_out"|"lost"|"skipped"
  reason?: string   // skipped: overlap|queue_full|stale ; failed: exit_nonzero|spawn_failed|signal ; lost: pid_gone|orphan_session
  cancelRequested: boolean; cancelReason?: "user"|"timeout"|"loop_cancel"|"shutdown"
  pid?: number; pgid?: number; procStartedAt?: string   // lstart, guards against pid reuse
  exitCode?: number; signal?: string
  runDir: string     // <daemonDir>/runs/<id>/{stdout.jsonl,stderr.log,exit}
  expiresAt?: Ms     // a queued run older than this becomes skipped/stale
  createdAt: Iso; spawnedAt?: Iso; endedAt?: Iso; revision: number
}
```

Fire keys are `sched:<scheduleId>:<slotMs>`, `loop:<loopId>:<iteration>`, and `adhoc:<Idempotency-Key | ulid>`. A retry reuses the fire key with `attempt+1` and a **new** sessionId.

### Run transitions (the only legal ones)

| From | To | Trigger |
|---|---|---|
| (new) | queued | slot fired, ad-hoc POST, or loop iteration |
| (new) | skipped | overlap=skip, or overlap=queue with queue full (row still written so the fire key is used up) |
| queued | spawning | dispatcher, caps allow; argv frozen; **committed before spawn** |
| queued | cancelled | cancel |
| queued | skipped(stale) | `now > expiresAt` |
| spawning | running | spawn ok and pid/pgid/lstart committed; or recovery found the process by argv |
| spawning | failed(spawn_failed) | spawn threw (ENOENT, EACCES) |
| spawning | queued | recovery: no process **and** no session file (never really started) |
| spawning | lost(orphan_session) | recovery: session file exists, no process |
| running | succeeded / failed | exit file says 0 / nonzero, or child died from a signal we did not send |
| running | cancelling | `cancelRequested` (user, timeout, loop cancel, shutdown) |
| running | lost(pid_gone) | recovery: pid gone (or lstart differs) and no exit file |
| cancelling | cancelled / timed_out | process group gone (`cancelReason` decides which); exit code still recorded |

Terminal states: `succeeded, failed, cancelled, timed_out, lost, skipped`. If cancel arrives while the run is `spawning`, the flag is set and the run moves straight to `cancelling` when it reaches `running`. Once a run is `cancelling`, it always ends `cancelled` or `timed_out`, even if the process exited 0 at the same moment. That rule keeps the outcome deterministic.

### Loop transitions

- `pending` → `running`: create iteration 1.
- `running` → one of:
  - `succeeded` if a done check is true;
  - `blocked` if the marker says BLOCKED or the goal status is `blocked`;
  - `exhausted` if `iteration == maxIterations` or the wall budget is spent;
  - `failed` if `consecutiveFailures >= max`;
  - otherwise `waiting`, with `nextIterationAt` set.
- `waiting` → `running` when `nextIterationAt <= now` and caps allow.
- `waiting` → `exhausted` if the wall budget runs out while waiting.
- `running` → `cancelling` → `cancelled` once the active run is terminal.
- `waiting` or `pending` → `cancelled` directly.

Evaluating the done checks is idempotent through `evaluatedRunId`. After a restart, a `running` loop whose run is already terminal is re-evaluated exactly once.

### Schedule transitions

| From | To | Trigger |
|---|---|---|
| active | paused | user |
| paused | active | `nextFireAt = firstSlotAfter(now)`; **no backfill** |
| active | completed | `once` fired, `endAt` passed, or `maxFires` reached |
| active | errored | no next slot within 5 years, or invalid tz/expression |
| errored | active | PATCH fixes it |
| any | deleted | soft delete; active runs keep running unless `?cancelRuns=true` |

A PATCH bumps `revision` and sets `nextFireAt = firstSlotAfter(max(now, lastSlotAt))`. A slot that was already decided is never decided again, because the fire key is unique.

### Project transitions

`active` → `archived` returns 409 `state_conflict` while nonterminal runs exist, unless `force=true`, which cancels them.

### Tables

`projects`, `schedules`, `loops`, `runs` hold one row per entity. The full record goes in a `json` column, and the indexed fields are also stored as their own columns.

- `events(seq INTEGER PRIMARY KEY, at, type, entity_kind, entity_id, project_id, data)`. Do not use AUTOINCREMENT. With a single writer and rollback-safe inserts the sequence stays gap-free.
- `idempotency(key PRIMARY KEY, request_hash, response, expires_at)`, kept 24h.
- `meta(incarnation)`.

**Every state change and its event row are written in one transaction.** Events are broadcast only after commit, as in mass-ulw ("no pre-durability emission") **[G: mass-ulw-protocol.md]**.

---

## 2. Scheduler semantics

**Clock and tick.** `interface Clock { now(): Ms; setTimer(at: Ms, fn): Handle; clearTimer(h) }`. The scheduler is a function `tick(now)`. The timer is armed for `min(nextFireAt, nextIterationAt, queued expiry)`, **capped at 30s**.
- **[ASSUMPTION]** Bun/libuv timers on macOS use a monotonic clock that pauses during system sleep. A long timer would then fire hours late after the laptop wakes. The cap bounds that delay.
- Each tick also compares how far the wall clock and the monotonic clock moved since the last tick. A jump of more than 5s is logged as `daemon.clock_jump` and handled the same way as a misfire.

**Slot computation.**
- `interval`: slots are `anchorAt + k·everyMs` in UTC. Timezones and DST do not apply.
- `once`: one slot.
- `cron`: expanded in the schedule's `tz`. Use `croner`, or Temporal if Bun 1.4 ships it **[ASSUMPTION]**. Whichever library you use, these DST rules must hold, and the tests pin them:
  - **Spring-forward gap.** For a fixed-hour field that names a time that does not exist (02:30 on spring-forward day), fire **once at the first valid instant after the gap** (03:00). Never skip the day.
  - **Fall-back repeat.** A fixed-hour field fires **once, on the first occurrence**. A wildcard or stepped hour (`*/15 * * * *`, `0 * * * *`) fires on every real instant that matches, so the repeated hour fires twice. This is Vixie cron's rule: wildcard schedules behave like intervals.
  - `GET /schedules/:id/preview?count=N` returns `{at, local, offset, dstNote?: "gap_shifted"|"repeat_first"|"repeat_both"}` so the UI can show these cases.

**Missed slots (sleep or restart).** At each tick, for every schedule with `nextFireAt <= now`, list the missed slots `S` from `nextFireAt` to `now`. Lateness is `now − slot`.

| Policy | Behaviour | Default for |
|---|---|---|
| `skip` | Fire only the newest slot, and only if its lateness ≤ grace (default 60s). Every other slot is recorded as skipped. | — |
| `fire_once` | Merge all missed slots into **one** fire, keyed by the **newest** missed slot, if its lateness ≤ grace. Otherwise skip. | cron and interval (grace 1h), once (grace 24h) |
| `fire_all` | Fire each missed slot, oldest first, up to `maxCatchup` (default 10). Slots past the cap are skipped. The overlap policy still applies. | — |

Skipped slots are **not** stored as Run rows, which avoids thousands of rows after a week asleep. Instead, record one event: `schedule.slots_skipped {count, firstSlot, lastSlot, reason: "misfire"|"paused"|"cap"}`. Then set `lastSlotAt` to the newest slot considered and `nextFireAt` to the first slot after `now`.

**Idempotent fire (decide, commit, then spawn).**
1. **Transaction 1 (decide).** `BEGIN IMMEDIATE`. Insert the Run (or the Loop plus its first Run) with `fire_key` and `sessionId = uuidv7()`, as `INSERT ... ON CONFLICT(fire_key, attempt) DO NOTHING`. Advance `nextFireAt`/`lastSlotAt`/`fireCount`. Append the events. `COMMIT`.
2. **Transaction 2 (spawn intent).** `queued → spawning` and freeze `argv`. The argv is `omo -p --mode json --session-id <uuid> --name <name> [--model …] <prompt>`, run under the wrapper described below. Commit.
3. Spawn. Then **transaction 3** writes pid, pgid, lstart and `running`.

Crash recovery depends only on what was committed:
- **Crash after step 1.** The run is `queued`, so it is dispatched normally. No duplicate is possible because the slot was already advanced and the key is unique.
- **Crash after step 2, before or after the spawn.** The run is `spawning`. Run `ps -axo pid=,lstart=,command=`. A process whose command line contains `--session-id <uuid>` means **adopt it** (`running`). No process but a session file `*_<uuid>.jsonl` in the project's session folder means `lost(orphan_session)`, and it is **never respawned automatically**. `--session-id` "creat[es] it if missing" **[G: omo --help]**, so a respawn would add to that session's transcript instead of duplicating it. Retrying gives a new session through `attempt+1`. Neither process nor file means it never started, so it goes back to `queued`, and the same UUID is safe to reuse.
- **Two ticks in the same millisecond, or a re-entrant tick.** The single writer plus the unique key gives exactly one row.

**Process supervision.** Spawn detached in its own process group, with stdout and stderr going to **files** in `runDir`, not pipes. The child must outlive a daemon crash, and the output must not be lost. To keep the exit code across a daemon crash, wrap the command: `/bin/sh -c '"$@"; echo $? > "$RUN_DIR/exit"' sh omo …`. The shell leads the process group, so killing the group kills both. When the process group is gone, read the exit file:
- the file holds a code: succeeded or failed;
- the file is missing and we sent a signal: cancelled or timed_out;
- the file is missing and we did not: lost.

Before trusting a stored pid, check its `lstart` to rule out pid reuse.

**Overlap** is checked per schedule. "Active" means nonterminal runs, plus loops for loop targets, belonging to that schedule.
- `skip` writes a `skipped(overlap)` row.
- `queue` writes a `queued` row with `expiresAt = slot + max(period, 1h)`. Once more than `queueMax` are queued, new ones become `skipped(queue_full)`.
- `parallel` dispatches subject to the caps.

**Concurrency caps.** A global `maxRunning` (default 3; this is a laptop) and a per-project `Project.maxRunning` (default 1). They count runs that are `spawning`, `running` or `cancelling`, plus loops that are `waiting`. A waiting loop holds a slot, so it does not lose its turn mid-sequence. **[Recommendation]** That is configurable; the default is that it holds the slot. The dispatcher round-robins across projects, then takes the oldest `slotAt`/`createdAt` first. Caps never block the *decision* (step 1), only the dispatch.

**Timeouts.** At `spawnedAt + timeoutMs`, set `cancelRequested` with `cancelReason="timeout"`. Then escalate exactly as for cancellation (section 3).

**One daemon at a time.** Binding `<daemonDir>/daemon.sock` (a Unix socket) is the lock. If the bind fails with EADDRINUSE and a connect succeeds, exit with "already running". If the connect fails, the socket is stale: unlink it and retry. A new `meta.incarnation` value is written on every start.

---

## 3. Loop semantics

**Order of checks after each iteration.** Explicit cancel, then hard budgets, then the done checks, then the failure policy.

**How a loop decides it is done** (any check in `doneWhen` can end it):
- **Exit status is not a done signal.** `omo -p` exits 0 whenever the prompt finishes. Exit status, timeout or lost only classify an iteration as **failed**, which feeds backoff and `consecutiveFailures`.
- **`check`** is the most reliable option and the one to recommend: an external test in the project directory, for example `bun test`. Exit 0 means done. It runs after the run reaches a terminal state, with its own timeout and its output captured.
- **`marker`.** The prompt gets a per-loop `nonce` appended, plus the instruction to end with a line `LOOP_DONE <nonce>`, `LOOP_CONTINUE <nonce>` or `LOOP_BLOCKED <nonce>: <reason>`. Only a whole line in the **text parts of the last assistant turn** of that iteration's session counts. To find that turn, parse the session file with the grounded parser (`parseSessionTurns`: one assistant `message` entry is one turn) **[G: transcript.ts]**. Quoting the prompt or saying it in an earlier turn does not count, and no marker means continue.
- **`goal`.** Read `<project>/.omo/goal/<sessionId>.json` **[G: features.md:368]**. `complete` means done; `blocked` means blocked. **[ASSUMPTION]** the field names (`status`). Also unverified: whether goal continuation runs at all in `-p` mode, since it is driven by `session.idle` **[G: features.md:365]**.
- **[ASSUMPTION]** The `--mode json` stdout event schema is undocumented. I found no match in docs/. Use the captured stdout only for liveness and diagnostics until the schema is verified. The session file is the authority.

**Session mode.**
- `fresh` (default): a new UUID for each iteration, and up to `carryForwardBytes` of the previous final assistant text is prepended as "Previous iteration ended with: …".
- `continue`: reuse the same `--session-id`, which continues the existing session. Context keeps growing and compaction happens inside omo.

**Budgets.** `maxIterations` is required, with a hard cap of 100. Also `maxWallMs` and `maxConsecutiveFailures`. Token budgets cannot be enforced from outside; leave them out of v1.

**Backoff.**
- After a failed iteration: `delay = min(maxMs, initialMs·factor^(consecutiveFailures−1))`, with full jitter from an **injectable seeded RNG**.
- After a clean iteration that is not done: `cadenceMs`.
- `nextIterationAt` is stored, so it survives a restart. A loop that missed its time while the laptop slept simply runs at the next tick; loops do not use the misfire policy.

**Cancellation, which must reach everything the run started:**
1. The Loop goes to `cancelling` and the active Run gets `cancelRequested` with reason `loop_cancel`. A run that is still queued is cancelled immediately.
2. Signal the run's process group: SIGINT, then SIGTERM after 10s, then SIGKILL after 10s. All timing uses the injected `Clock`. **[ASSUMPTION]** omo `-p` treats SIGINT as "abort the turn and shut down cleanly".
3. **Children in another process.** Process-mode task children run on a per-session task host, `<shardRoot>/p-<sha256("p:"+rootSessionId)[:16]>.sock` **[G: omo-daemon.md]**, which is outside our process group. After the root process exits:
   - List `<stateDir>/tasks/*.json` with `root_session_id == run.sessionId` and a non-terminal status. The decoder is in **[G: state.ts]**.
   - If there are any, resolve the socket with `senpi host shard-path --kind p --owner <sessionId>` **[G: omo-daemon.md]** and stop that host with `omo host stop` targeted at that socket. **[ASSUMPTION]** the exact flag (`--socket`); verify it.
   - Fallback: the host's idle exit after 15 minutes **[G: omo-daemon.md]**.
   - In-process children die with the root process.
4. The Run ends `cancelled` and the Loop ends `cancelled`. Cancel is idempotent: cancelling something already terminal returns 200 with `{alreadyTerminal: true}`.

---

## 4. HTTP + SSE API

The server listens on `127.0.0.1:<port>` only. Requests must carry `Host: 127.0.0.1|localhost` and a same-origin `Origin`, which blocks DNS rebinding and CSRF. Auth is a bearer token kept in `<daemonDir>/token` (mode 0600). The webapp gets a `SameSite=Strict` HttpOnly cookie through a one-time `/login?t=<token>` link that the CLI prints.

Every path is under `/api/v1`. Errors look like `{ error: { code, message, details? } }`, with these codes:

| Code | HTTP status |
|---|---|
| `invalid_arguments` | 400 |
| `not_found` | 404 |
| `revision_conflict` | 409 |
| `state_conflict` | 409 |
| `idempotency_conflict` | 422 |
| `internal` | 500 |

Mutations accept an `Idempotency-Key` header and a `revision` field in the body (optimistic concurrency).

```
GET    /health                                   → {version, incarnation, headSeq, clockSkewMs}
GET    /projects                 POST /projects
GET|PATCH|DELETE /projects/:id   POST /projects/:id/archive?force
GET    /projects/:id/schedules   POST /projects/:id/schedules
GET|PATCH|DELETE /schedules/:id  POST /schedules/:id/pause | /resume | /fire   (fire: key adhoc:<idem>)
GET    /schedules/:id/preview?count=10
GET    /loops?projectId&state    POST /projects/:id/loops   GET /loops/:id   POST /loops/:id/cancel
GET    /runs?projectId&scheduleId&loopId&state&cursor&limit   POST /projects/:id/runs
GET    /runs/:id                 POST /runs/:id/cancel   POST /runs/:id/retry
GET    /runs/:id/doc?beforeTurn=<turnId>&limit=50   → DocSnapshot (root session)
GET    /runs/:id/turns/:turnId                     → full TurnBody (range read, see section 5)
GET    /runs/:id/tasks                             → TaskTreeItem[] (projectTaskTree parity)
GET    /tasks/:projectId/:taskId/doc               → DocSnapshot (child)
GET    /images/:sha256                             → bytes (decoded and cached by content hash)
GET    /events?since=<seq>&limit=<=1000            → {events, nextSince, headSeq, hasMore}
GET    /stream?since=<seq>  (SSE; Last-Event-ID wins over ?since)
POST   /stream/:streamId/docs   {docId, epoch?, rev?}  /  DELETE /stream/:streamId/docs/:docId
```

List responses are `{ items, nextCursor?, headSeq }`. `headSeq` is read **in the same read transaction**, so the client loads a snapshot and then opens the stream with `since=headSeq`. That pairing has no gap.

**SSE frames.** There are two lanes, mirroring `omo.dag.event` versus activity **[G: mass-ulw-protocol.md]**:

```
id: 1234
event: entity
data: {"schemaVersion":1,"seq":1234,"at":"…","type":"run.state_changed",
       "entity":{"kind":"run","id":"…","revision":7},"projectId":"…",
       "data":{"from":"spawning","to":"running","reason":null,"snapshot":{…Run}}}

event: doc                      ← NO id: line, so it does not move Last-Event-ID
data: {"docId":"run:<id>","epoch":3,"fromRev":41,"toRev":42,"ops":[…]}

event: hello  data: {"streamId":"…","headSeq":1234,"incarnation":"…"}
event: heartbeat data: {"headSeq":1234}          (every 15s)
event: reset  data: {"reason":"cursor_expired"|"incarnation_changed","headSeq":…}
```

Entity events carry the full post-change snapshot, so applying one is a replace and never needs a merge. Event types:
- `project.upserted|archived`
- `schedule.upserted|deleted|slots_skipped|fired`
- `loop.state_changed|iteration_started`
- `run.state_changed`
- `daemon.started|clock_jump`

**Gap-free resume.** The server does the catch-up, so a client only has to track the last seq. This adapts the mass-ulw steps 1-6.
1. Attach a subscriber buffer to the in-process broadcaster **first**.
2. Read `highWater = MAX(seq)`.
3. If `since < minRetainedSeq`, send `reset` and close.
4. Otherwise send pages `since < seq <= highWater`.
5. Drain the buffer, dropping anything with `seq <= highWater`.
6. Go live.

The client checks that `seq == last+1`. If it does not, it closes and reconnects; `EventSource` sends `Last-Event-ID` automatically. The SSE spec only updates the last-event-ID buffer when an `id:` field is present, so `doc` frames without one do not disturb resume.

**Slow consumers.** Each subscriber's queue holds at most 1000 frames or 1 MiB. On overflow, the server **closes** the stream after the last fully sent entity event, and the client's automatic reconnect resumes from it. No overflow event is needed.

**Retention.** Keep events for 30 days or 100k rows, whichever is larger. A `reset` tells the client to reload its lists and reconnect from `headSeq`.

**Why one stream.** Browsers allow 6 HTTP/1.1 connections per origin, and SSE connections count toward that. **[ASSUMPTION]** Bun.serve has no plain-HTTP h2. So keep **one** stream, and subscribe to documents through `POST /stream/:streamId/docs`. On reconnect the client sends its subscriptions again with `{epoch, rev}`.

---

## 5. Observation model (parity with omo-agents)

**What the reader does today [G: task-store.ts, transcript.ts, state.ts, ADR 0001; plus Obs]:**
- **Task records.** Read from `<stateDir>/tasks/*.json`; records over 256 KiB are counted as invalid; `decodeTaskRecord` needs `task_id` and `parent_session_id`, and `root_session_id` falls back to the parent.
- **stateDir.** The legacy `<project>/.omo/senpi-task` is used if it has records or `.in-project`. Otherwise it is `<agentDir>/projects/<name>-<sha256(realpath)[:12]>/senpi-task`. **[Obs]** For this project: `…/projects/omo-daemonic-ede7f2a3450b/senpi-task/{tasks,logs,children,locks,drafts}`.
- **Child transcripts.** `<stateDir>/children/<id>/sessions/<id>/*.jsonl`, sorted by name. With more than 2 files, only the first and last are read. A file is created per resume.
- **Event log.** `<stateDir>/logs/<id>.jsonl` with `{type,payload}` lines: `assistant_message`, `tool_execution`, `child_error`, and **[Obs]** `transition_applied`. It is the fallback document when there is no session text, and `child_error` lines are appended as errors.
- **Session entries [Obs].** A `session` header (`version:3, id, cwd`), then `model_change`, `thinking_level_change`, `custom` (114 of 160 entries in one sample), `custom_message`, and `message` with role `user`, `assistant` or `toolResult`. The parser keeps only assistant and toolResult messages.
- **Turns.** One assistant message is one turn. A toolResult attaches by `toolCallId` to the turn that made the call, or to the current turn if it is not found.
- **Turn id.** `entry.id`, else `entry.timestamp`, else `turn-<windowIndex>`, which is unstable.
- **Tail reads.** The last 4 MiB (configurable from 64 KiB to 64 MiB). If the read did not start at the beginning of the file, the first partial line is dropped. A trailing line with no newline is dropped (held back).
- **Todos.** The *last* `todo` toolResult that parses with `parseTodoReport` (`Overall: d/t done, o open`, `Now:`, `Next:`, `Active phase`, `Remaining items (n):`, two-space phase headers, four-space `- [ ]/[X]` items with `(in progress)`). Todo results are hidden from the transcript lines.
- **Images.** Stay base64 inside entries and are decoded only when the turn is expanded, cached by hash.
- **Status buckets.** `completed`; `running` and `pending`; `paused`, `interrupted` and `cancelled` (stopped); `error` and `lost` are failures **[G: viewer-model.ts:267-269,982-986]**.

**Projector design.** It reads incrementally and never re-reads the 4 MiB tail on each refresh.

```ts
interface FileCursor { path: string; dev: number; ino: number; offset: number /* end of last complete line */
                       carry: Uint8Array /* partial-line bytes */; headSig: string /* sha256 of first line */ }
interface DocState { docId: string; epoch: number; rev: number; files: FileCursor[]
                     turns: TurnSummary[] /* last 500 */; hasOlder: boolean; todo?: TodoState; errors: string[]
                     callIndex: Map<string, string /* turnId */> }   // evicted together with turns
interface TurnSummary { id: string; file: string; byteStart: number; byteEnd: number
                        summary: string /* summarizeTurn */; lines: string[] /* formatSessionTranscript */
                        calls: {id?: string; name: string}[]; results: {callId?: string; name?: string; isError: boolean; preview: string; images: {sha256: string; mimeType: string}[]}[] }
type DocOp = | {op:"turn.add"; turn: TurnSummary} | {op:"turn.patch"; turnId: string; results: TurnSummary["results"]; byteEnd: number}
             | {op:"todo.set"; todo: TodoState | null} | {op:"error.add"; text: string} | {op:"reset"; reason: "rotated"|"truncated"|"missing"|"window"}
```

**Reading:**
- **Bootstrap.** Same window as ADR 0001: read the last 4 MiB, aligned to the next newline, and set `offset = size` and `hasOlder = start > 0`.
- **Incremental reads.** Read `[offset, size)` in chunks of at most 1 MiB. Split on byte `0x0A` *before* decoding UTF-8; that is safe because UTF-8 never uses 0x0A inside a multibyte character. The final fragment goes to `carry`, which is the same hold-back rule as `readTail`, applied across reads.
- **Oversized lines.** If `carry` grows past 16 MiB, drop it and skip to the next newline, counting `oversizedLines`.

**Rotation and disappearance:**
- A changed `ino` or `headSig` means `reset(rotated)`; `size < offset` means `reset(truncated)`.
- ENOENT means `reset(missing)`. Keep the last model, mark it `gone`, and keep polling.
- Every reset bumps `epoch`, rebuilds the document, and clears the delta ring.
- For child tasks, a new `*.jsonl` file appearing in the session folder adds a cursor, keeping the first+last-file rule.

**Turn identity.** Use `entry.id`, then `entry.timestamp`, the same as the viewer. In place of the window-relative `turn-N`, use **`off:<file>:<byteStart>`**, which stays stable for the life of the file's inode. When the same id appears in two files of a resumed task, key turns by `<file>#<id>`. **[ASSUMPTION]** that ids are unique per session file.

**Deltas:**
- A new assistant entry produces `turn.add`.
- A toolResult for a known call produces `turn.patch`, appending the result and moving `byteEnd`. One that cannot be matched attaches to the current turn, which matches the viewer.
- A new `todo` result that parses produces `todo.set`.
- Each batch is one `doc` frame `{fromRev, toRev}`. The server keeps the last 256 deltas per document.
- On (re)subscribe: if `epoch` matches and `rev` is within the ring, replay the missing deltas. Otherwise send a full `DocSnapshot {epoch, rev, turns(last 50), hasOlder, todo}`.

**Expanding a turn.** Expanded bodies are never cached. `GET /turns/:id` reads exactly `[byteStart, byteEnd)` and runs `parseSessionTurns` and `formatTurnBody` on it. `GET /doc?beforeTurn=` reads backwards from the oldest `byteStart` to page older turns. This removes ADR 0001's limitation that "turn selection is exact only within the window".

**Watching and caching:**
- `fs.watch` on directories is only a hint, because FSEvents coalesces events. Docs with subscribers or a running run are polled with `stat` every 1s; others every 10s. An unchanged file costs one `stat`.
- Keep an LRU of 32 open documents. Evict after 5 minutes with no subscribers, unless the run is active.
- Project task trees: a `tasks/` watcher plus a re-read of only the files whose size or mtime changed. Changes go out as a `doc` stream `project:<id>:tasks` (snapshot plus `task.upsert/remove` ops). Runs link to tasks through `root_session_id == run.sessionId`.

**Code reuse.** Extract `transcript.ts` (parser, formatting, `parseTodoReport`, `safeText`) into a package shared by the viewer and the daemon. Keep the ADR's rule that the readers never import upstream omo code. Golden fixtures should run against both.

---

## 6. Must-have tests

Everything is injected: a `FakeClock` (`advance(ms)` fires due timers synchronously), a `FakeSpawner` (records argv, controllable pid/exit, `crashAfter`), a `FakeProcTable`, `:memory:` SQLite, named crash failpoints (`afterDecideCommit`, `afterSpawningCommit`, `afterSpawnBeforePid`), a seeded RNG, and a temp directory with an explicit `projector.poll()`. There are no watchers and no sleeps anywhere.

**Scheduler and DST**
1. Cron in America/Los_Angeles and Europe/London across spring-forward: 02:30 fires once at 03:00.
2. Fall-back: fixed-hour `30 1 * * *` fires once; `*/15 * * * *` fires in both copies of the repeated hour.
3. An interval schedule ignores DST.
4. `preview` returns the right `dstNote` values.
5. A clock jump of 8h in one `advance`, for each misfire policy: `fire_once` makes exactly one run keyed to the newest slot; `skip` makes zero runs and one `slots_skipped` event with the right count; `fire_all` respects `maxCatchup`.
6. The grace boundary: lateness == grace fires, grace+1 skips.
7. A `once` schedule in the past at creation, and one missed while asleep beyond its 24h grace.
8. Pause and resume do not backfill.
9. A PATCH on the slot just fired does not fire it again.
10. Calling `tick(now)` twice at the same time makes one run.

**Idempotency and recovery**
11. For each failpoint, crash, restart and recover: the spawner is called exactly once for that fire key.
12. A `spawning` run whose sessionId appears in a fake process's argv is adopted with no spawn.
13. Session file present and no process: `lost(orphan_session)` with no respawn.
14. Neither present: back to queued, then spawned once with the **same** UUID.
15. A stored pid whose `lstart` does not match counts as gone.
16. Exit-file outcomes: code 0, code 1, missing with our signal, missing without.

**Overlap and caps**
17. `skip`, `queue` (with `queueMax` and stale expiry) and `parallel`.
18. Global and per-project caps.
19. Round-robin fairness across projects.
20. A `waiting` loop holds its slot.

**State machines**
21. Table-driven check that every illegal transition is rejected, for Run, Loop, Schedule and Project.
22. Cancel during `spawning`.
23. Cancel of a terminal run is a no-op.
24. Timeout escalates SIGINT, then TERM at +10s, then KILL at +20s, on the fake clock.
25. Once `cancelling`, an exit of 0 still ends `cancelled`.

**Loops**
26. The marker counts only in the final assistant turn. A marker quoted in the prompt or an earlier turn is ignored, and a wrong nonce is ignored.
27. Goal file `complete` gives succeeded; `blocked` gives blocked.
28. `check` exit 0 or 1.
29. `maxIterations` gives exhausted; the wall budget gives exhausted.
30. The backoff sequence with seeded jitter.
31. `consecutiveFailures` reaching the cap gives failed.
32. `nextIterationAt` survives a restart.
33. `evaluatedRunId` prevents evaluating the same run twice after a restart.
34. Cancel reaches the active run's process group **and** calls the shard-host stop when child task records are non-terminal.

**Ledger and SSE**
35. A rolled-back transaction emits nothing.
36. Events are gap-free and ordered.
37. Resume with events appended *during* the catch-up page (the buffer race) gives no gap and no duplicate.
38. A cursor below retention gives `reset`.
39. Overflow closes the stream, and resuming from the last id is complete.
40. `doc` frames carry no `id`.
41. A list's `headSeq` plus `stream?since` has no gap.

**Projector parity**
42. A line split across two appends.
43. A multibyte character split at a chunk boundary.
44. A trailing partial line is held back until its newline arrives.
45. Truncation gives `reset(truncated)`; an inode swap gives `reset(rotated)`; deletion gives `gone`.
46. A second session file for a resumed task, with the first+last rule.
47. An orphan toolResult attaches to the current turn.
48. Fallback turn ids stay stable across polls.
49. Todo extraction comes from the last parseable `todo` result: the exact `parseTodoReport` fixtures, shared with omo-agent-viewer.
50. A range-read turn body equals the same turn from a full parse.
51. 4 MiB bootstrap alignment.
52. An oversized line is skipped.
53. `rev`/`epoch` replay from the ring, versus a snapshot when out of range.
54. Root-session resolution finds `--<cwd>--/<ts>_<id>.jsonl`. This is the case the viewer gets wrong.

**API**
55. 409 on a revision conflict.
56. Replaying an `Idempotency-Key` returns the first response; a reused key with different arguments gives 422.
57. A foreign `Origin` or `Host` is rejected.
58. `extraArgs` outside the allowlist gives 400.

---

## Risks and mitigations

- **The `-p` behaviour is not verified.** That covers SIGINT handling, the JSON event schema, goal continuation and the UUID format required by `--session-id`. Before the run engine, spend half a day on a spike that launches one real session, then pin the observed behaviour with fixtures.
- **Children on the shard host outlive the cancel.** The task-record check plus a host stop handles it, with idle exit as the backstop. Surface `orphanChildren` on the Run until they are gone.
- **Duplicated work with `omo schedule`.** Read its store format first. If it already guarantees missed-fire handling and durability, consider making it the trigger and keeping the daemon as dispatcher and observer.
- **Coupling to the viewer's file layout.** The task-store layout is already the integration contract, per ADR 0001. A shared parser package with golden fixtures detects drift in both tools at once.