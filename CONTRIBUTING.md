# Contributing to Riptide

Riptide is a deterministic multi-agent simulator for Solana programs. Keep
contributions small, reproducible, and easy to review.

For product usage, start with the [README](README.md). For deeper design
context, use the [docs index](docs/README.md).

## Start Here

1. Open an issue or discussion for large changes, new protocol classes, or
   anything that may change deterministic output.
2. Keep one logical change per PR. Do not mix adapter work, engine changes,
   Studio work, and docs rewrites unless they are part of the same feature.
3. Preserve user-facing claim boundaries. Riptide produces simulation evidence,
   not audit signoff.
4. Do not include private planning labels, sprint IDs, or task IDs in public
   docs.

## Setup

Required for repository development:

- Git
- Rust and Cargo
- Node.js 20+
- Solana SBF tooling for changes that build on-chain programs

Install from a checkout:

```bash
git clone https://github.com/riptidesim/riptide
cd riptide
./install.sh
```

The pinned toolchain versions live in [TOOLCHAIN.md](TOOLCHAIN.md). The full
install, Docker, release, and upgrade paths live in [docs/install.md](docs/install.md).

## Project Shape

Riptide has two main runtime pieces:

- `riptide-sim/` - Rust simulation engine and LiteSVM runtime.
- `cli/` - TypeScript CLI, Studio server, job orchestration, validation, and
  dashboard assets.

The simulator is configured through files:

- adapters map programs, accounts, actions, observations, and invariants;
- personas describe agent behavior;
- guided simulations describe experiments;
- evidence packs and reports capture what ran.

Most new protocol work should add or improve those declared layers. Engine
changes are rare and should be justified by a capability that cannot be
expressed in TOML, guided simulations, or skills.

## Common Changes

| Change | Start with | Verify with |
| --- | --- | --- |
| Docs | `README.md`, `docs/`, or `CONTRIBUTING.md` | `git diff --check` and link review |
| Studio or CLI | `cli/src/`, `cli/studio-app/` | `npm --prefix cli test` |
| Engine | `riptide-sim/src/`, `riptide-sim/tests/` | `cargo test -p riptide-sim` |
| Adapter | `fixtures/adapters/` | relevant CLI tests |
| Skills | `skills/riptide-*/` | cold-read before/after output on the same repo |

If you change Studio source under `cli/studio-app/`, rebuild the bundled assets
before claiming the served app changed.

## Determinism

Determinism is the main project discipline. If a change alters byte-stable
simulation output, treat that as a blocker until you can explain why the new
bytes are correct.

For Rust simulation changes, run focused tests first, then the broader
simulation suite:

```bash
cargo test -p riptide-sim
```

For CLI or Studio changes:

```bash
npm --prefix cli test
```

When a hash or committed fixture output intentionally changes, include the
reason in the PR description and point reviewers to the affected fixture.

## Pull Requests

Before opening a PR:

1. Check `git status` and keep unrelated dirty files out of the change.
2. Run the smallest useful verification command, then any broader gate required
   by the touched area.
3. Include the command output summary in the PR description.
4. Mention any skipped tests and why they were skipped.
5. Keep public docs free of overclaiming and internal planning labels.

Use Conventional Commits:

```text
docs(readme): simplify studio-first landing page
fix(cli): preserve workspace-relative job paths
feat(adapter): add stablecoin guided simulation
test(sim): cover determinism hash stability
```

Useful scopes include `sim`, `cli`, `studio`, `adapter`, `skill`, `docs`,
`install`, and `ci`.

## Where To Read More

| Topic | Link |
| --- | --- |
| Studio workflow and trust boundary | [docs/studio.md](docs/studio.md) |
| Architecture and runtime model | [docs/architecture.md](docs/architecture.md) |
| Campaign Runner | [docs/campaigns.md](docs/campaigns.md) |
| Evidence packs | [docs/pack.md](docs/pack.md) |
| CI handoff | [docs/ci-handoff.md](docs/ci-handoff.md) |
| Adapter lineage | [docs/adapter-lineage.md](docs/adapter-lineage.md) |
| Case-study corpus | [docs/case-study-corpus.md](docs/case-study-corpus.md) |

## Reporting Issues

Open an issue at [github.com/riptidesim/riptide](https://github.com/riptidesim/riptide).
Include the OS, relevant tool versions, exact command, full error output, and a
minimal reproduction when possible.

For determinism regressions, include the expected hash, the actual hash, and the
fixture or simulation that produced it.

## License

By contributing, you agree that your contributions will be licensed under the
repository's dual MIT or Apache-2.0 license, as described in [LICENSE](LICENSE).
