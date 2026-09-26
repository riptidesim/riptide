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

**Version Pin:** `0.12.0`, the one Engine version this Skill release names.
The Assessment Context records it as `engine_version`, and every Breach's
replay command runs it as `npx --yes @riptide/cli@<Version Pin>`.

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

Use only these commands; never invent flags or subcommands. Pass `--json` to
every one of them: each writes one envelope to stdout, and on failure its
`error.code` and `error.next` name the repair to make.

- `riptide init --json` — scaffold the Workspace (non-interactive).
- `riptide readiness <dir> --json` — read-only repo classification evidence,
  plus toolchain presence and adapter load and lint under `data.health`. A
  warning-only health check is still `ok: true`; a failing one is
  `health_checks_failed`, with the full report still in `data`.
- `riptide sim generate --adapter <adapter.toml> --json` — scaffold the sim
  crate with the family's Floor Invariants wired in, listed under
  `data.floor_invariants`. Unresolved tick-0 seams come back as
  `sim_setup_gaps`.
- `riptide sim refresh --adapter <adapter.toml> --dir .riptide/sim --json` —
  regenerate builders after IDL changes without touching authored flows.
- `riptide sim lint <sim-dir> --json` — validate the sim manifest.
- `riptide sim run <sim-dir> [--iterations N] [--flows N] [--seed HEX] --out <dir> --json`
  — run the sweep declared in `[sim.sweep]`. A compile error is
  `sim_build_failed`; a failing iteration is `sim_run_failed` with its seed.
- `riptide sim debug <sim-dir> --seed <hex> --json` — replay one seed with
  verbose labelled transaction logging, returned as `data.log`.
- `riptide sim surface <artifact-dir> --sim <sim-dir> --json` — build the cartography
  root the Assessment reads.
- `riptide sim fork --address <pubkey> --out <path> --json` — fetch or reuse an
  account snapshot cache.
- `riptide review <path> --json` — review a run's artifact directory, a
  surfaced root or a retained case.
- `riptide assess <guided-sim-root> --json [--input <json>] [--brief] --out <dir>`
  — render the Engine Output for the Assessment.
- `riptide validate <assessment-dir> --json` — the gate on whatever the run
  delivers. It recognises an Assessment (intact Engine Output, a schema-valid
  Assessment Context reporting every Floor Invariant, no unfired invariant
  as held and every Breach with its pinned replay command and Causal Trace,
  the required `assessment.md` sections), an Out-of-Scope
  Note or a Blocker Report, and names it as `data.kind`. Failures list every
  problem under `data.problems`.

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
name its family. The verdict follows the evidence rules: one cited economic
signal puts the target in scope, and only positive evidence of no signal at
all takes it out. A target that is not an Economic Protocol ends the run,
about a minute in, with an **Out-of-Scope Note** that points to code-level
auditing tools and passes `riptide validate`. A protocol that matches no known
family is still in scope and continues through the generic fallback. →
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

Prove each invariant, every Floor Invariant included, can fire by injecting a
known violation. An invariant that has not passed its **Firing Check** never
counts as held; it is downgraded to a Gap. →
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
provenance, Firing Check results, Breaches), compose `assessment.md` from
both, and run `riptide validate` on the result. Deliver only once that gate
passes. Every **Breach**
carries its exact seed replay command against the pinned Engine and a
**Causal Trace** written from the replay log, and is worded as simulation
evidence, never as a vulnerability. When **Coverage** is
zero, deliver a Blocker Report instead of an Assessment, naming every Gap; the
gate rejects a zero-Coverage Assessment. Neither an Out-of-Scope Note nor a
Blocker Report describes a risk surface. →
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
