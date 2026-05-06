# Riptide Studio

> Localhost visual control plane for Riptide. Browse workspaces, inspect
> evidence, view simulation graphs, drill into the existing run/replay
> dashboard, queue allowlisted jobs, and produce a `riptide-config`
> handoff prompt — without typing the underlying CLI command.

Studio is a CLI-bundled React + Vite app served by a Node HTTP server
that reads only from the local filesystem. It is **localhost-only** by
default, has **no generic shell endpoint**, never silently runs an
agent, and never publishes or pushes anything.

## Start it

```sh
riptide studio --no-open --case-studies-root /path/to/case-studies
```

Useful flags:

| Flag | Default | Notes |
|------|---------|-------|
| `--port <port>` | `4173` | Falls back to nearby ports if taken. |
| `--host <host>` | `127.0.0.1` | Loopback only (`127.0.0.1`, `localhost`, `::1`). Other binds are rejected. |
| `--workspace <path>` | `cwd` | Workspace root. Same as the positional argument. |
| `--case-studies-root <dir>` | _(none)_ | Each immediate subfolder with `.riptide/` becomes a case-study workspace. |
| `--no-open` | n/a | Studio prints the URL and blocks on Ctrl-C. CI/headless safe. |

## What you get

- **Overview** — current workspace, latest run collection, recent runs and
  reports, queued jobs, next actions.
- **Evidence library** — runs, campaigns, packs, retained cases,
  guided-sim artifacts, readiness reports, scenarios, and adapters,
  with status/verdict/coverage/confidence/canonical-hash columns and
  filters.
- **Report viewer** — Markdown reports rendered locally, with raw JSON
  fallback for non-Markdown artifacts.
- **Simulation diagram** — adapter -> semantics -> personas/scenario/campaign
  -> invariants -> engine -> runs -> reports/packs flow rendered as a
  deterministic SVG layout. Click a node for source path + meaning.
- **Dashboard drilldown** — embeds the existing `riptide run --serve` /
  `riptide replay --serve` dashboard at `/dashboard`, scoped to a
  selected artifact via `?source=<workspace-relative-path>`.
- **Launch jobs** — preview the exact `argv` and `cwd` Studio would run,
  queue an allowlisted job, watch live `stdout`/`stderr`, and cancel
  while running. Job records persist under `.riptide/studio/jobs/`.
- **Config handoff** — chat-like form that produces a structured
  `config-intent.json` and a copyable `riptide-config` prompt. Studio
  does not edit files for you.

## Lending demo path

```sh
riptide studio --no-open --case-studies-root /home/ailton/Work/riptide/case-studies
```

1. **Open Studio.** Pick the `lending` workspace from the workspace
   selector (top bar).
2. **Open Simulation diagram.** Verify the adapter, personas, scenario,
   campaign, invariants, engine, runs, and packs nodes render with
   readable labels and source paths.
3. **Open Report viewer.** Pick a `run` (e.g. `whale-shock-grid`) or a
   `pack` and read the Markdown report inline.
4. **Open Dashboard drilldown.** Confirm the embedded run/replay
   dashboard loads with a scoped `?source=` URL.
5. **Open Launch jobs.** Pick `riptide run`, set scenario to
   `whale-shock-grid`, click *Preview command*, then *Queue this job*.
   The job appears with `cwd`, `argv`, `output_path`, and live log
   tails. The CLI process is the same one `riptide run whale-shock-grid`
   would invoke directly — Studio just spawns it with explicit `argv`.
6. **Open Config handoff.** Fill in protocol class `lending`, repo path
   pointing at a new program, risk goal `no_bad_debt`, scenario target
   `whale-shock-grid`, evidence boundary `campaign-grid`, and click
   *Generate handoff*. Copy the prompt and paste it into a fresh
   `riptide-config` agent context — Studio will not run it for you.

## Allowlisted job kinds

Studio rejects every payload outside this set. Each kind is mapped to
an explicit `argv` array — no shell interpolation, no path traversal,
no publish/push/release tokens.

| Kind | Required params | argv shape |
|------|-----------------|------------|
| `run` | `scenario` (optional) | `riptide run [<scenario>] --quiet` |
| `replay` | `config` | `riptide replay <config> --quiet` |
| `campaign-validate` | `campaign` | `riptide campaign validate <campaign>` |
| `campaign-plan` | `campaign` | `riptide campaign plan <campaign>` |
| `campaign-run` | `campaign` | `riptide campaign run <campaign>` |
| `review` | `pack`, `out` (optional) | `riptide review <pack> --quiet [--out <out>]` |
| `readiness` | `out` (optional) | `riptide readiness . --json --out <out>` |

Per-param validation:

- All path params must be **workspace-relative** (no absolute paths,
  no `..` escape, no shell metacharacters).
- Every `argv` element is checked against a forbidden token set
  (`push`, `publish`, `release`, `login`, `install`, `uninstall`,
  `rm`, `mv`, `delete`, `deploy`).

## Trust boundary

- Bind defaults to `127.0.0.1`. `0.0.0.0` and friends are refused at
  startup.
- The only `POST` endpoints are `/api/studio/jobs`,
  `/api/studio/jobs/plan`, `/api/studio/jobs/:id/cancel`, and
  `/api/studio/config/intent`. Everything else is `GET`-only.
- The job launcher uses `child_process.spawn(node, ["dist/src/index.js", ...argv])`
  with `shell: false` — no shell ever interprets the command.
- The config-intent endpoint never writes files. It returns JSON +
  prompt + proposed targets only.
- No external network calls are required for core Studio operation.

## Persistence

Job records are written to `.riptide/studio/jobs/<id>.json` so a
browser refresh does not erase the work list. On restart Studio
hydrates persisted jobs and surfaces any that were running at shutdown
as `cancelled` with a warning row.

## Frontend layout

```text
cli/studio-app/        React + Vite TypeScript workspace
cli/studio-app/src/    App.tsx, components/, views/, api.ts, styles.css
cli/assets/studio/     Production bundle (index.html + assets/)
cli/assets/studio.html Legacy single-file Phase 2 shell (fallback only)
```

The CLI server tries the React bundle first and falls back to the
legacy HTML if no bundle is present. New Studio views must land in
`cli/studio-app/`; the legacy file is a migration source only.
