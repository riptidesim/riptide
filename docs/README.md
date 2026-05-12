# Riptide Docs

Use this directory when the root [README](../README.md) gives you the shape and you need the operating details.

## First Pass

| Read | Use it for |
| --- | --- |
| [Install](install.md) | Hosted installer, repository build path, Docker, manual rebuilds, and upgrade notes. |
| [Campaign Runner](campaigns.md) | Run deterministic campaign sweeps with retained evidence and review handoff. |
| [Architecture](architecture.md) | Understand the adapter/persona/scenario stack, LiteSVM runtime, determinism, and dashboard artifacts. |
| [Scenario family catalog](scenario-catalog.md) | Browse the generated 25-family protocol-class matrix, claim levels, fixture paths, and result hashes. |
| [Case-study corpus readiness](case-study-corpus.md) | Read the local case-study matrix, executed evidence, claim boundaries, and next actions. |
| [Guided simulations](guided-sim.md) | Use `.riptide/sim/` for dynamic Rust-authored protocol flows that don't fit static TOML. |
| [Vision](vision.md) | Understand the lab-not-oracle stance, what Riptide claims, and what it explicitly does not claim. |
| [Trust and review path](trust.md) | Rerun the flagship proof, inspect evidence surfaces, and understand known limits. |
| [Submission package](submission-package.md) | Demo script, shot list, bounded submission copy, and links to the shipped trust surfaces. |
| [Solend-fork case study](case-studies/lending.md) | See the whale-share × price-shock grid that anchors the main product story. |
| [Studio](studio.md) | Open the localhost visual control plane: workspaces, evidence library, simulation diagram, dashboard drilldown, allowlisted job launcher, and `riptide-config` handoff. |
| [Static demo](static-demo.md) | Build and deploy the mocked `riptide.run` root demo while preserving installer routes. |

## Reviewer And CI

| Read | Use it for |
| --- | --- |
| [Campaign Runner](campaigns.md) | Validate retained campaign roots with `riptide review` and rerun selected cases. |
| [Evidence packs](pack.md) | Learn the `.riptide/pack/<run-id>/` shape emitted by `riptide run` and `riptide replay`. |
| [Reviewer command](reviewer.md) | Validate a pack with `riptide review` without rerunning the engine. |
| [Guided simulations](guided-sim.md) | Review guided artifacts with `riptide sim review` or `riptide review`. |
| [QA benchmarks](qa-benchmarks.md) | Run the reusable stress/dev-UX benchmark harness and interpret its outputs. |
| [CI handoff](ci-handoff.md) | Pin a replay proof in GitHub Actions with a canonical hash. |
| [Audit handoff packet](audit-handoff.md) | Use the launch/review checklist, reviewer ask, and follow-up issue template. |
| [Adapter lineage](adapter-lineage.md) | Record and inspect adapter provenance, inferred assumptions, unsupported fields, and JSON IDL lint coverage. |

## Supporting Material

| Path | Contents |
| --- | --- |
| [Benchmarks](benchmarks/agent-scaling.md) | Agent-scaling results and reproducibility notes. |
| [Assets](assets/) | Screenshots used by the README and docs. |
| [Toolchain](../TOOLCHAIN.md) | Rust, Node, Solana CLI, SBF, and platform-tool pins. |

Top-level files such as [VISION.md](../VISION.md) and [TOOLCHAIN.md](../TOOLCHAIN.md) stay at the repo root so GitHub surfaces them on the project landing page.
