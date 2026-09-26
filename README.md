# Riptide

<p align="center">
  <img src="docs/assets/riptide-logo.svg" alt="Riptide" width="100%">
</p>

**A risk Assessment of your Solana Economic Protocol, from one command.**

Riptide runs deterministic, fixed-seed simulations against your program's real
compiled binary and hands back an Assessment: simulation evidence over a
declared region, with the exact commands that reproduce every figure. You get
it by invoking one skill, `/riptide-assess`, in your own repo.

<div align="center">
  <video src="https://github.com/user-attachments/assets/7f3475d2-5459-4abc-983a-72d6af0f5f05" width="720" controls></video>
</div>

> [!IMPORTANT]
> An Assessment is simulation evidence over a declared region. It is not an
> audit signoff, formal verification or a mainnet prediction.

## Install the Skill

In Claude Code, from the plugin marketplace:

```text
/plugin marketplace add riptidesim/riptide
/plugin install riptide@riptide
```

In any other agent host, including Codex:

```bash
npx skills add riptidesim/riptide
```

Your machine needs `cargo`, the Solana SBF toolchain (`cargo-build-sbf`) and
`node >= 20`. There is nothing else to install: on first use the Skill fetches
the exact Engine version it pins.

## Run it

Open your program repo in your agent and run:

```text
/riptide-assess
```

That is the only command, and it never stops to ask you anything. Add an
optional Steering Hint in plain words to narrow it:

```text
/riptide-assess programs/vault
/riptide-assess focus on liquidation cascades
/riptide-assess deep
```

Everything the Skill writes lives in `.riptide/` in your repo; your own source
stays untouched. Commit `.riptide/` when it finishes, so anyone can rerun the
Assessment. Run `/riptide-assess` again after you change your program: it
reuses that Workspace, reruns the same region and reports what moved.

## Read your Assessment

The Skill delivers one of three things.

**An Assessment** (`.riptide/assessments/<NNN>/assessment.md`), in this order:

- **Scope Declaration** — every assumption the Skill made instead of asking
  you, why, and the Steering Hint that overrides it. Read this first; if an
  assumption is wrong, rerun with its override.
- **Coverage** — the instructions and actors the simulation actually
  exercised. Grade the Assessment by it: a thin Coverage bears little weight.
- **Gaps** — each part of your program that was not exercised, why, and what
  would unblock it. A Gap is never evidence of safety.
- **Invariants** — every check the run applied, labelled as a Floor Invariant
  (required for your protocol's shape) or agent-authored. An invariant only
  counts as held after its Firing Check proved it can fail.
- **Breaches** — each Firing-Checked invariant that failed, with its seed, its
  replay command and a Causal Trace that walks the failure tick by tick. A
  Breach is simulation evidence of a reachable state, for your team to judge.
- **Delta** — on a rerun, what changed since the previous Assessment: metrics
  that moved, Gaps opened or closed, and Coverage of new instructions.
- **Engine Output** — the deterministic figures, byte-for-byte reproducible
  from the recorded seeds.

Its `assessment-context.json` records the Skill and Engine versions that ran,
and every rerun command names that exact Engine version, so the figures don't
depend on whatever happens to be installed.

**A Blocker Report**, instead, when nothing could be simulated: a missing
prerequisite, a program that does not build. It names each blocker and what
would unblock it, and claims nothing about your program.

**An Out-of-Scope Note**, within about a minute, when your program is not an
Economic Protocol (no pooled value, prices or solvency). It points you to
code-level auditing tools instead.

## What it does not claim

- LiteSVM runs your real compiled program but does not model gossip, voting,
  PoH or consensus.
- An Assessment covers the declared region and Depth only. Nothing outside the
  swept axes and seeds is evidence either way.
- Riptide is not a fuzzer and not a mainnet forecast. Pair it with code-level
  audits; it complements them.

## Contributing

Riptide's contributor docs start at [CONTRIBUTING.md](CONTRIBUTING.md). The
product stance is in [VISION.md](VISION.md). Licensed under MIT or Apache-2.0,
see [LICENSE](LICENSE).
