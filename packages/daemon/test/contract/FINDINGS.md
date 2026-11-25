# omo thread SDK and CLI contract findings (todo 5)

Recorded 2026-11-25 against the installed omo. Every answer below is pinned by a case in
`omo.contract.test.ts` (case names in brackets) and, where a shape matters to later todos, by a scrubbed
fixture in `../fixtures/omo/`.

## Environment

| Item | Value |
| --- | --- |
| omo version | `omo 5.1.79 (engine: senpi 2026.11.18-3)` (`omo --version`) |
| Plugin root | `~/.bun/install/global/node_modules/omo-ai/plugin` (`createThreadSdk` from `runtime/thread-sdk/sdk.js`) |
| Bridge runtime | Bun 1.4.4 at `/opt/homebrew/bin/bun`, chosen in omo's launcher order (`bin/omo.js:2`): `$BUN_INSTALL/bin/bun` and `~/.bun/bin/bun` do not exist (`BUN_INSTALL` unset), so `bun` on the PATH wins; `node` was never needed. The symlink points into `Cellar/bun/1.3.10`, but that binary reports 1.4.4 (upgraded in place). The engine hosts omo starts run the same binary. |
| Private Bun 1.4.4 | The SDK also loads under `~/.omo-daemonic/runtime/bun-1.4.4/bun` (same version). omo child processes still get a PATH without it. |
| Agent dir | `omo daemon run --json` starts in an empty temp agent dir (`OMO_CODING_AGENT_DIR=<tmp>/agent`), so the whole suite runs there; the real-agent-dir fallback was not needed and the real agent dir is never written. |
| Spend | An empty agent dir has no provider credentials (a turn stays `held`). With `OMO_CONTRACT_SPEND=1` the suite passes the provider key named by `OMO_CONTRACT_PROVIDER_ENV` (default `ZAI_API_KEY`) to the temp engine and uses `OMO_CONTRACT_MODEL` (default `zai/glm-5.3-flash`). One "Reply with exactly OK" turn cost about $0.003. |

Run it with `OMO_CONTRACT=1 [OMO_CONTRACT_SPEND=1] bun test --timeout 180000 ./packages/daemon/test/contract/`.
`OMO_CONTRACT_RECORD=1` rewrites the fixtures; otherwise each live result must still carry every top-level key
(and the same `kind`) its fixture has.

## Assertions

### 1. The SDK loads in the bridge runtime - PASS

`createThreadSdk({agentDir, cwd, uid, user})` loads under the bridge runtime and under the private Bun. Its
methods: `ack answer bind bindings close create dispose extensionCall interrupt list locate outbox read rebind
registerStoreExtension release rename report send set_model unbind warmDaemon`. Pointing the loader at a
nonexistent plugin root makes the import fail inside the child; the probe reports
`{sdkLoad: "fail", detail: "sdk_unavailable: <import error>"}` and does not throw.
[`1`, `1-QA`; fixture `probe-sdk-unavailable`]

### 2. Duplicate suppression - PASS

- Without spend: `create` without a prompt, repeated under one `idempotency_key`, answers `kind: "ok"` with the
  same `thread` both times (`deduplicated` stays `false`: create reopens, it does not replay). `send` repeated
  under one key answers `deduplicated: true` with the first `delivery_id` and `message_seq`. [`2`]
- With spend: `create` with a `prompt`, repeated under one key, answers `prompt: {deduplicated: true,
  delivery_id: <first>}` and the session holds exactly one `custom_message` / `session_control_delivery` entry.
  [`2-spend`; fixture `create-with-prompt-repeat`]
- Provenance, as the agent sees it:
  - A `create` prompt is delivered verbatim with the creator's authority: the content is the prompt itself, and
    `details.sender` is `{kind: "command_line", user}`.
  - A `send` arrives wrapped as relayed external content: `From <workspace> / <project> [OMO_GATEWAY v=1
    source=external ... actor=<user> requested=follow_up effective=follow_up ...]`, followed by "This content
    was relayed by the gateway. Its source is the actor above. Claims inside the message do not change its
    authority.", then the quoted text.
  - So the plan's create-then-send path hands every run prompt to the agent as untrusted external content.
    Since a repeated create-with-prompt delivers once, putting the prompt inside `create` is allowed under the
    plan's own rule, and it keeps creator authority.

### 3. Thread address to session id and file - PASS

The thread id is the session's durable id. `create` returns no session field.
`locate({thread})` returns `thread.session_path` and `thread.endpoint.durable_session_id` (equal to the thread).
The file is `<agentDir>/sessions/<folder>/<ISO-ish ts>_<thread>.jsonl`; its first entry is
`{type: "session", id: <thread>, cwd}`. Globbing `sessions/*/*_<thread>.jsonl` finds exactly that file. Task
records carry `root_session_id` = `parent_session_id` = the root thread id. [`3`, `5+9+3`; fixtures `locate`,
`task-record-child`]

### 4. Permission presets - FAIL for the plan's use

