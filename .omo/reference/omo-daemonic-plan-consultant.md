> Copied from omo task result st_01a210ad (2026-11-25) so it survives omo's 24 h task TTL. Advisory input; the plan is authoritative where they differ.

The approved approach holds, but the plan is not ready for todos yet. Four blockers:
- **Wrong engine design:** the only detailed design (`st_01a210a2`) describes a run engine for spawned processes, while A1/D2 adopted thread-SDK sessions.
- **Fallback misread:** the `omo thread` CLI "fallback" can't interrupt or close sessions.
- **Loops can't converge:** D5 gives every loop iteration a fresh worktree, so no iteration builds on the last.
- **Bun 1.4.4 is not installed** on this machine.

There is one owner question, about the viewer's uncommitted changes. Everything else below has a reversible default. I edited no files.

## Intent Classification
**Type**: Build from scratch (Large), with one architecture decision (A1) under review
**Confidence**: High
**Rationale**: New Bun monorepo (store, tui, daemon, web) plus migration of an existing repo. The approach is approved, so this pass looks for gaps rather than reopening direction.

## Findings (most severe first)

**F1 [contradiction] The run engine is designed for processes, but A1/D2 adopted threads**
- **Evidence:**
  - The detail design is built around processes: sec.1 `Run{pid,pgid,procStartedAt,exitCode,runDir}`; sec.2 argv `omo -p --mode json --session-id`, a `ps` scan to re-adopt runs, and an exit-file wrapper; sec.3 cancel steps 2-3 (SIGINT/TERM/KILL, `omo host stop`).
  - Draft A1/D2 instead use thread SDK `create`.
  - Plan "Verification strategy" still centres the `ProcTable`/`Spawner` fakes.
- **Impact:** for a thread run, nothing defines:
  - how it ends (there is no exit code);
  - what timeout and cancel do;
  - when the thread is closed;
  - what holds a concurrency slot;
  - how recovery works.

  Executors following the only detailed design would build the wrong engine.
- **Fix:** add a plan section "Run lifecycle (thread model)" that replaces those parts. Keep fire keys, the decide/commit transactions, misfire/overlap rules, the SSE event log and the projector; none of them depend on the engine.
  - **States:** `queued -> creating -> active -> settled -> evaluating -> closed|kept`. Terminal: `succeeded | failed(create_refused|turn_error|host_unavailable) | cancelled | timed_out | lost(thread_missing)`.
  - **How a run ends:** a completion arm per run. Bind the thread to a `custom` binding with `--events completion`, then `report <thread> completion`. Watch `<agentDir>/gateway/` for `outbox.marker`, and read the row's `outcome`: completed, failed or cancelled. omo writes it "never at an intermediate turn end" (omo-thread.md:507, :521-527).
  - **Fallback signal:** the thread `state` going running -> idle (:573) plus the session-file tail.
  - **Timeout:** interrupt, then `close({force:true})` after a grace period. **Cancel:** interrupt + close.
  - **Slot rule:** a run holds a slot only while its thread is `running`. Unattended threads close after evaluation; ad-hoc threads stay open until the user closes them.
  - **Recovery:** call `create({idempotency_key: fireKey})` again, which reopens the same thread (:641-643).

**F2 [contradiction] The `omo thread --json` CLI fallback can't interrupt, close or create, and it fails exactly when the SDK fails**
- **Evidence:**
  - Draft A1 and plan "Must have" list the CLI as fallback for send/read/list/interrupt/close.
  - The CLI only has list, send, read, bind, unbind, rebind, bindings, report, answer, outbox and ack (omo-thread.md:32-50), and "does not create or resume sessions" (:66).
  - `create`, `interrupt` and `close` exist only in the SDK (:630-632).
  - The CLI itself exits 5 "when the plugin's thread SDK cannot be loaded" (:604).
  - `omo remote interrupt|close` only reach other devices (remote-sessions.md:71).
