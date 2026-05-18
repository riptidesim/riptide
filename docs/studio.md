# Riptide Studio

> Localhost visual control plane for Riptide. Browse workspaces, inspect
> evidence, view simulation graphs, drill into the existing run/replay
> dashboard, queue allowlisted jobs, and produce a `riptide-config`
> handoff prompt — without typing the underlying CLI command.

Studio is a CLI-bundled React + Vite app served by a Node HTTP server.
It is **localhost-only** by default, has **no generic shell endpoint**,
never silently runs an agent, and never publishes or pushes anything.

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
| `--case-studies-root <dir>` | _(none)_ | Each immediate subfolder becomes a case-study workspace; missing `.riptide/` folders are shown so they can be bootstrapped from Studio. |
| `--no-open` | n/a | Studio prints the URL and blocks on Ctrl-C. CI/headless safe. |

## What you get

- **Overview** — current workspace, latest run collection, recent runs and
  reports, queued jobs, next actions.
- **Evidence library** — runs, campaigns, packs, retained cases,
  guided-sim artifacts, readiness reports, scenarios, and adapters,
  with status/verdict/coverage/confidence/canonical-hash columns and
  filters.
- **Report viewer** — Reviewable artifacts render the current human report
  sections locally, with raw JSON/TOML fallback for non-Markdown artifacts,
  source-artifact links, and an explicit dashboard drilldown link for run,
  pack, and collection artifacts.
- **Simulation diagram** — adapter -> semantics -> personas/scenario/campaign
  -> invariants -> engine -> runs -> reports/packs flow rendered as a
  deterministic SVG layout. Click a node for source path + meaning.
- **Dashboard drilldown** — embeds the existing `riptide run --serve` /
  `riptide replay --serve` dashboard at `/dashboard`, scoped to a
  selected artifact via `?source=<workspace-relative-path>`.
- **Launch jobs** — preview the exact `argv` and `cwd` Studio would run,
  queue an allowlisted job, watch live `stdout`/`stderr`, and cancel
  while running. Job records persist under `.riptide/studio/jobs/`.
- **Agent chat handoff** — guided prompt flows for setup/configuration,
  scenario design, invariant design, report explanation, scale campaign
  planning, and reviewer packets. Each flow collects a short questionnaire
  and fills the chat composer with files, constraints, and gates. Studio
  does not edit files or launch an agent unless the user sends the prompt.
  When it does launch Claude Code or Codex, Studio uses the agent CLI's
  non-interactive approval-bypass flag so browser-based runs do not get
  stuck waiting for per-tool permission prompts.

## Case-study walkthrough path

```sh
riptide studio --no-open --case-studies-root <path-to-case-studies>
```

1. **Open Studio.** Pick a case-study workspace that already has
   `.riptide/` evidence. The current pre-submission smoke path uses
   `raydium-cp-swap` because it has adapters, scenarios, campaigns,
   packs, readiness reports, and persisted job history.
2. **Open Adapter.** Verify the simulation diagram renders workspace,
   adapter, persona/scenario/campaign, engine, invariant, run, and pack
   nodes with readable labels. Click a node to inspect its source path
   and meaning.
3. **Open Reports.** The viewer should default to a report-capable
   artifact such as `run-collection.json`; pick a `pack` to read the
   Markdown summary or trace inline.
4. **Open Dashboard drilldown.** From a run, pack, or collection in
   Reports, click *Open dashboard*. Confirm the dashboard opens with
   `workspace=<id>` and a scoped `source=<workspace-relative-path>`.
5. **Open Campaigns.** Pick a `*.campaign.toml`, click *Preview run*,
   and confirm Studio shows the allowlisted `argv`, `cwd`, expected
   artifact, and notes before any queue action.
6. **Open Agent chat.** Pick a guided prompt flow, fill the short
   questionnaire, and confirm Studio prepares a bounded prompt without
   editing files or launching an agent unless the user sends it.

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
| `campaign-run` | `campaign`, `harness` (optional) | `riptide campaign run <campaign> [--harness <harness>]` |
| `review` | `pack`, `out` (optional) | `riptide review <pack> --quiet [--out <out>]` |
| `readiness` | `out` (optional) | `riptide readiness . --json --out <out>` |

Per-param validation:

- All path params must be **workspace-relative** (no absolute paths,
  no `..` escape, no shell metacharacters).
- When `harness` is omitted for `campaign-run`, Studio auto-attaches
  `.riptide/harness` if that directory exists in the active workspace.
- Every `argv` element is checked against a forbidden token set
  (`push`, `publish`, `release`, `login`, `install`, `uninstall`,
  `rm`, `mv`, `delete`, `deploy`).

## Trust boundary

- Bind defaults to `127.0.0.1`. `0.0.0.0` and friends are refused at
  startup.
- Mutating `POST` endpoints are purpose-built: job queue/plan/cancel,
  config intent, workspace init, project registry, native folder picking,
  and agent chat thread/run/abort. Studio does not expose a generic shell
  request body.
- The job launcher uses `child_process.spawn(node, ["dist/src/index.js", ...argv])`
  with `shell: false` — no shell ever interprets the command.
- The config-intent endpoint never writes files. It returns JSON +
  prompt + proposed targets only.
- Agent chat endpoints spawn the selected local coding agent only after
  the user sends a prompt. The spawned agent can edit the active workspace
  and run local commands according to that prompt; Studio records the
  thread-scoped workspace diff after the turn.
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
```

The CLI server serves the React bundle from `cli/assets/studio/`.
New Studio views must land in `cli/studio-app/`, then be rebuilt into
the shipped bundle before they affect the served UI.
