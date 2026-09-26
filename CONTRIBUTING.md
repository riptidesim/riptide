# Contributing to Riptide

Riptide is an agentic harness: users reach it only through the
`/riptide-assess` Skill, which drives the deterministic Engine. This page is
for people working on the Skill or the Engine. For using Riptide, see the
[README](README.md).

## Read First

These are binding for every change:

- [CONTEXT.md](CONTEXT.md) — the domain glossary. Use its terms exactly in
  code, tests, docs and commit messages, and avoid the terms it lists under
  _Avoid_.
- [ADR 0001 — the Skill is the only user surface](docs/adr/0001-skill-is-the-only-user-surface.md).
  The Engine CLI is an agent API: `--json` everywhere, structured `next`
  hints on errors, no prompts, no banners and no human docs. Do not add
  human-facing CLI docs back.
- [ADR 0002 — deterministic Engine Output, agent-authored Assessment Context](docs/adr/0002-deterministic-engine-output-vs-agent-context.md).
  Engine Output stays byte-pinned; everything the agent writes lives beside it
  and is checked for structure only.
- [Architecture](docs/architecture.md) — the Engine's pieces, the command
  contract and the determinism model. [Guided simulations](docs/guided-sim.md)
  covers the sim crate the Skill authors.

## Ground Rules

1. Open an issue or discussion for large changes, new protocol families, or
   anything that may change deterministic output.
2. Keep one logical change per PR.
3. Preserve the claim boundary: an Assessment is simulation evidence, not an
   audit signoff.
4. Do not include private planning labels, sprint IDs, or task IDs in the
   repo.

## Setup

Required for development:

- Git
- Rust and Cargo
- Node.js 20+
- Solana SBF tooling for changes that build on-chain programs

The pinned toolchain versions live in [TOOLCHAIN.md](TOOLCHAIN.md).

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
npm --prefix cli ci
npm test
```

## Project Shape

- `riptide-assess-skill/` — the one Skill bundle. `skill/` is exactly what an
  install copies.
- `cli/` — the TypeScript Engine CLI: Workspace scaffolding, validation, sim
  codegen, run orchestration, Engine Output and the validation gate.
- `riptide-sim/` and `riptide-sim-macros/` — the Rust guided-sim runtime the
  generated sim crate builds against.
- `fixtures/` — adapters and fixture programs the tests run against.
- `.claude-plugin/marketplace.json` — the plugin marketplace manifest.

## Tests

Tests assert external behaviour only, at two seams:

1. The `riptide` command runners, with injected stdout and stderr, against
   fixture Workspaces: exit codes, the JSON envelope and files written.
2. The Skill bundle as files: frontmatter, stages, required phrases and the
   Version Pin.

Never assert internal functions or intermediate structures, and never assert
agent-written prose byte-for-byte.

| Change | Start with | Verify with |
| --- | --- | --- |
| Skill | `riptide-assess-skill/skill/` | `npm test` |
| Engine CLI | `cli/src/` | `npm test` |
| Sim runtime | `riptide-sim/src/`, `riptide-sim/tests/` | `cargo fmt`, `cargo clippy -- -W clippy::all`, `cargo test -p riptide-sim` |
| Adapter fixture | `fixtures/adapters/` | `npm test` |
| Docs | `README.md`, `CONTRIBUTING.md`, `docs/` | `npm test` (the doc checks run in it) |

## Determinism

Determinism is the main project discipline. If a change alters byte-stable
Engine Output, the flagship pin tests fail; treat that as a blocker until you
can explain why the new bytes are correct, and say so in the PR description.

## Releasing

The Skill and the Engine are released together from one commit, so the Version
Pin can't drift. `scripts/release.mjs` moves the CLI version and every
Version Pin at once, then publishes the CLI to npm:

```bash
node scripts/release.mjs bump <version>   # CLI, shrinkwrap, Version Pin, examples, marketplace
node scripts/release.mjs publish          # clean tree, scope check, npm test, npm publish
```

`node scripts/release.mjs check` fails on any drift; `npm test` runs it.

## Pull Requests

Before opening a PR:

1. Check `git status` and keep unrelated dirty files out of the change.
2. Run `npm test`, plus the Rust checks when the sim runtime changed.
3. Include the command output summary in the PR description.
4. Mention any skipped tests and why they were skipped.

Use Conventional Commits:

```text
docs(readme): describe reading an Assessment
fix(cli): preserve workspace-relative job paths
feat(skill): add the Delta to reruns
test(sim): cover determinism hash stability
```

Useful scopes include `sim`, `cli`, `skill`, `adapter`, `docs`, `release`,
and `ci`.

Pushing to `main` deploys the web apps, so land work through a branch and a
PR.

## Reporting Issues

Open an issue at [github.com/riptidesim/riptide](https://github.com/riptidesim/riptide).
Include the `/riptide-assess` invocation and Steering Hint, the Skill and
Engine versions from the delivered output, the delivered report, and your OS
and tool versions.

## License

By contributing, you agree that your contributions will be licensed under the
repository's dual MIT or Apache-2.0 license, as described in [LICENSE](LICENSE).
