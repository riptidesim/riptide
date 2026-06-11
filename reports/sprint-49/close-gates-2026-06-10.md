# Sprint 49 close gates - 2026-06-10

Internal close artifact for the cold-repo-readiness sprint (vendored guided-sim
runtime in generated crates, locally-installable CLI tarball, cold-repo
end-to-end proof, local merge of the bridge line to `main`). All five frozen
engine/surface pins stayed byte-identical; both flagship `assess` deliverables
verified byte-identical against their authoritative pins. The sprint change set
is packaging/TS + docs + report-log only: the scoped regression diff over the
runtime surfaces is empty for this sprint's commits.

## The keystone — cold-repo end-to-end proof (green)

Full verbatim log: `reports/sprint-49/cold-repo-e2e.md` (committed in
`a6735ce`). In a path-isolated sandbox (`env -i`, no `Work/riptide` PATH
component, installed CLI realpath inside a clean npm prefix), the packaged
tarball (`riptide-cli-0.9.1.tgz`, shasum `444801cfe4b3a34c5e9788f64331c2010359be74`)
ran the full flow on the Agio case-study program:

- `riptide init` scaffolded `.riptide/` in the fresh repo.
- `riptide sim generate` emitted a crate with vendored relative deps
  (`riptide-sim = { path = "vendor/riptide-sim" }`); grep for `Work/riptide`
  over the generated crate and authored sim sources was empty.
- `riptide sim run` built the crate cold against the vendored runtime and
  completed the 7×4 manifest-declared sweep 28/28; `cargo metadata` resolved
  both runtime crates from `.riptide/sim/vendor/`.
- `riptide sim surface` wrote the cartography artifacts with all three
  execution-honesty gates passing (positive_control, lifecycle_executed,
  determinism; surface hash `de748996f19bb373…`).
- `riptide assess` rendered the cartography report: 28/28 completed,
  12 invariant-failed (42.8571%), reproducing the known Agio
  lender-bad-debt gradient (0% through 3000 bps, 100% from 4000 bps) from a
  cold install, with the Execution Honesty section status `pass`.

The sandbox also caught a real cold gap, fixed in `a7ab80c`: `sim generate`
resolved `idl_path`/`program_so` against the adapter directory only, so
canonical `.riptide/adapters/` adapters failed generate in a fresh repo;
generate now uses the same repo-root fallback as lint/validate, with a
regression test.

## Scoped regression diff (no unintended engine/fixture changes)

This sprint's commits (base = prior close `6c2b776`):

```sh
$ git diff --name-only 6c2b776..HEAD -- fixtures engine riptide-sim riptide-sim-macros programs
```

```text
(empty)
```

Full merged line on `main` (base = pre-merge main `c73e430`):

```sh
$ git diff --name-only c73e430..HEAD -- fixtures engine riptide-sim riptide-sim-macros programs
```

```text
riptide-sim/src/bootstrap.rs
riptide-sim/src/dispatch.rs
riptide-sim/src/lib.rs
riptide-sim/src/oracle.rs
riptide-sim/src/runner.rs
riptide-sim/src/world.rs
riptide-sim/tests/oracle.rs
```

All seven paths are the prior sprint's intended authoring-helper / honesty-gate
/ bridge seams, already verified at that close. `fixtures/`, `engine/`,
`riptide-sim-macros/`, and `programs/` are untouched across the whole line.

## Frozen hash gates (five pins, byte-identical)

```sh
$ sha256sum fixtures/scenarios/lending/whale-shock-grid/simulation-result.json fixtures/campaigns/lending/whale-shock-cartography/expected-risk-surface.json
```

```text
60f72adee15451af60f559cdfb9609813b54c34565f7c76fe7e5cf8495a42470  fixtures/scenarios/lending/whale-shock-grid/simulation-result.json
11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f  fixtures/campaigns/lending/whale-shock-cartography/expected-risk-surface.json
```

```sh
$ env RIPTIDE_ENGINE_BIN=target/release/riptide-engine bash scripts/perpetuals-scratch.sh
```

```text
>>> perps scratch run: agents=20 ticks=30 seed=42 personas=leveraged-long leveraged-short delta-neutral-farmer liquidator funding-arbitrageur
    run A: 1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878
    run B: 1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878
>>> OK — perps scratch scenario is deterministic across two replays
    hash: 1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878
```

```sh
$ env RIPTIDE_ENGINE_BIN=target/release/riptide-engine bash scripts/amm-scratch.sh
```

```text
>>> amm scratch run: agents=20 ticks=30 seed=42 personas=lp-provider arbitrageur sandwich-attacker swapper rug-puller
    run A: 5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f
    run B: 5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f
>>> OK — amm scratch scenario is deterministic across two replays
    hash: 5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f
```

