# OmO Agent Viewer

A small, read-only terminal companion for browsing OmO Native delegated tasks and following their transcripts.

This is a separate project from `oh-my-openagent`. Its code, dependencies, Git history, and build output live outside the upstream checkout, so replacing or upgrading that checkout cannot overwrite the viewer. It reads the task store on disk and does not patch or import upstream code.

## Requirements

- Bun 1.3.14 or newer
- OmO Native with task records enabled

## Run

From this directory:

```sh
bun install
bun run build
bun run start
```

To install the `omo-agents` command globally, run `bun add --global .` from this directory. Then run it inside an OmO project; the default project is the current directory. (`bun link --global` only registers this package so projects can link it as a dependency.)

```sh
omo-agents --project ~/src/my-project
omo-agents --project ~/src/my-project --state-dir /path/to/senpi-task
```

The viewer discovers the configured OmO Native agent directory and falls back to the legacy in-project `.omo/senpi-task` store when it contains task records. Use `--state-dir` if the store is somewhere else.

## Keys

- `↑` / `↓`: select a main session or task
- `Enter`: open the selected session or follow a task transcript
- `Esc`: return to the main session
- `j` / `k`: scroll the open transcript
- `g`: jump to the latest transcript output
- `p`: pause or resume refresh
- `r`: refresh now
- `q`: quit

The viewer refreshes task records and transcript logs every second by default. Set `--refresh-ms` from 250 to 10000 to change the interval. It only reads task-store files.

## Development

```sh
bun test
bun run build
```

The task-store layout is discovered from OmO Native's `senpi-task` store. If upstream changes that on-disk layout, adjust the standalone reader or pass the new location with `--state-dir`; upgrading the upstream source will not overwrite this project.