- **Fix:** don't build the CLI fallback, unless the spike shows the SDK fails to load only in our runtime while the CLI works. Define degraded mode instead:
  - spawn, steer, interrupt and close are disabled through IS-3's capability gating;
  - the banner names the failed probe `sdk.load`;
  - the kill switch pauses schedules and loops, refuses new spawns, and returns `uninterruptible:[runIds]`.
  - Test: a FakeGateway with `sdkLoad:"fail"` makes `POST /api/v1/projects/:id/runs` return 503 `gateway_degraded`.

**F3 [unvalidated assumption] Exactly-once firing (IS-4) depends on whether a repeated `create` re-sends its prompt**
- **Evidence:** a repeated `create` "reopens that thread instead of making another… the SDK keeps no tool receipt, so any other repeated call runs again" (omo-thread.md:641-644). The doc says nothing about the prompt. `send` does keep durable idempotency receipts, for 30 days (:87, :558).
- **Impact:** if the daemon crashes after `create` but before committing the thread id, recovery calls `create` again. If that re-sends the prompt, the job runs twice in one session.
- **Fix:** create without a prompt, then `send({thread, text, idempotency_key: fireKey+":prompt"})`. Keep the prompt inside `create` only if a contract test shows one user message after two creates with the same key.
- **Same test must check framing:** a `create` prompt carries "the creator's authority" (:640-641), while `send` adds a `source=external` provenance header (:13). The agent may treat these differently.

**F4 [contradiction] D5 gives every loop iteration a fresh worktree, so A3 loops can't converge**
- **Evidence:** D5 says "every scheduled/loop run gets a fresh git worktree… `-<runId>`". A3 repeats a prompt until a check passes, and detail design sec.3 runs `check` "in the project directory".
- **Impact:** each iteration starts from the base commit and loses the previous iteration's edits, and the check measures the wrong tree.
- **Fix:**
  - **Loops:** one worktree per loop, created at loop start on branch `omo-daemonic/loop-<slug>-<loopId>`. Every iteration reuses it (fresh session, same directory), and `check` runs there.
  - **Schedules:** keep one worktree per fire.
  - **Who creates worktrees:** the daemon, with `git worktree add -b <branch> <path> HEAD`. Git is not an omo store, so IS-11 still holds. This is better than the SDK's `worktree?` parameter, whose shape is undocumented (:630); omo's own default branch is `omo/thread-<time>` (remote-sessions.md:41-47).
  - **Test:** FakeGateway records the working directory of every iteration; they must all be equal.

**F5 [unvalidated assumption] Worktree runs write their task trees, DAG runs and root sessions outside the project's store**
- **Evidence:**
  - omo keys the task store by the real path of the working directory (viewer task-store.ts:34-44).
  - Session folders are per directory, worktrees included. Example on disk: `~/.omo/agent/sessions/--Users-tglenn-.codex-worktrees-finish-defined-stories-fortforever--/`.
- **Impact:** the project views (IS-1, IS-2, IS-6) would miss every scheduled and loop run.
- **Fix:**
  - Store each run's working directory. The observer indexes `resolveTaskStateDir(run.cwd)` for each worktree as well as the checkout, and the project view merges them.
  - Add a contract test that pins where omo actually writes a worktree run's records.

**F6 [unvalidated assumption] Five features depend on mapping a thread to its session file, and there is no fallback**
- **Evidence:** the draft's Risks already marks this "unverified". `omo thread list` hides "session-file paths" (omo-thread.md:573).
- **Features that need it:**
  - the run transcript (IS-2);
  - the marker and goal done-checks;
  - the run-to-task-tree link (`root_session_id == run.sessionId`);
  - counting a cancelled run's child tasks.
- **Fix:** make it spike assertion 1, with three branches:
  - (a) `create` or `read` exposes the session id: store it.
  - (b) Otherwise, set a unique `name: "odm-<runId>"` and find it in the run directory's session folder.
  - (c) With one daemon-created worktree per run (F4), that folder holds only the run's session.
- **Refinement to A9:** find root sessions by globbing `sessions/*/*_<id>.jsonl` instead of deriving the folder name. The naming rule is unverified, and the folder `--private-tmp-claude-501--Users-…` shows a path can itself contain `--`.

