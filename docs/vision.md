# Vision

**Purpose:** Why Riptide exists, who it's for, and why it is positioned as a lab, not an oracle.

**Audience:** potential adopters, grant reviewers, and contributors deciding whether the stance matches their problem.

The repo-root [`VISION.md`](../VISION.md) carries the short, visible-at-landing version of this framing. This file is the detailed companion. Read it if you've already seen the one-pager and want to understand what the stance commits Riptide to — and, more pointedly, what it commits Riptide *not* to.

## Lab, not oracle

Riptide runs an experiment the dev picked. It does not tell the dev what is wrong with their program.

Operationally this means three things. First, every run is reproducible from the adapter TOML and the persona TOML alone — same seed in, same bytes out — so two readers looking at the same grid are looking at the same artifact, not two plausible runs. Second, a cell that comes back with bad debt is a point in parameter space where the program's math lost headroom; it is not a bug report. The dev is the one who decides whether that point matters. Third, the claim Riptide defends is a *mapping* claim ("the danger region looks like this"), not a *verdict* claim ("this program is unsafe"). The case study at [`case-studies/solend-fork.md`](case-studies/solend-fork.md) is the shipping example of that discipline: it maps a 3×3 whale × shock region and stops there. The reader draws the conclusion.

## Two paths in

- **Path A — write your own experiments.** If you already know what you're testing for, author a run-config + policies + adapter TOML directly. The safe-vs-risky lending walkthrough at [`examples/`](../examples/) and the resource-grinder generic demo are the canonical starting points.
- **Path B — let the scenarios skill propose a catalog.** The `riptide-scenarios` Claude Code skill at [`skills/riptide-scenarios/SKILL.md`](../skills/riptide-scenarios/SKILL.md) reads your adapter + IDL, classifies plausible failure modes, and proposes 3–5 ranked starter experiments as run-configs under `fixtures/scenarios/<adapter>/`. It does not autorun — the dev picks what to run.

Both paths produce the same artifact shape on disk, and both run deterministically against the real BPF program in LiteSVM. Nothing about Path B relaxes the lab-not-oracle posture: the skill proposes, the dev picks, the engine runs the pick.

## What Riptide is explicitly not

- **Not a validator fork.** Riptide runs on LiteSVM in-process. It does not model gossip, vote, PoH, or any consensus-layer behavior. When validator-level parity matters, the `solana-test-validator` parity path at `engine/tests/t05_lending_integration.rs` is the diagnostic reference — see [`architecture.md`](architecture.md).
- **Not a MEV bot simulator.** Agents are declarative personas with a trigger DSL, not searchers racing for tx ordering. Riptide simulates economic stress on program logic, not adversarial sequencing.
- **Not a fuzzer or static analyzer.** Riptide does not generate bytes looking for panics; it runs bounded scenarios the dev declared. Use a fuzzer for input-space coverage; use Riptide for parameter-region mapping.
- **Not an audit replacement.** Riptide maps a region. An audit reasons about the program. Both are useful; they answer different questions.

## Adversarial-review posture

Every claim Riptide ships is meant to survive an adversarial reviewer asking "prove it." That shapes the engine in three concrete ways: (1) determinism is enforced by the `t15_e2e_determinism` integration test, not left as a design intent; (2) replay mode reproduces the Solend June 2022 whale-risk incident byte-for-byte and asserts a declared `no_bad_debt` invariant fires at the cascade tick, so historical claims are re-runnable on the reviewer's machine; (3) adapter TOMLs and persona TOMLs carry the full experiment — no hidden state in the binary, no drift between the artifact and the code.

When Riptide shows a grid, a reviewer can re-derive it. That is the whole posture.

## Deeper reading

- [`architecture.md`](architecture.md) — how the six-layer stack is assembled and what LiteSVM actually models.
- [`install.md`](install.md) — how to run it locally end-to-end.
- [`case-studies/solend-fork.md`](case-studies/solend-fork.md) — the load-bearing example: a parameter-region mapping on a real lending program.
