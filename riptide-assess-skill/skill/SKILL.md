---
name: riptide-assess
description: >-
  Produce a Riptide Assessment of a Solana Economic Protocol: deterministic,
  fixed-seed simulations of the program's real compiled binary, with Coverage,
  Gaps, Firing-Checked invariants, Breaches with replay commands, and the exact
  commands that reproduce every figure. Use when the user says "assess my
  protocol", "is my protocol safe", "run Riptide on this", "give me a risk
  assessment", or "riptide-assess", or points at a lending, AMM, perps,
  liquid-staking, stablecoin or other value-bearing Solana program. Runs start
  to finish without pausing for input; an optional Steering Hint narrows scope.
user-invocable: true
---

# riptide-assess

Riptide produces an **Assessment** of a Solana program: simulation evidence
over a declared, fixed-seed region, gathered by running the program's real
compiled binary, together with the exact commands that reproduce it. An
Assessment is simulation evidence, **not an audit signoff**, not formal
verification and not a mainnet prediction. Hold that boundary in every claim.

## The command

There is one user command: `/riptide-assess`, invoked inside the user's repo.
Everything else in this bundle is a stage of that command, not a separate
entry point.

The **Steering Hint is the only input.** It is optional free text passed with
the command, such as a program path (`programs/vault`), a focus area
("liquidation cascades") or a Depth request ("deep"). Read it once at the start
and let it narrow scope. With no Steering Hint, assess the whole repo at
Default Depth.

The Skill never pauses for input. Wherever a fact is missing or two readings
are plausible, pick the reading the evidence favours, record it as an
assumption in the **Scope Declaration**, and continue. Each assumption carries
its reason and the overriding Steering Hint that would change it, so correcting
the Skill takes one rerun:

```text
assumption: target is programs/vault (two programs found; vault holds the pool accounts)
reason:     only programs/vault declares a token vault and a price account
override:   /riptide-assess programs/staking
```

The Scope Declaration sits at the top of every Assessment and records which
Depth ran.

## Depth

| Depth | Chosen by | Region | Budget |
|---|---|---|---|
| Default | no Depth in the Steering Hint | critical (P0) instructions on one stress axis | `seeds_per_value = 4`, at most 7 axis values, 3 repair attempts per failure |
| Deep | a Steering Hint requesting depth ("deep", "thorough") | P0 and P1 instructions over several axes plus a 2-D interaction sweep | `seeds_per_value = 8`, at most 11 values per axis, 5 repair attempts per failure |

## The Engine

The **Engine** is the deterministic simulation machinery: the `riptide` CLI and
the sim runtime. The Skill is its only driver. Users never run it, and the
Assessment never directs them to.

- Pass `--json` to every Engine command that accepts it and read the result
  from stdout. On an error, follow the `next` field before improvising.
- No Engine command reads stdin. A command that appears to wait is a defect to
  report, not a prompt to answer.
- Every file the Skill writes to drive the Engine (`Riptide.toml`, adapters,
  the sim crate) is an **Internal Artifact** in the `.riptide/` **Workspace**.
  The agent owns them; the user is never directed to write or edit one.
- Never commit anything. The last line of every delivery names `.riptide/` as
  the one thing left for the user to commit, so anyone can rerun the
  Assessment.

### Prerequisites

Check the host before any stage runs: `cargo`, `cargo-build-sbf` and
`node >= 20`. If `riptide --version` fails, install the Engine:

```bash
curl -fsSL https://riptide.run/install | sh
```

If a prerequisite is missing, or the Engine install fails, stop and deliver a
**Blocker Report** that names the missing piece. Do not start a partial run.

### Engine commands

Use only these commands; never invent flags or subcommands.

- `riptide init` — scaffold the Workspace (non-interactive).
- `riptide readiness <dir> --json` — read-only repo classification evidence.
- `riptide doctor --json` — toolchain presence plus adapter load and lint.
- `riptide sim generate --adapter <adapter.toml>` — scaffold the sim crate.
- `riptide sim refresh --adapter <adapter.toml> --dir .riptide/sim` —
  regenerate builders after IDL changes without touching authored flows.
