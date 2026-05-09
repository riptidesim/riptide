# Reviewer-ready CI handoff

The Riptide evidence pack turns every run into a forwardable artifact.
The CI handoff turns that artifact into a **reproducible** one: a
stranger on a fresh GitHub Actions runner can rerun a committed proof,
assert its canonical hash, and forward the run URL as the
reviewer-facing source of truth.

This document covers two paths:

1. **In-repo handoff** — the workflow Riptide itself ships, which
   reruns the `lst-lending-contagion-proof` replay on every
   push and asserts the canonical SHA256
   `d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb`
   inside a valid pack.

2. **Downstream adoption** — a copy-friendly template you can drop
   into your own Solana program repo to pin **your own** replay to
   **your own** hash.

Neither path fetches a remote IDL at run time. Neither path runs an
LLM. Neither path needs secrets beyond the default `GITHUB_TOKEN`.
Every input is committed under git.

---

## In-repo handoff (Riptide's shipping CI)

**Workflow file:** `.github/workflows/contagion-proof-ci.yml`

The workflow runs on every push, every pull request, and on manual
`workflow_dispatch`. It does the following on a clean Ubuntu runner:

1. Checks out the repo fresh (no warm cache dependency — cold-start
   reproducibility is the promise).
2. Installs the Rust stable toolchain.
3. Downloads the pinned Solana release tarball from
   `anza-xyz/agave` and **verifies its SHA256 against the committed
   `scripts/ci/solana-release.sha256` file before extract**. No
   `curl | sh` — a swapped installer fails the checksum step and
   the workflow exits loudly.
4. Builds the three programs the contagion proof consumes:
   `lending_pool`, `admin_mock_oracle`, `liquid_staking`.
5. Runs the deterministic engine gate
   (`cargo test -p riptide-engine --release --features litesvm-backend
   --test replay_lst_lending_contagion_proof`) under `CI=1`, so a
   missing `.so` artifact panics instead of soft-skipping.
6. Runs the same fixture through the shipping CLI
   (`riptide replay fixtures/replays/lst-lending-contagion-proof/config.json
   --allow-invariant-violations`), which emits a pack at
   `.riptide/pack/replay-multi-lst-lending-contagion-proof-upstream/`.
7. Asserts the pack's `manifest.json.canonical_hash` matches the
   shipping hash via `scripts/ci/assert-canonical-hash.sh`.
8. Uploads the emitted pack as a workflow artifact so a reviewer can
   download the exact bytes produced by the cold-start run.

If the hash drifts, the shell script exits 1 with a diagnostic naming
expected, actual, and the pack manifest path.

### Supply-chain posture

The "cold-start reviewer proof" claim is only meaningful if a green
run cannot be an attacker-controlled run. Every external code path
the workflow executes is therefore either pinned to an immutable
reference or checksum-verified against a committed file before it
runs.

In the **in-repo workflow** (`.github/workflows/contagion-proof-ci.yml`):

- Every `uses:` reference pins to an **immutable commit SHA**, not a
  floating tag. `actions/checkout`, `dtolnay/rust-toolchain`,
  `actions/setup-node`, and `actions/upload-artifact` are all pinned
  this way, with the released version recorded as an inline comment
  so bumps are diff-reviewable.
- The Solana toolchain tarball downloads from `anza-xyz/agave`
  releases and its SHA256 verifies against
  `scripts/ci/solana-release.sha256` before extracting or running
  anything from it. Bumping Solana is a two-line commit (version +
  checksum); a swapped upstream release fails the verify step.
- `npm ci --ignore-scripts` in the CLI workspace skips every
  postinstall hook. The engine is built from source in the same job
  via `cargo test --release`, not fetched as a binary.
- No secrets beyond the default `GITHUB_TOKEN`.

In the **downstream template**
(`.github/workflows/riptide-handoff-template.yml.example`) the same
discipline carries over plus two extra surfaces:

- `npm install --global --ignore-scripts "$RIPTIDE_CLI_SPEC"` still
  skips the CLI's postinstall. Because that postinstall is what
  would normally drop the native `riptide-engine` binary at
  `<pkg-root>/bin/`, the template adds a dedicated "Provision
  riptide-engine (pinned + checksum-verified)" step that downloads
  `riptide-engine-<target-triple>` from the pinned Riptide release
  URL, verifies its SHA256 against
  `scripts/ci/riptide-engine.sha256`, and exports
  `RIPTIDE_ENGINE_BIN` via `$GITHUB_ENV` so every subsequent
  `riptide replay` call in the job finds it. Bumping
  `RIPTIDE_ENGINE_VERSION` must land together with a refreshed
  engine checksum — same discipline as the Solana pin.