**F7 [unvalidated assumption, security] Leaving out the permission preset means full-access, and the preset names are unknown**
- **Evidence:**
  - Sessions open in "this device's own setting, else full-access" (remote-sessions.md:41).
  - The rule that a new thread can only keep or narrow the caller's mode applies to the agent tool (:47-49). A script has no calling session (omo-thread.md:640).
  - D5 says `workspace-write`; detail design sec.1 says `"workspace"|"accept-edits"|…`; no doc lists the real names.
- **Fix:**
  - Always pass `permission_preset`.
  - Take the allowed names from a probe.
  - A contract test checks that the session runs with the requested preset.
  - Refuse unattended runs if that can't be confirmed.

**F8 [forgotten user: Teagan's own omo setup] Provisioning a second user can redirect omo's own session-host unit**
- **Evidence:**
  - Every interactive `omo` start runs `omo remote bootstrap` (remote-sessions.md:219-222).
  - Bootstrap installs one fixed LaunchAgent, pointed at whichever agent dir it registered. Neither its name nor its command can be configured (:240-265).
  - On this machine `~/Library/LaunchAgents/ai.omo.session-host.plist` pins `OMO_CODING_AGENT_DIR=/Users/tglenn/.omo/agent` with `--pinned`.
- **Impact:** if D4's `user provision`, or the command it prints, starts interactive `omo` under user B's agent dir, Teagan's always-on host could move to B.
- **Fix:**
  - Provisioning runs only non-interactive commands.
  - **Acceptance:** `shasum -a 256 ~/Library/LaunchAgents/ai.omo.*.plist` is identical before and after `omo-daemonic user provision qa-user` plus one host ensure for that dir.

**F9 [contradiction] One global gap-free event sequence conflicts with per-user visibility**
- **Evidence:** detail design sec.4 has a single SSE stream with a global `seq`; the client reconnects whenever `seq != last+1`. D4/IS-9 require filtering events by user.
- **Impact:** every filtered-out event looks like a gap, so clients reconnect in a loop.
- **Fix:**
  - Add a per-user `user_seq`, assigned in the same transaction; the admin gets the global sequence.
  - Move `/images/:sha256` under an authorized resource, `/runs/:id/images/:sha256`.
  - Answer 404 for other users' ids.

**F10 [contradiction] The plan doesn't mark detail design sec.4 auth as replaced**
- **Evidence:** sec.4 has a loopback-only bind, a bearer token, a `/login?t=` link, `SameSite=Strict`, and a Host allowlist of `127.0.0.1|localhost`. A5/D3 specify OIDC, Lax cookies plus a CSRF header, and a configurable bind behind a proxy.
- **Fix:** mark sec.4 auth as superseded and state the replacement:
  - Host allowlist: loopback plus the host of the configured `publicUrl`.
  - Origin must equal `publicUrl`.
  - Trust `X-Forwarded-*` only from configured proxy addresses.
  - Set `Secure` cookies when `publicUrl` is https.
  - The break-glass token is loopback and CLI only. No `/login?t=`.

**F11 [forgotten user: omo-native schedules] They only fire while a runner is alive, and A7 reads directories that don't exist**
- **Evidence:**
  - `~/.omo/agent/schedule/` contains only `pending/` (empty) and `runners/`, with 12 files like `{"pid":93419,"processStartedAtMs":…,"beatAt":…,"watch":false,"exec":null}`.
  - A7 assumes `{pending,firing,failed,cancelled}`.
  - The detail design saw `omo schedule --help` fail with `internal_key_unavailable`.
- **Fix:**
  - Treat every state directory as optional.
  - A runner counts as live only if its pid is alive, its start time matches, and its `beatAt` is recent.
  - Show a badge: "no live omo schedule runner — these will not fire".
  - Test `omo schedule list` and `cancel` from inside the launchd process, through `doctor`.

**F12 [missing acceptance criterion] Reinstalling the global `omo-agents` from the monorepo will break**
- **Evidence:**
  - `~/.bun/install/global/package.json` has `"omo-agent-viewer": "/Users/tglenn/src/omo-agent-viewer"`. The README installs with `bun add --global .` (README.md:22).
  - The current build is `tsc -p`, whose output imports its dependencies at runtime. A `workspace:*` import of `@omo-daemonic/store` can't resolve from a global install.
  - The script starts with `#!/usr/bin/env bun` (src/main.ts:1), so it runs on Homebrew Bun 1.3.10.
- **Fix:**
  - Keep the package name `omo-agent-viewer` and the bin name `omo-agents`.
  - Build with `bun build src/main.ts --target=bun --outfile dist/main.js`, bundling the store and keeping `@opentui/core` as a runtime dependency.
  - Reinstall with `bun remove --global omo-agent-viewer && bun add --global /Users/tglenn/src/omo-daemonic/packages/tui`.
  - **Acceptance:** `cd /tmp && omo-agents --help` exits 0, and the global manifest points at the monorepo.

**F13 [contradiction] The viewer migration vs its uncommitted changes**
- **Evidence:**
  - The plan forbids commits in `~/src/omo-agent-viewer`, and `git subtree add` only imports commits.
  - On disk, `src/storage.ts` and `test/storage.test.ts` are already deleted but uncommitted.
  - `transcript.ts`, one of the files packages/store is extracted from, is modified.
- **Impact:** stopping as BLOCKED holds up store -> observer -> transcript views, which is most of the critical path. Importing only the last commit brings `storage.ts` back and drops the edits.
- **Fix:** settle it before execution with Q1 below. If the answer is "carry":
  - run `git subtree add` from HEAD;
  - copy the working-tree version of every path listed by `git --no-optional-locks -C ~/src/omo-agent-viewer status --porcelain`, deleting the removed ones, in one commit;
  - **Acceptance:** the sha256 of each copied path matches the viewer's working tree.
  - Check `git subtree --help` first. Fallback: `git merge -s ours --no-commit --allow-unrelated-histories` + `git read-tree --prefix=packages/tui/ -u`.

**F14 [missing constraint] The commit policy is empty**
- **Evidence:** plan "Commit strategy" is blank, the workspace isn't a git repo, and `git subtree add` makes commits by itself.
- **Default:**
  - Commits only inside `/Users/tglenn/src/omo-daemonic`.
  - Todo 1 runs `git init` plus an initial commit; after that, one commit per todo, never pushed.
  - Plan approval counts as the authorization.
- **Reversible:** local history only.

**F15 [scope creep; a reframe, not a feature cut] The mass-ulw protocol for live DAG activity duplicates what's on disk**
- **Evidence:**
  - The protocol needs `SENPI_RPC_CLIENT_CAPABILITIES=extension_events` (mass-ulw-protocol.md:19), and answers `run_not_owned` when no session is active (:199).
  - The activity fields (current tool, last line, turns) come from each node's task. `dag.node.task-attached` names that task, and the IS-2 work already reads it.
- **Recommendation:** show IS-6 live activity from disk: the DAG event log plus each node's task transcript. Make the protocol an optional last todo.
- **Decoder rules:** reject an unknown `schemaVersion` (:11) and ignore unknown event types. The doc itself says 17 types at :37 and 26 at :56.

**F16 [unvalidated assumption] Which runtime the SDK bridge runs on, and the launchd environment**
- **Evidence:**
  - omo-ai declares `engines.node >=24`, and the SDK needs `node:sqlite` (omo-thread.md, exit code 4). This machine has Node v22.22.0.
  - omo's launcher (`omo-ai/bin/omo.js:2`) tries `$BUN_INSTALL/bin/bun`, then `~/.bun/bin/bun`, then any `bun` on PATH, then `node`. Today that resolves to Homebrew Bun 1.3.10.
- **Fix:**
  - The spike proves `createThreadSdk` loads in the bridge process.
  - Pick the bridge runtime the same way omo's launcher does.
  - Never pass `BUN_INSTALL` to omo processes, or omo switches runtime.
  - Give omo processes the same PATH omo's own LaunchAgent uses, which includes `/opt/homebrew/bin`.
  - `omo-daemonic doctor --json` runs the probes from inside launchd: `sdk.load`, `thread.list`, `schedule.list`.

**F17 [unvalidated assumption] Does closing a session stop its child tasks?** This matters for IS-5 ("cancellable down to its child tasks") and the IS-9 kill switch.
- **Evidence:** omo has no external task cancel (README.md:63). `close` has `force`, `graceful` and `wait_ms` (omo-thread.md:632), but cascading is undocumented. Task hosts exit after 15 idle minutes (omo-daemon.md:88).
- **Fix:** add a contract test: a root with one child, `close({force:true})`, then check whether the child ends. If it doesn't, reword the IS rows to "children shown as orphaned until they settle or idle out", and have the kill switch report them.

**F18 [gap] Secondary users' omo hosts idle out, and follow-ups then queue silently and expire**
- **Evidence:**
  - Hosts exit and evict sessions after 15 idle minutes; `--pinned` prevents that (omo-daemon.md:88-93).
  - Messages to sessions that aren't running are queued (`queued_offline`, omo-thread.md:104-110) and expire after 24 h (:168).
  - Only Teagan's agent dir is pinned, by omo's own LaunchAgent.
- **Fix:**
  - A follow-up to a daemon-started run first reopens it with `create({idempotency_key: fireKey})`, then sends.
  - A follow-up to an offline session started elsewhere is labelled "queued for next start (expires 24 h)".
  - Default `pinHost:false` for secondary users.
  - Contract test: `omo daemon stop`, reopen, send; a new turn starts.

**F19 [gap] The SDK is scoped to one working directory**
- **Evidence:** `createThreadSdk({agentDir, cwd, …})` (:612). A thread outside that directory's workspace answers `scope_denied` (:87). The control calls accept `all_scope` (:631-632).
- **Fix:** the bridge keeps one SDK handle per (agentDir, directory), or passes `all_scope:true`. Contract test: interrupt a thread created in another directory.

**F20 [gap with no todo] How projects are discovered is undefined**
- **Evidence:** IS-1 promises "all of their projects", but the detail design only has `POST /projects`. omo's store folders are one-way hashes (task-store.ts:41-43), and session-folder names lose information (`--Users-tglenn-src-omo-agent-viewer--` can't tell `-` from `/`).
- **Fix:**
  - Projects = registered ones plus discovered ones.
  - Discover from the `cwd` in the header of the newest session file in each folder; `<agentDir>/rpc/task-stores.json` is another candidate source.
  - A discovered project is view-only until adopted.
  - Add a GAP row, a todo, and a test with hyphenated paths.

