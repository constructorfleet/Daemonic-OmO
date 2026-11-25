---
slug: omo-daemonic
status: review_unavailable_after_ulw-execute
intent: clear
review_required: true
plan_path: .omo/plans/omo-daemonic.md
plan_sha256: 425c02043b2a0d12d1c96c7458ecb3cadb91d8dbacf0307fa81c3abdb5f5d349
review_round_id: r6-20261125-t6proof
review_round_limit: 6
pending-action: final F1/gate reviewer must audit execution amendment
review:
  plan_reviewer:
    status: inconclusive
    workspace_root: /Users/tglenn/src/omo-daemonic
    runtime_home: null
    target: .omo/plans/omo-daemonic.md
    round_id: r6-20261125-t6proof
    plan_sha256: 20602bfe7811ff260a525a7025d2bfa816b2656ca213f454673e305a2075be3a
    launch_id: l6-t6proof
    session: null
    result: "Round r6 plan-reviewer dispatch was refused because ulw-execute is active; no session/review receipt. Attempted snapshot SHA 20602bfe...05be3a. Previously recorded plan SHA 2bc49067...8026c6; previous plan SHA 0be2263a...0ada87 added Todo 14 Project.settings persistence; previous plan SHA a7c475bd...a12b242 made Todo 13 depend on Todo 14; current SHA 3122da11...f62291 adds legacy Project-row and historical SSE snapshot normalization. Final F1/execution gate reviewer must audit all execution amendments."
approach: Bun workspace monorepo (store, tui, daemon, web); observer+gateway design - per-user omo operator hosts run agents, daemon controls via thread SDK bridge and reads omo state from disk; own scheduler/loops/runs/audit in SQLite; OIDC multi-user with per-user agent dirs; React+xyflow web UI at omo-agents parity; launchd; TDD + live contract suite
---

# Draft: omo-daemonic

## Affected user and ideal state
<!-- Who this output touches (a customer, another programmer, a program or agent consuming it - often more than one) and how each uses it today and will use it after. -->
<!-- IS-n | property of the ideal state: nothing snags, feels odd, regresses, or degrades for them | reason -->
<!-- GAP-n | difference between IS-n and today | reason | closed by todo(s) -->
Users: U1 Teagan as operator in a browser (primary: manages projects, schedules, loops; watches/steers agents). U2 omo runtime and its other clients (terminal sessions, omo-agents TUI, Desktop, omo thread) - consume the same state and must not be disturbed. U3 agents the daemon spawns - need correct cwd, prompt, model, preset, ancestry. U4 maintainers (Teagan + agents) - one reader codebase, contract tests, upgrade isolation.

IS-1 | one local URL lists every project with its live and past sessions, task trees and DAG runs, updating within ~2 s without manual refresh | omo-agents is one project per terminal
IS-2 | parity: every field/view omo-agents shows (task tree + filters, main session, task heading, transcript kinds, inline turn detail w/ full args + thinking + images, todo pane, event-log errors) for any project incl. dead sessions, with bounded memory (4 MiB tail default, configurable) | explicit request + memory prefs
IS-3 | start an agent in a project (prompt, model, preset, optional worktree), steer it, interrupt/close it; only actions the target supports are offered | spawn request; no task-level external cancel exists
IS-4 | schedules (cron, interval, one-shot) per project fire exactly once per occurrence across crash/sleep/restart, with visible next fire, history, explicit missed-fire + overlap policy | omo schedules are interval-only and session-bound
IS-5 | loops repeat a prompt until a done condition or budget, visible iteration history, cancellable; hard budgets prevent runaway spend | omo caps nothing (omo-daemon.md:177-196)
IS-6 | agent graph view: parent/child task tree as a graph and DAG runs (nodes, edges, waves, states, live activity); clicking a node opens its transcript | explicit request
IS-7 | omo-native scheduled prompts and saved DAG definitions are visible; omo schedules cancellable | same information surface
IS-8 | daemon is always on (launchd), restarting it never kills agents, and it reconciles state on start | agents live in omo hosts
IS-9 | only the local user can drive it (no CSRF/DNS rebinding), every spawn/steer/stop audited, a global kill switch exists | it can run full-access agents
IS-10 | an omo update never silently breaks or corrupts: compatibility probe, visible degraded banner, contract tests | upstream formats are internal
IS-11 | never writes omo internal stores; every mutation goes through omo's own surfaces | upgrade isolation
IS-12 | one store/transcript reader shared with omo-agents, no divergent copy | owner decision pending

