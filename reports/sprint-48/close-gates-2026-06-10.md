# Sprint 48 close gates - 2026-06-10

Internal close artifact for the trustworthy-skill sprint (guided-sim classify
spine, worst-case playbook, Pyth `PriceUpdateV2` + third-party-dispatch helpers,
execution-honesty gates, three-fixture eval). All five frozen engine/surface
pins stayed byte-identical; both flagship `assess` deliverables verified
byte-identical against their current authoritative pins. No engine, fixture, or
campaign-rendering surface changed: the scoped regression diff below shows the
only runtime changes are the intended `riptide-sim` helper/gate seams.

## Scoped regression diff (no unintended engine/fixture changes)

```sh
$ git diff --name-only 8be544d..HEAD -- fixtures engine riptide-sim riptide-sim-macros programs
```

```text
riptide-sim/src/bootstrap.rs
riptide-sim/src/dispatch.rs
riptide-sim/src/lib.rs
riptide-sim/src/oracle.rs
riptide-sim/tests/oracle.rs
```

All five paths are the intended authoring-helper and honesty-manifest seams
(oracle builder, third-party dispatch, bootstrap manifest parsing, exports, and
the oracle price-read test). `fixtures/`, `engine/`, `riptide-sim-macros/`, and
`programs/` are untouched.

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

## Flagship assess pins

### Lending (identical to the prior pins)

Regenerated with the canonical out path the pin was taken from:

```sh
$ node cli/dist/src/index.js campaign run fixtures/campaigns/lending/whale-shock-cartography/campaign.toml --out tmp/flagship-run
$ node cli/dist/src/index.js assess tmp/flagship-run/campaign_40a5f239691a --out /tmp/riptide-s48-lending-pin-evIcew
$ sha256sum /tmp/riptide-s48-lending-pin-evIcew/assessment.md /tmp/riptide-s48-lending-pin-evIcew/assessment.json
```

```text
aa9ab5894ceb9454695004a8d4b537bf506f72fd60ce7bac82ff0465d4107d21  /tmp/riptide-s48-lending-pin-evIcew/assessment.md
2de4739b505241dd9e73e715a661bf13a55a68e4e302045be8e882c5a6a29f9e  /tmp/riptide-s48-lending-pin-evIcew/assessment.json
```

Byte-identical to the prior pins (`aa9ab589…` / `2de4739b…`). Campaign digest
`40a5f239691a64309db2bc9a49ae14127f2c25a75260c802149f3f0a2c4277f2` and
risk-surface sha `11c60685…` also unchanged.

Reproduction caveat (verified, not a code change): the assessment embeds the
campaign root label, so the pin reproduces only from the canonical
`tmp/flagship-run` out path. Regenerating into a differently-named out dir
(e.g. `tmp/s48-flagship-run`) yields different bytes
(`d8ec2d93…` / `574e4bfc…`) — confirmed identical behavior with the CLI built
at the branch base `8be544d` and at the prior close commit `2ebe4d7`, so the
renderer did not move.

### Defunds (identical to its current authoritative pin; prior movement documented)

Regenerated per the recorded procedure from the foreign repo
(`case-studies/defundspg`, working tree clean at HEAD `cdec7d7`):

```sh
$ git show HEAD:.riptide/assess-inputs.json > /tmp/riptide-s48-defunds-head-assess-inputs.json
$ node cli/dist/src/index.js assess .riptide --input /tmp/riptide-s48-defunds-head-assess-inputs.json --html --out /tmp/riptide-s48-defunds-assess-zH0ERi
$ sha256sum /tmp/riptide-s48-defunds-assess-zH0ERi/assessment.md /tmp/riptide-s48-defunds-assess-zH0ERi/assessment.json
```

```text
4c71f43da597a00310eb2c1981dd2903d0beca49b51a6e9dc676deaa1c160c92  /tmp/riptide-s48-defunds-assess-zH0ERi/assessment.md
4b9f593cd0707e75893d569e0602f5cc6fc84907453b55ebbd944d299d0be9cb  /tmp/riptide-s48-defunds-assess-zH0ERi/assessment.json
```

