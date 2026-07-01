---
name: riptide-assess
description: >-
  Assess a Solana program with Riptide — run deterministic, guided LiteSVM
  simulations against the real on-chain program to produce a risk assessment
  with reproducible evidence. Use when the user says "assess my protocol", "is
  my protocol safe", "run Riptide on this", "give me a risk assessment", or
  "riptide-assess", or points you at an Anchor/Solana lending, AMM, perps,
  liquid-staking, or stablecoin repo and wants one agent-led flow from program
  source to an assessment report. Detects the protocol family, scopes what the
  guided sim must handle (typed args, Pyth/Switchboard oracle-account bytes,
  liquidator/keeper actors, multi-instruction sequences), authors and runs the
  sim, then returns assessment evidence and exact rerun commands.
user-invocable: true
---

# riptide-assess

Riptide runs **deterministic guided simulations** of Solana programs to produce
a **risk assessment** backed by reproducible evidence. This skill is the single
front door: point it at a Solana program repo, answer at most three scoped
questions, and it detects the protocol family, authors a project-owned Rust
simulation crate that drives the program's real `.so` under stress, runs it over
a declared fixed-seed sweep, and emits an assessment (`assessment.md` +
`assessment.json`) plus an executive brief — with the exact commands to
reproduce every figure.

There is one execution path: a **guided simulation**. The agent authors the
adapter, sim crate, personas, flows, and invariants — the user does not.

The outcome is an `assessment.md` / `assessment.json` plus an evidence pack and
the **exact rerun commands** over a declared, fixed-seed region. This is
**simulation evidence over a declared region — not an audit signoff**, not
formal verification, and not a mainnet prediction. Hold that boundary in every
claim you make.

## First Contact / Prerequisites (auto-install)

If `riptide --help` fails, the CLI is not installed. Install it with the command
below — **it works from any directory**. You are running inside the user's
program repo, not the skill folder, so do not rely on a bare `install.sh` path:

```bash
curl -fsSL https://riptide.run/install | sh
```

The skill also bundles an `install.sh` at the root of its package that wraps this
same installer; use it only if you have `cd`'d into the skill's own directory.
Both are idempotent — safe to re-run.

**Riptide is NOT on npm** — do not `npm i riptide`. The CLI scaffolds a
project-owned Rust crate that builds against a vendored runtime (there is no
separate engine binary), so the host needs:

- `rustup` / `cargo` + `rustc`
- `node >= 20` and `npm`
- the Solana SBF toolchain (`cargo-build-sbf`, via the Anza/Solana install)

Confirm the install before doing anything else:

```bash
riptide --version     # expect v0.12.0 or newer
riptide doctor        # static health check of the environment + adapter
```

## How To Run (the CLI surface)

Use **only** these commands. Never invent flags or subcommands.

- `riptide init` — scaffold a thin `.riptide/` bootstrap in the target repo.
- `riptide readiness <dir> [--json]` — read-only repo classification check.
- `riptide doctor` — static adapter/environment health check.
- `riptide sim generate --adapter <adapter.toml>` — scaffold the project-owned
  guided-sim crate (`.riptide/sim`).
- `riptide sim refresh --adapter <adapter.toml> --dir .riptide/sim` — regenerate
  builders after IDL changes without overwriting hand-authored flows.
- `riptide sim run <sim-dir> [--iterations N] [--flows N] [--seed HEX] --out <dir>`
  — execute the sweep; reads `[sim.sweep]` from `Riptide.toml`.
- `riptide sim surface <artifact-dir> --sim <sim-dir>` — build the cartography
  root (campaign-summary.json + risk-surface.json + retention-manifest.json).
- `riptide sim lint <sim-dir>` — validate the sim manifest.
- `riptide sim review <artifact-dir>` — review a run's retained evidence.
- `riptide sim fork` / `riptide sim debug` — fork-cache and debug helpers.
- `riptide review <guided-sim-root>` — root reviewer over a surfaced root.
- `riptide assess <guided-sim-root> [--input <json>] [--brief] [--html|--pdf]`
  — ingest a surfaced root and emit the assessment.

The parameter sweep lives in the `[sim.sweep]` block of
`.riptide/sim/Riptide.toml` — it is configuration, **not** a CLI flag. Do not
pass the sweep on the command line; `riptide sim run` reads it from the TOML.

## The flow — routing

Detect → Scope → Setup → Run → Surface → Assess. Work in one continuous session.
Each step's depth lives in a focused file:

1. **Detect the protocol family and scope what the guided sim must handle** (the
   full A–F trigger taxonomy + the three scoped questions) →
   [detect-and-scope.md](./detect-and-scope.md)
2. **Author the adapter, generate the sim crate, fill the setup seams, author
   flows + the sweep** →
   [setup.md](./setup.md)
3. **Run, surface, and assess** (smoke → full sweep → cartography root → final
   render) →
   [run-and-assess.md](./run-and-assess.md)

Supporting depth:

- **Authoring patterns (guided sim)** — the library code to wire when triggers
  fire (oracle-account construction, third-party dispatch, the sweep scaffold) →
  [authoring-patterns.md](./authoring-patterns.md)
- **Honesty Discipline (non-negotiable — read this)** — the 7 honesty rules, the
  three runtime-enforced gates, and fail-fast/file-an-issue guidance →
  [honesty.md](./honesty.md)
- **Worst-case playbook** — per-archetype worst case to hunt, axis to sweep,
  deciding invariant/metric, signal trap, honest framing →
  [worst-case-playbook.md](./worst-case-playbook.md)
- **References + file index** →
  [resources.md](./resources.md)