- The **published `@riptide/cli` tarball ships
  `npm-shrinkwrap.json`**, so `npm install` uses that file as the
  authoritative dependency tree instead of re-resolving the caret
  ranges in `package.json` against the live npm registry. Every
  transitive npm dep version is byte-stable across time for a given
  `RIPTIDE_CLI_SPEC`. The template verifies the shrinkwrap is
  actually present after install and fails 1 with a diagnostic if
  it isn't (the most common cause is pinning a CLI version from
  before the published CLI started shipping the shrinkwrap).
- The "Fail closed on unresolved TODOs" pre-flight exits 1 before
  any third-party code runs if any `TODO_PIN_…` sentinel survives
  in `RIPTIDE_CLI_SPEC` / `RIPTIDE_ENGINE_VERSION` /
  `EXPECTED_CANONICAL_HASH` / `REPLAY_CONFIG` / `EXPECTED_RUN_ID`.

The pinned `uses:` SHAs + two checksum files (Solana toolchain,
Riptide engine binary) + the CLI's published shrinkwrap + the
committed canonical hash are the complete supply-chain surface a
reviewer inspects when deciding whether a green run is trustworthy.

**What to forward to a reviewer:**

- The green workflow run URL.
- The uploaded `contagion-proof-pack` artifact (`summary.md`,
  `trace.md`, `rerun.sh`, `manifest.json`, `inputs/`, `outputs/`).
- Optionally, the workflow's "Assert pack canonical_hash" step output,
  which prints the hash + manifest path.

---

## Downstream adoption

**Template file:**
`.github/workflows/riptide-handoff-template.yml.example` (drop the
`.example` suffix when you copy it).

The template is parameterized so every reviewer-facing claim is
anchored in **your** inputs — not Riptide's. In particular, the
template does **not** ship with any Riptide canonical hashes
hard-coded; those belong to Riptide's CI alone. Every downstream
adopter pins their own hash to their own replay fixture.

### Step-by-step

1. **Commit your replay fixture.** Use the same shape as Riptide's
   `fixtures/replays/` directories: a `config.json` that names your
   adapter(s), a trajectory directory per component, and — for
   multi-component replays — a declarative bridge.

2. **Run the replay locally once.** From your program repo's root:

   ```sh
   riptide replay path/to/your-replay/config.json --allow-invariant-violations
   ```

   The CLI prints a line like

   ```
   wrote pack: .riptide/pack/<run-id> (run-id=<run-id>, canonical-hash=<sha256>)
   ```

   Copy both `<run-id>` and `<sha256>` — you'll pin them into the
   workflow.

3. **Copy the template + reference scripts into your repo.** From the
   Riptide repo:

   ```sh
   cp .github/workflows/riptide-handoff-template.yml.example \
      /path/to/your/repo/.github/workflows/riptide-handoff.yml
   cp scripts/ci/assert-canonical-hash.sh \
      /path/to/your/repo/scripts/ci/assert-canonical-hash.sh
   cp scripts/ci/solana-release.sha256 \
      /path/to/your/repo/scripts/ci/solana-release.sha256
   cp scripts/ci/riptide-engine.sha256.example \
      /path/to/your/repo/scripts/ci/riptide-engine.sha256
   chmod +x /path/to/your/repo/scripts/ci/assert-canonical-hash.sh
   ```

   Regenerate `solana-release.sha256` if you pin a different Solana
   version than Riptide's current default — the file must match the
   version declared in your workflow, or the verify step fails.

   Edit `riptide-engine.sha256` to replace the `TODO_SHA256_…`
   placeholder with the actual SHA256 of the engine asset for the
   Riptide release tag you pin under `RIPTIDE_ENGINE_VERSION`. The
   `.example` file documents the regeneration command inline.