**F21 [missing acceptance criterion]** Starting, steering and stopping agents (IS-3) and the kill switch (IS-9) are only ever tested against FakeGateway; F3 "Real manual QA" is undefined. Add a gated live end-to-end test (see the QA directives).

**F22 [forgotten users]**
- **(a) Secondary web users can't log their AI providers in:** D4 only prints an `omo auth` command. Default: the admin provisions at the machine, documented; web-based provider login is listed as out of scope.
- **(b) Agents whose memory or notes point at `~/src/omo-agent-viewer`** will keep editing a frozen copy. Add an AGENTS.md in the monorepo saying packages/tui is the source, and have the final report list notes to update. Never write into the old repo.

**F23 [scope clarity]**
- **Other devices:** `omo thread list` includes other devices' threads by default (omo-thread.md:53-54), and their transcripts aren't on local disk.
- **Teams:** they appear in the draft's findings with no IS row.
- **Ancestry:** script-created threads "record no creator session" (:640).
- **Fix:**
  - Add "this device only; no teams view" to Scope OUT.
  - Define ancestry as the daemon's own records (run -> schedule/loop -> user), echoed in the thread name.

**F24 [missing acceptance criterion]** IS-1 promises updates within 2 s, but the detail design re-reads documents nobody is viewing only every 10 s (sec.5). Define "visible" as "subscribed". A Playwright test appends a fixture task and waits at most 2 s for `[data-testid=task-row][data-task-id=qa-task-1]`.