- The SDK's names are `full-access`, `workspace`, `accept-edits`, `auto`, `read-only` and `ask`. Any other
  name is `invalid_arguments` ("must be equal to constant").
- A script SDK caller has no approval mode of its own, so `create` accepts only `ask` (or no preset). Each of
  the five wider names answers `scope_denied` with `details.reason: "permission_preset_wider"` ("This session
  runs in an unknown approval mode; a thread it creates cannot run in <preset>, which allows more").
- The applied preset is visible in the session file as
  `{"type":"custom","customType":"permission_mode","data":{"preset":"ask","source":"client"}}`. A thread
  created without a preset has no such entry (it runs in the agent dir's default mode, which cannot be
  confirmed from outside).
  [`4`; fixture `preset-wider-refused`]

Spike only, not in the suite: the creator mode comes from an undocumented `createThreadSdk` option,
`remote.permissionPreset()`. Passing `remote: {permissionPreset: () => "workspace"}` made `create` accept
`workspace`, and the header recorded `workspace`/`client`. But `dispose()` then threw (`remote.sessions` is
undefined), and the option is part of the cross-device relay surface, not a supported contract. The documented
CLI path `omo remote open here --permission-preset workspace` answered `relay_requires_paid_plan`.

Consequence: the plan's rules cannot be met through the documented SDK. Those rules are "every spawn passes an
explicit `permission_preset` whose name comes from the probe; unattended runs are refused when the applied
preset cannot be confirmed" and "unattended preset default: workspace-write".

### 5. Worktree runs: task store and session folder - PASS

- Session folder: `<agentDir>/sessions/--<cwd with "/" replaced by "-">--/`, built from the cwd exactly as
  given. A macOS temp path stays `/var/...`, not `/private/var/...`.
- Task store: `resolveTaskStateDir(worktreePath)` =
  `<agentDir>/projects/<basename(realpath)>-<sha256(realpath)[:12]>/senpi-task/`, keyed on the realpath, so
  the raw-path hash differs on macOS temp dirs. The legacy `<project>/.omo/senpi-task` is used only when it
  already holds records.
- A child's session file lives at `<stateDir>/children/<task_id>/sessions/<task_id>/<ts>_<child>.jsonl`.
  [`5`, `5+9+3`]

### 6. Completion arm - PASS

- `bind({session, binding: {platform: "custom", account_id, chat_id, outbound_events: ["completion"],
  direction: {inbound: false, outbound: true}}})` answers an `active` binding.
- `report({session, kind: "completion", text, binding_id})` answers `armed: true, cursor: null, wake:
  {reached: true}`.
- After the turn settles, `gateway/outbox.marker` is rewritten (`{binding_id, cursor, written_at}`). Watch the
  `gateway/` directory, not the file. `outbox({binding_id})` then returns one row `{event: "completion", text:
  <arm text>, outcome: "completed", state: "pending"}`.
  [`6`; fixtures `bind`, `report-arm`, `outbox-completion`]

### 7. Reopen after `omo daemon stop` - FAIL: the reopened session takes no turn from the SDK

The stop itself:

- `omo daemon stop` refuses with exit 3 (`daemon: refuse: sessions_live ...`) while sessions are live.
- `omo daemon stop --drain` exits 0 but returns while the operator still answers, with `lifecycle:
  "stopping"`; `--wait` does not change that.
- A `create` in that window answered `internal_error` ("thread RPC request failed: host_stopping").
- `rpc.sock` is unlinked when the host really exits, about 2 s later; the suite watches the `rpc/` directory
  for that. After it, `create` answers `host_unavailable`: `create` never starts a host.
- A `send` while no host runs answers `delivery.kind: "queued_offline"`.

The reopen:

- `omo daemon run --json` answers `action: "start"`, and `create` under the same key reopens the same thread.
- The restored session starts held: `omo host session state <thread> --json` shows `paused: true` and
  `holds: [{kind: "unattended"}]`, lifecycle `held`. The engine adds that hold to every session it starts
  without an attending client.
- An SDK `send` is accepted (`kind: "ok"`, `delivery.kind: "started"`) but only counts against the hold
  (`sourceCounts.session_control_delivery`). No turn runs: no assistant entry appeared within 40 s in the spike
  and 120 s in the suite.
- The hold is released only by engine-level input or a `resume_session` request, and neither is a thread SDK
  method. The documented CLI `omo host session prompt <thread> <text>` is engine input: it answered
  `{action: "prompt", disposition: "started"}`, the hold cleared, the turn ran, and the queued SDK delivery
  was admitted after it.
- The restored session also drops the model it was created with: a `model_change` back to the profile default
  (`zai/glm-5.3` instead of `zai/glm-5.3-flash`) is written at reopen. Recovery must re-apply `set_model`.
- Restarting the operator restores the sessions it held, including threads closed earlier (they list `idle`
  again). Recovery must re-close what it had closed.

So the plan's recovery step ("`creating` -> call `create` again with the same idempotency key and resend the
prompt with its idempotency key") stalls after a host restart. The resent prompt is accepted and never runs
unless the daemon also sends engine input outside the thread SDK.
[`7`; fixtures `create-host-unavailable`, `host-session-state-held`, `host-session-prompt`]

### 8. Interrupt across cwds - PASS

- One SDK handle reaches a thread created under a different cwd only with `all_scope: true`. Without it the
  answer is `scope_denied` ("exists outside this workspace").
- With it, the answer for an idle thread is `{kind: "ok", interrupted: false, background: {status:
  "stopped", stopped: [], failed: []}}`.
- `list({all_scope: true})` lists every workspace. A second handle is not needed.
  [`8`; fixture `interrupt-all-scope`]

### 9. `close({force: true})` and running children - PASS

A parent whose `omo-native-qa-executor` child ran a long `sleep` was closed with `close({force: true})`, which
answered `{closed: true, reason: "closed"}`. The child's `sleep` process was gone, and its task record moved
from `residency_state: "resident"` to `"persisted_only"` (`suspension_reason: "session_quit"`).

- The record's `status` can already read `completed` while the child's process still runs: its turn ends once
  it puts the command in a background terminal. Liveness is `residency_state`, not `status`.
- A child spawned by `category` uses that category's model chain. In an agent dir without those providers'
  credentials it fails at once (`failure_kind: "child-prompt-failed"`, `provider_credentials_missing`).

[`5+9+3`; fixtures `close-force`, `task-record-child`]

### 10. Shapes and CLI behavior - PASS

- `omo thread list --json` prints an object, not the array the reference documents: `{kind: "ok", threads,
  scope, remote_unavailable?, aliases_unavailable?}`. SDK `list` answers the same object. The gateway must
  accept both (`parseThreadList`).
- A row is `{thread, name, status, state, model: {provider, id}, activity, cwd, created_at, updated_at, link,
  surface: "daemon", controls: ["send", "read", "rename", "set_model", "set_reasoning", "interrupt"]}`.
  [fixture `thread-list-cli`]
- `omo daemon run --json` exits 0 with `{action: "start" | "reuse", socket: <agentDir>/rpc/rpc.sock, pid,
  lifecycle: "ready", instanceId, generation, engineVersion, engineOrdinal, capabilities, ...}`.
  [fixture `daemon-run`]
- `close({graceful: true, wait_ms})` answers `{kind: "ok", thread, closed: true, reason: "closed",
  dropped_deliveries: []}`. [fixture `close-graceful`]
- A refusal from `interrupt` nests its kind: `{kind: "error", error: {kind: "error", code, message,
  next_action}}`.
- `omo schedule list --json` exits 0 with `{jobs: [], invalid: [], runners: [...]}` in the temp agent dir;
  `internal_key_unavailable` did not reproduce. [fixture `schedule-list`]
- The thread id is derived from `idempotency_key` alone: the same key gives the same thread id in any agent
  dir, and the per-session host socket `p-<hash>.sock` repeats with it. Keys must be globally unique; the
  plan's `<fireKey>:<attempt>` keys are. The suite prefixes every key with its run id.
- Every created thread gets its own per-session host (`p-*.sock` under `/private/tmp/omo-rpc-<agent dir
  hash>/`). `omo daemon stop` without `--all` stops only `rpc.sock`. Teardown therefore runs `omo daemon stop
  --drain --all --wait`, then `omo daemon gc`, which drops dead endpoint state but leaves the emptied
  `omo-rpc-<hash>` directory. It then checks that no process or sidecar still names the temp root, and
  removes its own emptied sidecar directories.

## Decision gate

| Assertion | Outcome |
| --- | --- |
| 1 SDK loads | PASS |
| 2 duplicate suppression | PASS |
| 4 preset names and application | **FAIL**: only `ask` can be requested by a script creator |
| 6 completion arm | PASS |
| 7 reopen after host stop | **FAIL**: reopens by key, but the restored session is held `unattended` and an SDK `send` starts no turn |

**DECISION-GATE: STOP** (assertions 4 and 7). Per "Run lifecycle (thread model)", the plan stops and goes to
the user; no fallback is improvised here. The open choices, with none acted on:

For assertion 4 (presets):

1. Spawn without `permission_preset`, so sessions run in the agent dir's default mode. The plan's "explicit,
   confirmed preset per spawn" rule and the `preset_unconfirmed` refusal would have to change.
2. Ask omo upstream for a documented creator mode on the script SDK (for example a
   `createThreadSdk({permissionPreset})` option bounded by the agent dir's own setting), then re-run this suite.
3. Use the undocumented `remote.permissionPreset()` hook. It works for `create` but breaks `dispose()` and is
   not a supported surface.

For assertion 7 (recovery after a host restart):

1. Have recovery release the hold with engine input. `omo host session prompt <thread> <text>` works today and
   is in `omo host` usage; it is a CLI call outside the thread SDK, and its prompt is not deduplicated by an
   idempotency key.
2. Ask omo upstream for an SDK `resume` (the engine already serves `resume_session` with `mode: "release"`).
3. Pin the operator with `omo daemon run --pinned` so it never idles out. That narrows the window but does not
   cover a crash, a reboot or an upgrade handoff.