4. **Fill in the `TODO(downstream):` placeholders.** At minimum:
   - `RIPTIDE_CLI_SPEC` — pin a specific Riptide CLI version
     (e.g. `@riptide/cli@0.8.0`). The template ships the placeholder
     `@riptide/cli@TODO_PIN_EXACT_VERSION` AND a "Fail closed on
     unresolved TODOs" pre-flight step that refuses to run until
     every `TODO` placeholder is replaced. `--ignore-scripts` at the
     install step keeps the CLI's postinstall hook from executing
     during CI. Pin a version that ships
     `npm-shrinkwrap.json` and the install step fails 1 with a
     diagnostic if the shrinkwrap is missing.
   - `RIPTIDE_ENGINE_VERSION` — pin the matching engine release tag
     (e.g. `v0.8.0`). Because `--ignore-scripts` skipped the CLI's
     built-in binary fetch, the template includes an explicit
     "Provision riptide-engine (pinned + checksum-verified)" step
     that downloads `riptide-engine-<target-triple>` from the
     release URL, checksum-verifies it against
     `scripts/ci/riptide-engine.sha256`, and exports
     `RIPTIDE_ENGINE_BIN` so subsequent `riptide replay` calls find
     it. A bumped `RIPTIDE_ENGINE_VERSION` must land together with a
     refreshed engine checksum — same discipline as the Solana pin.
   - `EXPECTED_CANONICAL_HASH` — the hash from step 2.
   - `REPLAY_CONFIG` — the repo-relative path to your replay config.
   - `EXPECTED_RUN_ID` — the run-id slug from step 2.
   - The `uses:` pins — the template ships example SHAs for
     `actions/checkout`, `dtolnay/rust-toolchain`,
     `actions/setup-node`, and `actions/upload-artifact` that were
     current as of 2026-04-22. Refresh them via `gh api
     repos/<owner>/<repo>/git/ref/tags/<version>` when you want a
     newer release, and record the resolved version in an inline
     comment.
   - The `cargo build-sbf` steps — one per program your replay needs.
   - The Solana CLI install step — bump `SOLANA_VERSION` and
     regenerate `scripts/ci/solana-release.sha256` together.

5. **Commit + push.** The first run confirms the cold-start path
   works. If the pinned hash drifts, the assertion step fails loudly;
   investigate the drift before regenerating the pinned value.

6. **Forward the run URL.** That's the cold-start reproducibility
   surface a reviewer checks when they don't want to rerun the proof
   themselves.

### What downstream adopters own

- **Their own canonical hash.** The shipping Riptide hash
  (`d04feab9…`) applies to Riptide's shipping contagion proof and
  nothing else. Downstream adopters regenerate + pin their own.
- **Their own program builds.** Riptide does not prescribe a Solana
  CLI version for downstream adopters beyond "pin what your
  programs build against." The default in the template matches
  Riptide's current pin as a starting point.
- **Their own replay fixtures.** Riptide ships one contagion proof;
  downstream adopters ship whatever replay their review surface
  needs.

---

## Honest scope

- **Simulation evidence, not audit signoff.** A green CI run is a
  reproducibility check, not a security attestation. Forward the
  pack + workflow URL as "the engine produced byte-identical output
  on a clean runner," not as "this program is audited."
- **No cross-program validation against a mainnet IDL.** The workflow
  does not fetch IDLs, query RPC endpoints, or talk to anyone.
  Every input is committed.
- **No auto-regeneration on hash drift.** The workflow asserts, it
  does not heal. If the hash moves, a human investigates the drift
  before updating the pinned value.
- **No adapter-vs-IDL linting.** The workflow takes the adapter on
  trust; lineage metadata is reviewer-inspectable via `riptide
  lineage <adapter>` (see
  [`adapter-lineage.md`](adapter-lineage.md)). A machine check of
  the lineage block against the IDL is the next surface in this area
  and is not in today's workflow.
- **No `riptide doctor`, no adapter linter, no run-time
  adapter-error polish, no CLI colors / spinners / watch mode.** The
  DX hardening pass is future work; this handoff surface is
  evidence-focused.
- **No stablecoin or governance contagion bundles, no Cloud /
  alerting, no partner workflow integrations.**

---

## Troubleshooting

### `cargo-build-sbf` fails with an edition/rustc error

The Solana toolchain ships its own Rust. The on-chain program
workspace pins transitive dependencies so they stay compatible with
that bundled Rust (see `TOOLCHAIN.md`). If you've forked Riptide or
bumped Solana, re-read the `TOOLCHAIN.md` "Known workarounds" section
before bumping crates.

### The assertion script prints `could not read canonical_hash`

The pack manifest doesn't include the expected key, which usually
means the pack emitter didn't run. Check the CLI invocation's stderr
for a `wrote pack:` line.

### The hash drifted and I don't know why

Do not regenerate the expected hash until you understand the drift.
Common causes:

- The adapter TOML changed (any byte drift there propagates through
  the canonical SimulationResult hash).
- The program source changed (recompiled `.so` produced different
  bytes; run a diff between `expected-summary.json`'s pinned state
  and the run's output).
- The run-config changed (tick count, agent count, seed, scenario
  name).

When the drift is intentional, regenerate with the engine test's
`RIPTIDE_DUMP_EXPECTED=1` path and commit the new
`expected-summary.json` + workflow hash in the same PR so reviewers
see the intentional change.
