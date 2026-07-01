# Riptide Assess — Solana protocol risk-assessment skill

A Claude Code skill that turns a Solana program repo into a reproducible
risk assessment, backed by deterministic guided LiteSVM simulations of the real
on-chain program.

## Overview

Founders shipping to mainnet, and the auditors reviewing them, need risk
evidence that someone else can reproduce — not a vibe, not a one-off script that
only ran on one laptop. Riptide answers that need by running **deterministic,
guided LiteSVM simulations against the real program `.so`**: it constructs the
external account bytes the program reads (oracle prices, attestations), drives
the protocol's actual lifecycle under an exogenous stress swept over a declared,
fixed-seed region, and records where the deciding metric moves. The output is an
`assessment.md` / `assessment.json` plus an evidence pack and the exact commands
to reproduce every figure.

This is **simulation evidence over a declared region — not an audit signoff**,
not formal verification, and not a mainnet prediction.

## What it does

One agent-led flow, **Detect → Scope → Setup → Run → Surface → Assess**:

- **Detect** the protocol family (lending, AMM, perps, LST, stablecoin) from
  semantics, source, and IDL evidence.
- **Scope** what the guided sim must handle via the A–F trigger taxonomy — typed
  enum/struct args, oracle-account byte construction, third-party (liquidator /
  keeper) actors, multi-instruction sequences, dynamic `remaining_accounts`, CPI
  bootstrapping — then ask at most three scoped questions.
- **Setup** the project-owned Rust sim crate: author the adapter, generate the
  crate, and fill the `TODO(setup)` seams with deterministic facts.
- **Run** the fixed-seed sweep declared in `[sim.sweep]` — smoke first, then the
  full sweep.
- **Surface** the cartography root (`campaign-summary.json`,
  `risk-surface.json`, `retention-manifest.json`) the assessment reads.
- **Assess** — render `assessment.md` + `assessment.json` (plus an executive
  brief), with a non-negotiable honesty discipline enforced as runtime gates
  (positive control, real-program execution, determinism).

## Install

If `riptide --help` fails, install the CLI via the public installer — this works
from any directory (idempotent, safe to re-run):

```bash
curl -fsSL https://riptide.run/install | sh
```

This skill also bundles an equivalent `install.sh` at its package root (it wraps
the same installer); run `bash install.sh` only from within the skill's own
directory.

**Riptide is NOT on npm** — do not `npm i riptide`. The CLI scaffolds a
project-owned Rust crate that builds against a vendored runtime (no separate
engine binary), so the host needs:

- `rustup` / `cargo` + `rustc`
- `node >= 20` and `npm`
- the Solana SBF toolchain (`cargo-build-sbf`, via the Anza/Solana install)

Verify before doing anything else:

```bash
riptide --version     # expect v0.12.0 or newer
riptide doctor        # static health check of the environment + adapter
```

## Structure

```
riptide-assess-skill/
├── skill/
│   ├── SKILL.md                 # Router: mission, prerequisites, CLI surface, flow
│   ├── detect-and-scope.md      # Detect the family + the A–F trigger taxonomy
│   ├── setup.md                 # Adapter, sim crate, deterministic setup seams
│   ├── run-and-assess.md        # Run → Surface → Assess
│   ├── authoring-patterns.md    # Oracle bytes, third-party dispatch, sweep scaffold
│   ├── honesty.md               # The non-negotiable honesty discipline + gates
│   ├── worst-case-playbook.md   # Per-archetype worst case to hunt
│   └── resources.md             # References + file index
├── examples/
│   └── assessment-input.json    # Example AssessmentInputs shape
├── install.sh                   # Riptide CLI bootstrap (idempotent)
├── README.md                    # This file
└── LICENSE                      # MIT
```

The router (`skill/SKILL.md`) keeps the entry gate and the CLI surface inline,
and links each step to its focused file for progressive disclosure.

## License

MIT License — see [LICENSE](LICENSE) for details.