```sh
$ bash fixtures/replays/lending-whale-bad-debt/rerun.sh
```

```text
wrote pack: /home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/.riptide/pack/replay-lending-whale-bad-debt (run-id=replay-lending-whale-bad-debt, canonical-hash=6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1)
```

All five pins match their frozen values:

- whale-shock-grid `60f72adee15451af60f559cdfb9609813b54c34565f7c76fe7e5cf8495a42470`
- perps scratch `1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878`
- AMM scratch `5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f`
- lending replay `6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1`
- Sprint 39 surface `11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f`

## Flagship assess pins (identical, no movement this sprint)

### Lending

Regenerated with the canonical out path the pin was taken from (the assessment
embeds the campaign root label, so byte-identity requires `tmp/flagship-run`):

```sh
$ node cli/dist/src/index.js campaign run fixtures/campaigns/lending/whale-shock-cartography/campaign.toml --out tmp/flagship-run
$ node cli/dist/src/index.js assess tmp/flagship-run/campaign_40a5f239691a --out /tmp/riptide-t06-lending-pin-WbLRN7
$ sha256sum /tmp/riptide-t06-lending-pin-WbLRN7/assessment.md /tmp/riptide-t06-lending-pin-WbLRN7/assessment.json
```

```text
aa9ab5894ceb9454695004a8d4b537bf506f72fd60ce7bac82ff0465d4107d21  /tmp/riptide-t06-lending-pin-WbLRN7/assessment.md
2de4739b505241dd9e73e715a661bf13a55a68e4e302045be8e882c5a6a29f9e  /tmp/riptide-t06-lending-pin-WbLRN7/assessment.json
```

Byte-identical to the authoritative pins (`aa9ab589…` / `2de4739b…`); campaign
digest `40a5f239691a…` unchanged.

### Defunds

Regenerated per the recorded procedure from the foreign repo
(`case-studies/defundspg`, working tree clean at HEAD `cdec7d7`):

```sh
$ git show HEAD:.riptide/assess-inputs.json > /tmp/riptide-t06-defunds-inputs.json
$ node ~/Work/riptide/riptide/cli/dist/src/index.js assess .riptide --input /tmp/riptide-t06-defunds-inputs.json --html --out /tmp/riptide-t06-defunds-pin-kYwJZD
$ sha256sum /tmp/riptide-t06-defunds-pin-kYwJZD/assessment.md /tmp/riptide-t06-defunds-pin-kYwJZD/assessment.json
```

```text
4c71f43da597a00310eb2c1981dd2903d0beca49b51a6e9dc676deaa1c160c92  /tmp/riptide-t06-defunds-pin-kYwJZD/assessment.md
4b9f593cd0707e75893d569e0602f5cc6fc84907453b55ebbd944d299d0be9cb  /tmp/riptide-t06-defunds-pin-kYwJZD/assessment.json
```

```sh
$ git show HEAD:.riptide/assessment.md | sha256sum; git show HEAD:.riptide/assessment.json | sha256sum
```

```text
4c71f43da597a00310eb2c1981dd2903d0beca49b51a6e9dc676deaa1c160c92  -
4b9f593cd0707e75893d569e0602f5cc6fc84907453b55ebbd944d299d0be9cb  -
```

Both flagship deliverables byte-identical to their authoritative pins
(lending `aa9ab589…`/`2de4739b…`, Defunds `4c71f43d…`/`4b9f593c…`).

## CLI suite (twice) + riptide-sim suite

Full verbatim stdout/stderr committed at
`reports/sprint-49/npm-test-2026-06-10-run1.log`,
`reports/sprint-49/npm-test-2026-06-10-run2.log`, and
`reports/sprint-49/cargo-test-riptide-sim-2026-06-10.log`.

```sh
$ npm --prefix cli test   # run 1
```

```text
ℹ tests 747
ℹ suites 0
ℹ pass 742
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
```

```sh
$ npm --prefix cli test   # run 2
```

```text
ℹ tests 747
ℹ suites 0
ℹ pass 742
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
```

```sh
$ cargo test -p riptide-sim
```

```text
running 48 tests
test result: ok. 48 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.14s
running 3 tests
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s
```

## Merge status

`feat/guided-sim-cartography-bridge` merged into `main` locally with a true
merge commit `3a93c62` (no squash). `main` is NOT pushed; push stays gated on
explicit approval. All pins above were verified at the merged HEAD.

## Process gates

No push, no publish (`docker push` / `gh release create` / `npm publish` /
`cargo publish` unused), no `--amend`, no `git add -A`, no engine/surface hash
retune. Distribution remains vendoring + local tarball install only.
