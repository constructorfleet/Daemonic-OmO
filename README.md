# omo-daemonic

A Bun workspace monorepo for the omo-daemonic daemon, web app and viewer.

## Packages

- `packages/store` - shared read-only reader for omo on-disk state
- `packages/tui` - `omo-agents` terminal viewer (`omo-agent-viewer`)
- `packages/daemon` - always-on observer/gateway daemon and `omo-daemonic` CLI
- `packages/web` - React web app served by the daemon

## Runtime

All repository commands use the private Bun 1.4.4 runtime at
`~/.omo-daemonic/runtime/bun-1.4.4/bun`, never the Bun on `PATH`.

    scripts/bun install
    scripts/bun run typecheck
    scripts/bun run test

`scripts/bun` is a thin shim that execs the private runtime.