## Constraint gaps: proposed defaults
All of these are config settings and can be changed later, except the Bun runtime, which is undone by deleting its directory.

**Budget and spend**
- **Evidence:**
  - D6's caps are per user, so N users means 3N runs.
  - omo caps nothing (omo-daemon.md:178).
  - 4 sessions with 4 children each used 2.7 GB RSS.
- **Default:**
  - A machine-wide cap of 3 running daemon threads, plus 3 per user and 1 per project. Idle threads don't hold a slot.
  - Each run shows its live child count; nothing kills children automatically.
  - Schedule and loop forms store an explicit model, so a later change to the default model can't silently raise cost.

**Mandated stack (Bun 1.4.4)**
- **Evidence:**
  - Homebrew has only `bun/1.3.10`, and there's no Bun in `~/.bun/bin`, `~/.local/bin`, `/usr/local/bin` or nvm.
  - omo's own plist hardcodes the Cellar path `/opt/homebrew/Cellar/bun/1.3.10/bin/bun`.
  - omo's launcher prefers `~/.bun/bin/bun` (omo.js:2), so a standard Bun install would switch omo's runtime.
- **Default:**
  - A private Bun 1.4.4 at `~/.omo-daemonic/runtime/bun-1.4.4/bun`: the release zip, checksum-verified, not on PATH, called by absolute path.
  - Never touch Homebrew Bun or `~/.bun/bin`.
  - Try `bun check --no-script` instead of `tsc -b`.
  - Try `Bun.cron.parse(expr,{tz})` against the DST tests before adding croner.
  - Never use the OS-level `Bun.cron(path, …)`.

