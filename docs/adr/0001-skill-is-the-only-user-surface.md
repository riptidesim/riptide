---
status: accepted
---

# The Skill is the only user surface; the CLI is an agent API

Riptide is used only through the `/riptide-assess` Skill. The Engine CLI still exists, but it is an API that the Skill drives: it has no interactive prompts, emits `--json` everywhere, returns structured `next` hints on errors, and has no human-facing docs, banner or wizard. The Skill installs the Engine on first use, pinned to one exact version, and owns every Internal Artifact (`Riptide.toml`, adapters, sim crate) in the `.riptide/` Workspace. We did this so that users run Riptide on their codebase the way they run auditor-skill or solana-cpi-safety-skill, without giving up the deterministic Engine that distinguishes Riptide from them.

## Considered Options

- **Pure Markdown skill with no Engine.** Rejected. Riptide would compete directly with auditor-skill's checklist corpus, and it would give up reproducible simulation evidence, which is its only real differentiator.
- **One `riptide assess --auto` pipeline command.** Rejected. The agent has to author flows and invariants between `sim generate` and `sim run`, then repair and rerun. A single command hides that loop.
- **Keep the CLI human-friendly but undocumented.** Rejected. The dead human UX (wizard, banners, getting-started copy) keeps drifting and costs tests.

## Consequences

- A CLI with no human docs is intentional. Don't "fix" it by adding them back.
- `riptide-config` and `riptide-narrative` are stages inside the Skill, not separate skills.
- The Skill and the Engine are released together from this monorepo, so the exact Version Pin can't drift.
