# Riptide Docs

Use this directory when the root [README](../README.md) gives you the shape and you need the operating details.

## First Pass

| Read | Use it for |
| --- | --- |
| [Install](install.md) | Release path, source install, Docker, manual rebuilds, and upgrade notes. |
| [Architecture](architecture.md) | Understand the adapter/persona/scenario stack, LiteSVM runtime, determinism, and dashboard artifacts. |
| [Vision](vision.md) | Understand the lab-not-oracle stance, what Riptide claims, and what it explicitly does not claim. |
| [Solend-fork case study](case-studies/lending.md) | See the whale-share × price-shock grid that anchors the main product story. |

## Reviewer And CI

| Read | Use it for |
| --- | --- |
| [Evidence packs](pack.md) | Learn the `.riptide/pack/<run-id>/` shape emitted by `riptide run` and `riptide replay`. |
| [Reviewer command](reviewer.md) | Validate a pack with `riptide review` without rerunning the engine. |
| [CI handoff](ci-handoff.md) | Pin a replay proof in GitHub Actions with a canonical hash. |
| [Adapter lineage](adapter-lineage.md) | Record and inspect adapter provenance, inferred assumptions, unsupported fields, and JSON IDL lint coverage. |

## Supporting Material

| Path | Contents |
| --- | --- |
| [Benchmarks](benchmarks/agent-scaling.md) | Agent-scaling results and reproducibility notes. |
| [Assets](assets/) | Screenshots used by the README and docs. |
| [Toolchain](../TOOLCHAIN.md) | Rust, Node, Solana CLI, SBF, and platform-tool pins. |

Top-level files such as [VISION.md](../VISION.md) and [TOOLCHAIN.md](../TOOLCHAIN.md) stay at the repo root so GitHub surfaces them on the project landing page.