**Expected scale**
- **Evidence:** none stated.
- **Default:**
  - Up to 5 users and 50 projects per user.
  - Events kept 30 days or 100k rows.
  - Session list = the newest 200 per scope (:573).
  - Kept worktrees capped at 50 per project. Past that, new fires are recorded `skipped(worktree_cap)`, with a banner and a confirmed bulk remove; nothing is deleted automatically.
  - Schedules and loops on non-git projects are rejected.
  - Worktrees start from the checkout's HEAD at fire time.

**Audience and compliance**
- **Evidence:** none stated.
- **Default:**
  - A personal/household tool with no compliance regime.
  - The audit log keeps issuer + subject, action, target, and the prompt's sha256 plus its first 200 characters, for 180 days.
  - `daemon.sqlite` and secret files are mode 0600.

**Security**
- **Evidence:** D4 accepts that every agent runs as the daemon's macOS user.
- **Default:**
  - **Login:** only provisioned issuer + subject pairs may sign in; anyone else gets 403 and an audit row.
  - **Admins:** a configured subject list. The OIDC `groups` claim is used only when configured, because many providers omit or reject it.
  - **Project roots:** non-admins get no project directories by default; the admin grants them.
  - **Presets:** always explicit (F7).
  - **Loop `check` commands:** they run outside omo's permission model, so they run in the loop worktree with a scrubbed environment and a timeout, and only for admins or full-access projects.
  - **omo child processes:** an allowlisted environment, never daemon secrets or `BUN_INSTALL`.
  - **Network:** binding to anything but loopback requires an https `publicUrl` and `trustedProxies`.
  - **Docs and UI:** say plainly that per-user isolation is not a security boundary.

## Questions for User
1. **Q1 (the only blocking question; ask before execution):** `~/src/omo-agent-viewer` has uncommitted edits to main, navigation, transcript, viewer and tests, and `storage.ts` is deleted. packages/store is built from that `transcript.ts`. Are the edits finished?
   - (a) Yes, and you commit them first, so the migration imports clean history. **Recommended.**
   - (b) Copy them as they are into the monorepo as one separate commit, without touching the old repo.
   - (c) Leave them out and import only the last commit.

   I'm not defaulting because both easy paths are risky: (b) can bring in half-finished code that fails the root `bun test` gate, and waiting as BLOCKED stalls most of the plan.

## Contrarian grill on A1 (thread SDK on per-user hosts vs daemon-supervised `omo -p` processes)

