# Riptide Docs

Use this directory when the root [README](../README.md) gives you the shape and you need the operating details.

## First Pass

| Read | Use it for |
| --- | --- |
| [Install](install.md) | Hosted installer, repository build path, Docker, manual rebuilds, and upgrade notes. |
| [Guided simulations](guided-sim.md) | Use `.riptide/sim/` for Rust-authored protocol flows, then run, surface, assess, and review them. |
| [Protocol Assessment](protocol-assessment.md) | Turn Risk Plans, guided-sim sweeps, blockers, and non-findings into a send/readiness report. |
| [Architecture](architecture.md) | Understand the adapter stack, the LiteSVM-backed guided-sim runtime, codegen, and determinism. |
| [Case-study corpus readiness](case-study-corpus.md) | Read the local case-study matrix, executed evidence, claim boundaries, and next actions. |
| [Vision](vision.md) | Understand the lab-not-oracle stance, what Riptide claims, and what it explicitly does not claim. |
| [Trust and review path](trust.md) | Walk the guided-sim evidence path, inspect evidence surfaces, and understand known limits. |
| [Submission package](submission-package.md) | Demo script, bounded submission copy, and links to the shipped guided-sim surfaces. |
| [Solend-fork case study](case-studies/lending.md) | See the whale-share × price-shock grid that anchors the main product story. |

## Reviewer

| Read | Use it for |
| --- | --- |
| [Reviewer command](reviewer.md) | Validate a guided-sim evidence root with `riptide review` without rerunning the simulation. |
| [Guided simulations](guided-sim.md) | Review guided artifacts with `riptide sim review` or `riptide review`. |
| [Audit handoff packet](audit-handoff.md) | Use the launch/review checklist, reviewer ask, and follow-up issue template. |
| [Protocol assessment report template](templates/protocol-assessment-report.md) | Fill a coverage matrix, evidence list, claim boundary, and reviewer checklist for protocol-team handoff. |

## Supporting Material

| Path | Contents |
| --- | --- |
| [Benchmarks](benchmarks/agent-scaling.md) | Agent-scaling results and reproducibility notes. |
| [Assets](assets/) | Screenshots used by the README and docs. |
| [Toolchain](../TOOLCHAIN.md) | Rust, Node, Solana CLI, SBF, and platform-tool pins. |

Top-level files such as [VISION.md](../VISION.md) and [TOOLCHAIN.md](../TOOLCHAIN.md) stay at the repo root so GitHub surfaces them on the project landing page.