GAP-1 no web UI or cross-project view exists -> IS-1
GAP-2 parity logic lives only in the TUI repo -> IS-2, IS-12
GAP-3 no UI to spawn/steer/stop -> IS-3
GAP-4 no cron or new-session schedules -> IS-4
GAP-5 no loop runner outside a session -> IS-5
GAP-6 no graph/DAG visualization outside Desktop -> IS-6
GAP-7 omo schedules and DAG library invisible -> IS-7
GAP-8 no always-on supervisor -> IS-8
GAP-9 no auth/audit surface -> IS-9
GAP-10 no compatibility probe or contract tests -> IS-10

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
C1 omo-port adapter (store readers, gateway bridge to thread SDK/CLI, version probe) | active
C2 observer + projection + SSE event stream | active
C3 control: runs, spawn/steer/stop, audit, kill switch | active
C4 scheduler + loops | active
C5 web UI (projects, sessions/tree, transcript parity, graph + DAG, schedules, loops, audit) | active
C6 ops + security (launchd, token/Host/Origin, CLI install/open/doctor) | active

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
A1 spawn path | thread SDK `create` on the user's operator host (ensured by `OMO_CODING_AGENT_DIR=<dir> omo daemon run`) from an isolated bridge child, idempotency_key = fire key; `omo thread ... --json` CLI fallback for send/read/list/interrupt/close; `omo -p --mode json --session-id` only when the host cannot be ensured | steerable, survives daemon restart, visible to omo thread/Desktop (architect) while keeping ultrabrain's idempotent fire keys | yes
A2 schedule semantics | cron (5-field + IANA tz via croner) / interval (>=60 s) / once; misfire default fire_once (grace 1 h, once 24 h); DST gap shifts forward, fixed-hour repeat fires once; decide->commit->spawn with UNIQUE(fire_key, attempt) | crash/sleep exactly-once (ultrabrain) | yes
A3 loop done | done predicates: check command (exit 0), nonce marker line in last assistant turn, goal status; exit status only classifies failure; session mode fresh by default with 8 KiB carry-forward | exit 0 means 'prompt finished', not 'goal met' | yes
A4 stack | Bun 1.4.4 workspace, strict TS (moduleResolution bundler), Bun.serve REST + one multiplexed SSE stream, bun:sqlite WAL; web = React 19 + Vite + Tailwind 4 + @xyflow/react + TanStack Query, built assets served by the daemon | matches upstream conventions; graph lib purpose-built | yes
A5 OIDC | generic discovery via oauth4webapi: issuer, client id/secret, scopes openid profile email groups, auth code + PKCE; HttpOnly SameSite=Lax session cookie + CSRF header on mutations; Host allowlist; loopback-only break-glass admin token for the CLI | provider-agnostic | yes
A6 process | launchd user agent label `dev.omo-daemonic.daemon`, RunAtLoad + KeepAlive, explicit PATH incl ~/.bun/bin; daemon home ~/.omo-daemonic (config.jsonc, daemon.sqlite, runs/, secrets 0600); default bind 127.0.0.1:8787, configurable for reverse proxy | always-on | yes
A7 omo-native schedules | read-only from <agentDir>/schedule/{pending,firing,failed,cancelled}, cancel via `omo schedule cancel` with that user's agent dir | never write omo stores | yes
A8 DAG view | disk baseline <stateDir>/dag/{runs,events} for all runs incl. terminal; mass-ulw protocol via bridge adds live activity when owner reachable; DAG control is labeled 'message the owning session' (no external workflow control exists) | documented contract + works for dead runs | yes
A9 viewer root-session bug | fixed in packages/store: resolve `*_<sessionId>.jsonl` under the cwd-slug folder | code we are changing | yes