**The case for `omo -p`:**
- One process per run.
- The exit code means done; a signal means cancel.
- No host to start, no idle-out (F18), no directory scoping (F19), no runtime question (F16).
- The kill switch still works if the SDK breaks (F2).
- A crash takes down one run, not every run on a user's host.
- Scheduled and loop runs, most of the workload, never need steering.

**The case for the SDK:**
- Steering and follow-ups (IS-3) need a live gateway endpoint. Endpoints are terminals, Desktop and hosts (omo-thread.md:5-12); a `-p` process probably isn't one, though the spike should confirm that.
- The SDK is documented (:622-644); `-p` JSON output is not (detail design sec.3).
- A thread id derived from the key prevents duplicates without scanning processes.
- Threads show up in Desktop and `omo thread`.
- They survive omo updates through host handoff.
- For Teagan, the host already exists, pinned by omo's own unit.

**Verdict:** the SDK choice is real for interactive runs. Three defaults around it are habit and add complexity nobody asked for:
1. **The `-p` third tier:** a whole second engine for a rare failure. If the host can't be started, fail the run as `failed(host_unavailable)` and let the schedule's retry policy apply. Don't build it.
2. **The CLI fallback:** it shares the SDK's failure (:604) and can't interrupt or close. Don't build it.
3. **The DAG protocol bridge** (F15).

Keep the isolated bridge process: it keeps omo's code, its `node:sqlite` worker and any crash out of the daemon. Keep per-user hosts for secondary users, unpinned.

**Decision gate after the spike (put this in the plan):**
- **SDK for every run** if all of these pass:
  - one prompt delivered after a repeated create;
  - completion arms report an outcome;
  - a thread reopens after the host stops;
  - the requested preset is applied.
- **SDK still, but detect the end of a run from idle state plus the session file** if completion arms don't work for script-created threads.
- **`-p` for unattended runs, and escalate to the owner** only if the SDK can't load in any runtime. IS-3 then loses steering and follow-ups; start and stop still work through signals.

## Identified Risks
- **Building on the process-engine design (F1):** mark the replaced sections of the detail design (sec.1 process fields, sec.2 supervision, sec.3 cancel steps, sec.4 auth) in the plan.
- **Disturbing Teagan's own omo** (F8, F16, the Bun install): hash checks on omo's plists, never touch `~/.bun/bin`, allowlist environment variables.
- **The migration losing edits or stalling the critical path (F13):** ask Q1 now.

## Affected users and ideal-state gaps
- **U1, secondary users:** provider login (F22a); login allowlist and project roots (Security defaults).
- **U2, omo and its other clients:**
  - session-host unit (F8);
  - runtime switch from a Bun install (Stack default);
  - schedule runners (F11).
- **U3, spawned agents:** explicit preset (F7), one worktree per loop (F4), ancestry (F23).
- **U4, maintainers and agents:** pointers to the old repo (F22b), global reinstall (F12).
- **IS rows to reword:**
  - **IS-3:** "or queued for the next start, with visible expiry" (F18).
  - **IS-5:** depends on the cascade test (F17).
  - **IS-7:** add runner liveness (F11).
- **New GAP rows, each needing a todo and a QA scenario:**
  - **GAP-13:** run lifecycle for threads (F1).
  - **GAP-14:** project discovery (F20).
  - **GAP-15:** provisioning never touches omo's units (F8).
  - **GAP-16:** indexing worktree-run stores (F5).
- **The person reading logs** has no row: prove `omo-daemonic doctor --json`, with named probes, under IS-10.

## Directives for the Planner

### Core Directives
- MUST: Todo 1 is repo init plus the commit policy (F14).
- MUST: Todo 2 is the contract spike, and it gates the run engine. Its assertions:
  1. The SDK loads in the bridge process.
  2. A repeated create delivers one prompt.
  3. Threads map to session files.
  4. The preset names are known and the requested preset is applied.
  5. Where a worktree run's records land.
  6. A completion arm reports an outcome.
  7. A thread reopens after `omo daemon stop`.
  8. `all_scope` works across directories.
  9. Whether close cascades to children.
  10. The `omo thread list` JSON shape. The doc says both object (:54) and array (:568); handle both.