- `riptide sim lint <sim-dir>` — validate the sim manifest.
- `riptide sim run <sim-dir> [--iterations N] [--flows N] [--seed HEX] --out <dir>`
  — run the sweep declared in `[sim.sweep]`.
- `riptide sim debug <sim-dir> --seed <hex>` — replay one seed with verbose
  labelled transaction logging.
- `riptide sim review <artifact-dir> --json` — review a run's retained evidence.
- `riptide sim surface <artifact-dir> --sim <sim-dir>` — build the cartography
  root the Assessment reads.
- `riptide sim fork` — fetch or reuse an account snapshot cache.
- `riptide review <guided-sim-root> --json` — review a surfaced root.
- `riptide assess <guided-sim-root> --json [--input <json>] [--brief]` — render
  the Engine Output for the Assessment.

## The flow

Classify → Scope → Setup → Run → Firing Check → Repair → Surface → Report

Work in one continuous session and emit one short progress line as each stage
starts (`riptide-assess: setup — generating the sim crate`), so a long run does
not look hung. A stage may be handed to a subagent where the host supports
one; nothing in the flow requires it.

When `.riptide/` already exists, reuse it: keep the authored adapter, flows,
invariants and sweep, refresh builders from the current IDL, repair what broke,
and author flows only for new instructions. Rerun the region the previous
Assessment declared.

### 1. Classify

Decide whether the target is an **Economic Protocol** (a value-bearing
mechanism: pooled assets, prices, solvency) from IDL and source evidence, then
name its family. A target that is not an Economic Protocol ends the run with an
**Out-of-Scope Note** that points to code-level auditing tools. A protocol that
matches no known family is still in scope. →
[classify-and-scope.md](./classify-and-scope.md)

### 2. Scope

Check every critical instruction against the A–F authoring triggers, pick the
worst case to hunt and the stress axis, choose the **Floor Invariants** for the
family, and write the Scope Declaration. →
[classify-and-scope.md](./classify-and-scope.md),
[family-library.md](./family-library.md),
[worst-case-playbook.md](./worst-case-playbook.md)

### 3. Setup

Author the adapter, generate the sim crate, fill every setup seam with
deterministic facts, and author flows, personas, invariants and the sweep. →
[setup.md](./setup.md), [authoring-patterns.md](./authoring-patterns.md)

### 4. Run

Lint, run a one-seed smoke, then run the full sweep. →
[run-and-surface.md](./run-and-surface.md)

### 5. Firing Check

Prove each invariant can fire by injecting a known violation. An invariant
that has not passed its **Firing Check** never counts as held. →
[firing-check.md](./firing-check.md)

### 6. Repair

Classify each failure, repair the responsible layer, and rerun from the
earliest affected stage within the Depth's repair budget. →
[repair.md](./repair.md)

### 7. Surface

Build the cartography root (`campaign-summary.json`, `risk-surface.json`,
`retention-manifest.json`) that the Engine reads to render its output. →
[run-and-surface.md](./run-and-surface.md)

### 8. Report

Render the **Engine Output** with `riptide assess`, write the
**Assessment Context** next to it (Scope Declaration, Depth, Coverage, Gaps, invariant
provenance, Firing Check results, Breaches), and deliver. Every **Breach**
carries its seed replay command and a **Causal Trace**. When **Coverage** is
zero, deliver a Blocker Report instead of an Assessment. →
[report.md](./report.md), [causal-trace.md](./causal-trace.md)

## Evidence rules

- **Coverage** is the instructions and actors the simulation exercised; every
  Assessment is graded by it. **Region Coverage** is the swept axes and cells
  the run probed. Never let one stand in for the other.
- Each part of the program the simulation did not exercise is a **Gap**, with
  the reason and what would unblock it. A Gap is never evidence of safety.
- Invariants the agent adds on top of the Floor Invariants are labelled as
  agent-authored.
- The honesty rules are non-negotiable: [honesty.md](./honesty.md).
- File index and references: [resources.md](./resources.md).