```sh
$ git show HEAD:.riptide/assessment.md | sha256sum; git show HEAD:.riptide/assessment.json | sha256sum
```

```text
4c71f43da597a00310eb2c1981dd2903d0beca49b51a6e9dc676deaa1c160c92  -
4b9f593cd0707e75893d569e0602f5cc6fc84907453b55ebbd944d299d0be9cb  -
```

Byte-identical to the artifacts committed in that repo's finalization commit
`cdec7d7` ("Finalize Defunds Riptide assessment", 2026-06-04). The older pins
(`assessment.md` `ddb3ed72b0442a2f6f5bcf6b7f0e32f600c7786068c5b1ca6cf2edee32d5684c`,
`assessment.json` `780794193b4b9f9ee1a5e8cd8a3babc19e8a1fdfa94dbcd6b98a7caacd51bf6a`)
were superseded by that pre-branch finalization (it updated
`.riptide/assess-inputs.json` and regenerated the deliverables) — recorded here
as the old→new movement:

- Defunds `assessment.md`: `ddb3ed72…` -> `4c71f43da597a00310eb2c1981dd2903d0beca49b51a6e9dc676deaa1c160c92`
- Defunds `assessment.json`: `78079419…` -> `4b9f593cd0707e75893d569e0602f5cc6fc84907453b55ebbd944d299d0be9cb`

This branch did not move the bytes: the CLI built at the branch base `8be544d`
produces the identical `4c71f43d…` / `4b9f593c…` from the same inputs.

### Case-study guided-sim surfaces (from the fixture eval)

Fresh end-to-end re-runs produced `risk-surface.json` bytes identical to the
committed case-study pins:

```text
anemone  c69d402734a32b82672f476b7bca033207ed4e8668ec6884a2a89596c7e26f1b  (== committed)
agio     de748996f19bb373ef7afb03152cac0880456b37dd40f59d964271e6a5eec8fa  (== committed)
defunds  cb9bc99c579fd454bc7097a3b4f4e172b373351fb25286229cd64fc79161f629  (== committed)
```

## Three-fixture eval (green)

Full verbatim log: `reports/sprint-48/fixture-eval.md`; procedure + expected
answers recorded alongside the feature spec. All three fixtures reproduced
their pinned verdicts with all three execution-honesty gates green:

| Fixture | Expected | Result | Gates |
| --- | --- | --- | --- |
| anemone | LP-outflow onset at the stated line, solvency held | `lp_outflow_material` 0% at 0–200, 100% at 300/400/490 (12/24); solvency never fired | positive_control ✓ lifecycle_executed ✓ determinism ✓ |
| agio | lender bad-debt onset ~33% (4000 bps) | `lender_bad_debt` 0% at 0–3000, 100% at 4000/5000/6000 (12/28) | positive_control ✓ lifecycle_executed ✓ determinism ✓ |
| defunds | dilution HELD across 0–50% | 0 fires, flat 0%, `dilution_loss`/`early_overpayment` = 0.0 everywhere; derived `ready_to_send` | positive_control ✓ lifecycle_executed ✓ determinism ✓ |

## CLI suite (twice) + riptide-sim suite

Full verbatim stdout/stderr committed at
`reports/sprint-48/npm-test-2026-06-10-run1.log`,
`reports/sprint-48/npm-test-2026-06-10-run2.log`, and
`reports/sprint-48/cargo-test-riptide-sim-2026-06-10.log`.

```sh
$ npm --prefix cli test   # run 1
```

```text
ℹ tests 743
ℹ suites 0
ℹ pass 738
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
```

```sh
$ npm --prefix cli test   # run 2
```

```text
ℹ tests 743
ℹ suites 0
ℹ pass 738
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
test result: ok. 48 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.33s
running 3 tests
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.16s
```

## Process gates

No push, no publish (`docker push` / `gh release` / `npm publish` /
`cargo publish` unused), no `--amend`, no `git add -A`, no engine/surface hash
retune, no merge of this branch.
