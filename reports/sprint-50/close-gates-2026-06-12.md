# Sprint 50 close gates - 2026-06-12

Internal close artifact for the self-serve-deliverable-quality sprint (honest
guided-sim default framing gated on the adapter, `riptide assess --brief`
five-section one-pager, the skill authoring the `AssessmentInputs` editorial
layer, the extended fixture eval + the three case-study briefs regenerated from
the tool). All five frozen engine/surface pins stayed byte-identical; the
flagship lending `assess` deliverables verified byte-identical against their
authoritative pins — the guided-sim adapter gate confined every framing change
to the guided-sim branch by construction. The sprint change set is cli/TS +
skill + reports only: the scoped regression diff over the runtime surfaces is
empty.

## The keystone — honest, sendable deliverable from a cold run (green)

Full verbatim per-fixture log: `reports/sprint-50/fixture-eval.md` (raw stdout
under `reports/sprint-50/raw-logs/`). For each of the three guided-sim fixtures
(anemone, agio, defunds): the run authored an `AssessmentInputs` `--input`,
produced a non-generic finding title + a resilience-boundary recommendation
(knob-phrasing grep `Keep |keeping parameters|tune the campaign` → 0 over every
generated `brief.html` *and* `assessment.md`), emitted a five-section
`brief.html` + 1-page `brief.pdf`, and kept the three execution-honesty gates
green (positive_control / lifecycle_executed / determinism).

The default (no `--input`) guided-sim recommendation, verbatim (Agio):

> `lender_bad_debt` held while `collateral_price_drop_bps` stayed at or below
> 3000 and began to fire beyond that bound. This bounds the protocol's observed
> resilience to `collateral_price_drop_bps` under the tested configuration: a
> safe region observed at or under the 5% failure-rate threshold within the
> declared, fixed-seed swept region — an observed boundary, not a parameter to
> set.

`brief.html` byte-stable across re-runs (×3 anemone, ×2 agio/defunds):

```text
0ed07f31158a880439c40fb6ff349619ce4b48f5acce76a239ce92e243ea70e5  anemone brief.html
ed15d450a568be423ead6eaaa72d1261a03512639eb6cfbe65c3711ee95bfb77  agio brief.html
f5ad71a4a8c973c3f55d747d335a7932af4bf78458b400c8d18f1335d61012ca  defunds brief.html
```

All three case-study briefs were regenerated from `assess --brief` and
installed into `case-studies/{anemone,agio/program,defunds}/.riptide/`
(replacing the hand-made Agio `brief.html`); the three Sprint 48 surface pins
reproduced byte-identical during the eval (`c69d4027…`/`de748996…`/`cb9bc99c…`).
Case studies live outside the repo; nothing case-study-side is committed.

## Scoped regression diff (no unintended engine/fixture changes)

This sprint's commits (base = `main` @ `cafb409` v0.11.0):

```sh
$ git diff --name-only main..HEAD -- fixtures engine riptide-sim riptide-sim-macros programs
```

```text
(empty)
```

The full branch diff touches only `cli/src/assess/narrative.ts`,
`cli/src/assess/render-brief.ts` (new), `cli/src/commands/assess.ts`,
`cli/test/assess-{fixture,brief.test,narrative-guided-sim.test}.ts`,
`skills/riptide-assess/SKILL.md`, `.gitignore`, and `reports/sprint-50/`.

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

## Flagship assess pins (identical — the adapter gate held)

Regenerated end-to-end with the canonical out path the pin was taken from (the
assessment embeds the campaign root label, so byte-identity requires
`tmp/flagship-run`), against the rebuilt CLI at the final tree:

```sh
$ node cli/dist/src/index.js campaign run fixtures/campaigns/lending/whale-shock-cartography/campaign.toml --out tmp/flagship-run
$ node cli/dist/src/index.js assess tmp/flagship-run/campaign_40a5f239691a --out /tmp/riptide-t05-lending-pin-WJrnX5
$ sha256sum /tmp/riptide-t05-lending-pin-WJrnX5/assessment.md /tmp/riptide-t05-lending-pin-WJrnX5/assessment.json
```

```text
aa9ab5894ceb9454695004a8d4b537bf506f72fd60ce7bac82ff0465d4107d21  /tmp/riptide-t05-lending-pin-WJrnX5/assessment.md
2de4739b505241dd9e73e715a661bf13a55a68e4e302045be8e882c5a6a29f9e  /tmp/riptide-t05-lending-pin-WJrnX5/assessment.json
```

Byte-identical to the authoritative pins (`aa9ab589…` / `2de4739b…`); campaign
digest `40a5f239691a…` unchanged. The real-campaign branch of the narrative is
untouched by construction (every Sprint 50 string change branches on
`campaign.adapter === GUIDED_SIM_ADAPTER`); the in-suite flagship byte-pin
tests are green in both suite runs below.

## CLI suite (twice, at the final tree)

Full verbatim stdout/stderr committed at
`reports/sprint-50/npm-test-2026-06-12-run1.log` and
`reports/sprint-50/npm-test-2026-06-12-run2.log`. Both runs executed after the
last code commit (`6ccb8b8`), so the logs attest the exact tree being closed.

```sh
$ npm --prefix cli test   # run 1
```

```text
ℹ tests 764
ℹ suites 0
ℹ pass 759
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
```

```sh
$ npm --prefix cli test   # run 2
```

```text
ℹ tests 764
ℹ suites 0
ℹ pass 759
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
```

The 5 skips are pre-existing (unchanged since Sprint 49); the suite grew from
747 to 764 tests this sprint (narrative reframe + brief renderer + eval-driven
regressions).

## Commits (logical chunks)

On `feat/sprint-50-self-serve-deliverable` off `main` @ `cafb409` (v0.11.0):

- `c57e560` — Reframe guided-sim narrative as an observed resilience boundary
- `47bdba7` — Add riptide assess --brief: a one-page executive brief from the model
- `d61738a` — Make the skill author the assessment-input layer and deliver the brief
- `6ccb8b8` — Fix brief honesty + one-page fit defects the cold-read gate caught
- (this artifact + the eval log + suite logs + `.gitignore` `tmp/` entry land in
  the close-record commit that follows)

## Process gates

No push (branch is local; `main` == public `origin/main` @ `cafb409`), no
publish (`docker push` / `gh release create` / `npm publish` / `cargo publish`
unused), no `--amend`, no `git add -A`, no engine/surface hash retune. Vocab
grep over the sprint's code/skill surfaces clean (no sprint/phase/task-ID
labels added; two pre-existing labels on `main` in `cli/test/assess-fixture.ts`
comments are noted as follow-up debt, not introduced here).