- MUST: Add "Run lifecycle (thread model)" and mark detail design sec.1 process fields, sec.2 supervision, sec.3 cancel steps 2-3 and sec.4 auth as superseded.
- MUST: The daemon creates worktrees, one per loop and one per fire (F4), and indexes `resolveTaskStateDir(run.cwd)` (F5).
- MUST: Always pass the preset, allowlist omo processes' environment, and give each user a `user_seq`.
- MUST NOT: Build the `-p` tier, the CLI fallback or the DAG protocol bridge unless the spike requires them.
- MUST NOT: Derive session-folder names (glob instead), start interactive `omo` during provisioning, install Bun into `~/.bun/bin`, or upgrade Homebrew Bun.
- PATTERN: Follow the viewer's module boundaries: `src/task-store.ts:34-111`, `src/state.ts:27-90`, `src/transcript.ts:74-307`, and ADR 0001's bounded reads.
- TOOL: Run `lsp_find_references` on `readRootDocument` (task-store.ts:102) and `resolveTaskStateDir` (:34) before moving them.

### QA/Acceptance Criteria Directives
- MUST: Run the live contract suite as `OMO_CONTRACT=1 bun test --timeout 180000 ./packages/daemon/test/contract/`. The plan's current command has no `./`, which makes it a substring filter, and no command-line timeout, which is the only timeout that reaches every file (Bun skill rule 5).
- MUST: Live tests set up their watcher before acting, then wait with a bounded timeout, with no polling loops. Watch `fs.watch(<tmpAgentDir>/gateway)` for `outbox.marker` (omo-thread.md:507-515), or the session folder.
- MUST: Name Playwright files `*.e2e.ts` with `testMatch: /\.e2e\.ts$/`, so the root `bun test` doesn't pick up `*.spec.ts` files.
- MUST: **Live end-to-end:** `OMO_CONTRACT=1 OMO_CONTRACT_SPEND=1 bun run --cwd packages/web e2e:live`.
  - **Happy path:**
    1. Sign in through mock OIDC as `qa-admin`.
    2. Create a project at `/tmp/odm-qa-repo` (a fresh git repo).
    3. Start an agent with the prompt `Reply with exactly: ODM-LIVE-OK`; `[data-testid=transcript-row]` shows `ODM-LIVE-OK` within 180 s.
    4. Click `[data-testid=run-close]`; the thread is no longer `running` in `omo thread list --all-scope --json`.
    5. `GET /api/v1/audit?runId=<id>` has `spawn` and `close` rows.
  - **Kill switch:** with 2 live threads, triggering the kill switch closes both and pauses the schedules.
- MUST: **launchd restart:** record the `incarnation` from `curl -sf http://127.0.0.1:8787/api/v1/health | jq -r .incarnation`, run `launchctl kickstart -k gui/$(id -u)/dev.omo-daemonic.daemon`, then check that the incarnation changed and that a thread created before the restart is still listed and adopted.
- MUST: **Guards, as commands:**
  - plist hashes unchanged (F8);
  - per-path sha256 match after migration (F13);
  - `cd /tmp && omo-agents --help` exits 0 (F12);
  - the store fixture `sessions/--Users-x-a-b--/2026-11-25T00-00-00-000Z_<id>.jsonl` gives a non-empty root document (A9).
- MUST: **Failure cases with exact expected results:**
  - SDK fails to load -> 503 `gateway_degraded`;
  - user B reads user A's run -> 404;
  - unknown preset -> 400 `invalid_arguments`;
  - worktree cap reached -> run `skipped`, reason `worktree_cap`;
  - schedule on a non-git project -> 400;
  - two scheduler ticks for the same fire key -> exactly one `create` recorded by FakeGateway.
- MUST NOT: Write acceptance that needs a person to log in, click or look. Mock OIDC plus Playwright cover all of it.

## Recommended Approach
Ask Q1 now, then write todos starting with repo init and the contract spike. Let the spike's results decide the thread-run lifecycle. Do per-loop worktrees and per-directory store indexing next, and skip the three redundant mechanisms (`-p` tier, CLI fallback, protocol bridge) unless the spike proves one is needed.