## Findings (cited - path:lines)
- ultrabrain: root session files are `<agentDir>/sessions/--<cwd-slug>--/<iso>_<sessionId>.jsonl` (observed), but viewer readRootDocument reads `<agentDir>/sessions/<sessionId>.jsonl` (omo-agent-viewer src/task-store.ts:109) -> main-session transcript likely empty; fix in packages/store during extraction (code we are changing). Session entry kinds observed: session header (version 3, id, cwd), model_change, thinking_level_change, custom, custom_message, message(user|assistant|toolResult); event log also has transition_applied.
- ultrabrain detail design (scheduler fire keys, pre-assigned session ids, decide/commit/spawn, misfire skip|fire_once|fire_all, overlap skip|queue|parallel, caps global 3 / project 1, loop done predicates marker|goal|check, SSE gap-free resume, incremental projector with byte cursors) saved at ~/.omo/agent/projects/omo-daemonic-ede7f2a3450b/senpi-task/completion-results/st_01a210a2.txt. Conflict with architect: ultrabrain spawns `omo -p --session-id` children supervised by the daemon; architect spawns via thread SDK create on operator host. Resolution pending (planner default: thread SDK primary for interactive/steerable runs; `-p` fallback).
- Workspace /Users/tglenn/src/omo-daemonic is empty and not a git repo (ls, 2026-11-25).
- omo-agents = /Users/tglenn/src/omo-agent-viewer (bin -> dist/main.js), Bun+TS+@opentui/core 0.9.7, read-only. Store discovery: agentDir = --agent-dir > OMO_CODING_AGENT_DIR > SENPI_CODING_AGENT_DIR > PI_CODING_AGENT_DIR > ~/.omo/agent (src/task-store.ts:30-43); store = <agentDir>/projects/<basename>-<sha256(realpath)[:12]>/senpi-task, legacy <project>/.omo/senpi-task (task-store.ts:25-58,120-143). Reads tasks/*.json (<=256 KiB, validated: task_id, parent_session_id required; root_session_id, status, created_at, child_session_id, started_at, terminal_at, name, task_summary, description, category, agent_type, model, depth optional - state.ts:1-40), logs/<id>.jsonl events (assistant_message/tool_execution/child_error - transcript.ts:35-75), children/<id>/sessions/<id>/*.jsonl first+last file, root <agentDir>/sessions/... jsonl; 4 MiB tail default, --read-bytes 64KiB-64MiB, partial-line tolerant; todo parsed from last `todo` toolResult text (transcript.ts:75-160); tree ancestry parent_session_id->child_session_id, depth cap 12 (state.ts:42-90). Shows: main session row + task rows (name fallback chain, status glyph, elapsed), task heading (status/start/elapsed/category/agent_type/model/task_id), transcript (thinking/assistant/tool call/result/error, inline turn expansion with full args, up to 3 images/turn), todo pane (done/total, Now/Next, phases), filters completed/running/stopped. Cannot cancel tasks; README.md:61-65. ADR docs/adr/0001-transcript-reading-and-anchoring.md.
- Task status enum: pending, running, paused, completed, error, cancelled, interrupted, lost (oh-my-openagent packages/senpi-task/src/state/types.ts:38-50).
- Control surfaces (installed omo-ai 5.1.79 / @code-yeongyu/senpi 2026.11.18-3): `omo -p --mode text|json|rpc`, `--session-id`, `--name`, `--spawned-by <json>`, `--headless` (rpc/headless.sock), `--multi-session --listen` (omo --help). `omo daemon run|status --json|stop|gc` ensures operator endpoint <agentDir>/rpc/rpc.sock whose `open_session` is what thread_create calls (docs/reference/omo-daemon.md). `omo thread list|send|read --json` = scripted session gateway, never starts sessions, principal cli:<uid>, steer/follow_up modes, idempotency keys (docs/reference/omo-thread.md). `omo remote open|send|interrupt|close` with --project/--model/--permission-preset/--worktree/--prompt (docs/reference/remote-sessions.md). senpi-task host client uses RpcClient prompt/steer/followUp/abort/closeSession/getState/getEntries/listSessions (packages/senpi-task/src/runners/rpc-host/session-client-connection.ts:87-174) - internal, not a published contract.
- Published npm: only @code-yeongyu/senpi (exports ./client = vendor/pi-client Client/transports/materializer, ./rpc-entry, ...) and omo-ai. All other upstream packages private:true.
- DAG viewer protocol is documented for external viewers: docs/reference/mass-ulw-protocol.md (omo.dag.list/snapshot/history/subscribe request methods; omo.dag.event (seq, WAL) / updated / activity / heartbeat push via pi.rpc.emit; requires SENPI_RPC_CLIENT_CAPABILITIES=extension_events; gap-free catch-up algorithm). DAG persistence <stateDir>/dag/{runs,events,results,keys,locks} (senpi-task/src/dag/store.ts:16-18,59-86); run status pending|running|paused|completed|failed|cancelled, node states pending|blocked|scheduled|running|paused|completed|failed|cancelled|skipped (dag/types.ts:20-51). Saved DAG definitions <name>.json in $OMO_DAG_LIBRARY, $PWD/.omo/dags, ~/.omo/dags (dag-library SKILL.md:14-31).
- omo native schedules: producer tool `schedule_prompt`; consumer `omo schedule run [--watch] [--exec]`; pending/<id>.json with id, sessionId, sessionFile, cwd, dueAt, everyMs, fireCount, prompt; interval-only recurrence, no cron; default delivery resumes the ORIGINATING session (senpi dist/cli/schedule-{command,runner,delivery}.js).
- Teams: specs ~/.omo/teams/<name>/config.json or <project>/.omo/teams; runtime <stateDir>/teams/runtime/<teamRunId>/{tasks,inboxes} (team-core/src/team-registry/paths.ts, types.ts).
- Goals: goal.json consumer path only confirmed (omo-senpi ulw-loop goal-json-cache.test.ts:16); writer unresolved.
- No upstream web dashboard: packages/web is the omo.dev marketing site (Next 16/React 19/Tailwind 4, packages/web/AGENTS.md:1-5). Upstream conventions: Bun 1.4.4, strict TS, moduleResolution bundler, bun test (AGENTS.md:317-318, tsconfig.json).
- User prefs (memory, omo-agent-viewer notes): bounded memory (never load whole conversations), inline turn detail, visible todo progress, upgrade isolation (separate repo, never patch/import upstream checkout).

## Decisions (with rationale)
- D1 (user, Q1 'Repo layout: Monorepo (Recommended)'): omo-daemonic is a Bun workspace: packages/store (reader extracted from omo-agent-viewer src/task-store.ts, state.ts, transcript.ts), packages/tui (omo-agent-viewer moved in, omo-agents bin preserved), packages/daemon, packages/web. Default sub-choices: import viewer with git history via `git subtree add`; the old ~/src/omo-agent-viewer repo is left intact (never deleted), global `omo-agents` is reinstalled from the monorepo.
- D3 (user, Q2 Access, free text verbatim: 'Support OIDC and per-user configurations'): auth is OIDC (not localhost-token-only) and configuration is per user. Classified UNRESOLVED_PROGRESS: isolation model per user still open -> re-asked as Q2b. Implied defaults: generic OIDC discovery (issuer URL + client id/secret, auth code + PKCE), configurable bind address designed to sit behind a TLS reverse proxy, Host/Origin/CSRF checks kept, loopback break-glass admin token for the CLI.
- D4 (user, Q2b 'Users: Own omo identity (Recommended)'): each OIDC user (sub) maps to their own omo agent dir (own provider logins, subscriptions, sessions, task stores); users see/control only their own projects, schedules, loops, agents; admin role sees all. Not OS sandboxing - agents run as the daemon's macOS user. Implied defaults: per-agentDir operator host (`OMO_CODING_AGENT_DIR=<dir> omo daemon run`) and per-agentDir bridge child + observer; admin from a configurable OIDC groups claim; first admin bound to ~/.omo/agent; `omo-daemonic user provision` creates a user's agent dir and prints the omo auth command to log providers in.
- D5 (user, Q3 'Unattended: Worktree + project preset (Recommended)'): every scheduled/loop run gets a fresh git worktree on its own branch (omo worktree option, branch `omo-daemonic/<schedule|loop>-<slug>-<runId>`); preset = project setting, default workspace-write; full-access requires explicit per-project opt-in. Implied default: worktrees are kept after runs (never auto-deleted); UI shows branch/worktree per run with a confirmed 'remove worktree' action. Ad-hoc UI-started agents default to the project checkout with the same preset rules (user can tick worktree).
- D6 (user, Q4 'Spend caps: Conservative (Recommended)'): per user max 3 concurrent daemon-started runs, 1 per project; loops require maxIterations (default 10, hard cap 100) + 4 h wall budget; run timeout 2 h; schedule overlap default skip. All editable in per-user settings.
- D6a (user follow-up 'are we making the limits configurable if not they should be generous'): every limit is configurable - global defaults + admin hardCaps in config.jsonc, per-user settings up to hardCaps, per schedule/loop; internal bounds configurable via config.limits or generous (sessionTtl 12 h, event retention 30 d/100k, maxCatchup 50, SSE buffer 5000 frames/8 MiB); only omo's 1 MiB message cap is fixed.
- D7 (user, Q5 'Tests: TDD (Recommended)'): TDD with bun test (injectable Clock/Spawner/Fs/ProcTable, no sleeps), gated live contract suite OMO_CONTRACT=1 against installed omo in a temp agent dir, agent-executed browser QA per UI todo.
- D8 (user, 'Viewer edits: I'll commit first (Recommended)'): user commits the viewer's uncommitted edits in ~/src/omo-agent-viewer before todo 2; todo 2 preflights and waits BLOCKED otherwise.
- Consultant (st_01a210ad) folded: thread-model run lifecycle supersedes detail-design process/auth parts; no CLI fallback, no -p engine, no mass-ulw bridge unless the spike gate requires; create-without-prompt + idempotent send; daemon-created worktrees (per fire, per loop); worktree store indexing; glob root sessions; explicit preset from probe; env allowlist; private Bun 1.4.4 runtime; provisioning never runs interactive omo + plist hash guard; per-user user_seq; provisioned-only login; schedule runner liveness; bundled tui build keeping name omo-agent-viewer; secondary-host reopen-before-send; all_scope; project discovery from session headers; live e2e todo; machine cap 8; worktree cap 50; this-device-only, no teams view.
- D2 (architect, adopted): Design A observer+gateway - omo operator host (rpc.sock, ensured via `omo daemon run`) runs all agents; daemon opens/steers/closes via thread SDK in an isolated bridge child process with `omo thread ... --json` CLI fallback; observation from disk (tolerant decoders) + reconcile; DAG protocol via bridge as liveness enrichment; daemon owns only projects/schedules/loops/runs/audit in bun:sqlite WAL; REST + one multiplexed SSE stream; launchd user agent.

## Scope IN
C1-C6; monorepo migration of omo-agent-viewer (D1); OIDC + per-user agent dirs + admin role (D3/D4); worktree-isolated unattended runs (D5); caps (D6); TDD (D7); A1-A9.

## Scope OUT (Must NOT have)
- No writes to omo internal stores (task store, sessions, dag, schedule, gateway); no import/patch of the upstream oh-my-openagent checkout.
- No OS-level sandboxing or per-OS-user execution; no unauthenticated network exposure.
- No deleting ~/src/omo-agent-viewer; no auto-deleting run worktrees; no git push.
- No token-spend metering (not observable externally); no Desktop app integration; no new omo features upstream.

## Open questions

## Stance
cold start (no planning-style episodes) + CLEAR -> one-by-one renderer, veto offered.

## Approval gate
status: approved (user: 'Approval: Approve', 2026-11-25) - plan scaffolded; plan-consultant spawned.

## Risks
- dirty_worktree: ~/src/omo-agent-viewer has uncommitted changes (README.md, src/main.ts, navigation.ts, transcript.ts, viewer.ts, tests modified; src/storage.ts + test/storage.test.ts deleted). Migration todo must preflight `git status --porcelain` and stop BLOCKED (never commit/stash/reset in that repo) until the user commits.
- Thread SDK: `createThreadSdk({agentDir, cwd, uid, user})` from `<omo-ai>/plugin/runtime/thread-sdk/sdk.js`; methods send/read/list/create/interrupt/close/rename/set_model return data unions (omo-thread.md 'For scripts in JavaScript'); create reopens the same thread under a repeated idempotency_key. Docs say list prints an array; architect observed {kind:'ok',threads:[...]} on 5.1.79 -> contract test pins it. thread<->root session id mapping unverified -> first contract spike.

## Approval gate (history)
status: awaiting-approval
next action on approval: rerun scaffold without --draft-only, plan-consultant gap analysis, append todos, fill TL;DR, plan-reviewer rounds (review_required: true).
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

## Review ledger
- Round 1 (r1-mwvkkw04, session st_01a210c4, sha eaa35ffa...bbb8): REJECT -> changes_requested. Ledger frozen after round 1:
  - B1 IS-7 not reachable in browser -> fixed: omo-schedules page in todo 24 (+19 dependency, e2e, IS-7 row).
  - B2 todo 2 acceptance used path-limited git log -> fixed: merge-base --is-ancestor + rev-list count.
  - B3 todo 26 ran before 15/17 -> fixed: todo 26 moved to wave 8, blocked by 15 and 17.
  - Notes folded: ~/.bun rule narrowed to bun binaries; IS-9 orphan carve-out; decision gate STOP when assertion 2 or 7 fails; worktrees moved to ~/.omo-daemonic/worktrees (outside checkout).
- Round 2 (r2-mwvkxau5, session st_01a210cd, sha c2b7a8a1...46ac): OKAY (approved with notes); B1-B3 confirmed closed. Notes fixed with smallest edits (todo 16 reopen key, gate adds assertion 4 + probe presets/presetConfirmed, cancelled tombstones, kill-switch release + loops cancelled, store export names, matrix Blocks, omo child PATH). Plan changed -> round 2 approval invalidated by digest drift.
- Round 3 (r3-mwvlbn10, session st_01a210d7, sha a98a940e...2e2d): REJECT -> changes_requested. New blocker-eligible finding B4 (reproducible broken flow): todo 4 depended on store package from todo 3 a wave later -> fixed: store dependency moved to todo 3 (blocked by 4), todo 4 acceptance narrowed to tsc -b packages/daemon, early todos avoid root typecheck. Notes fixed: waiting loop holds no slot (test 20 superseded), IS-10 row adds todo 26, todo 27 uses bun test.
- Round 4 (r4-mwvlry2f, session st_01a210e3, sha b33fa9b2...a693): REJECT -> changes_requested. B4 confirmed closed. New blocker-eligible finding B5 (concrete data-loss risk): detail design lived in omo's 24 h-TTL task store -> fixed: copied to .omo/reference/omo-daemonic-detail-design.md (+ consultant result) with superseded-section header, all refs repointed, todo 1 commits .omo/plans, .omo/drafts, .omo/reference. Notes fixed: todo 10 QA uses in-test server, F1 bun check uses baseline PATH, script-only package.json exceptions for todos 27/29, Blocks lines synced with matrix, root test commands explicit.
- Round 5 (r5-mwvm7rle, session st_01a210ee, sha 9966fa8fd1a32cd73b1fc04aa5717e1586a2a80a97d3f5079775e01845cf6eb6): OKAY (approved with non-blocking notes). Final plan SHA validated against approved digest.
