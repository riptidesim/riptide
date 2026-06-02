# Sprint 45 close gates - 2026-06-02

Internal close artifact. The user-facing surfaces changed in this sprint are
`skills/riptide-assess/SKILL.md`, `README.md`, and root help; this file is only
the regression/proof capture.

## Hash gates

### whale-shock-grid

```sh
$ sha256sum fixtures/scenarios/lending/whale-shock-grid/simulation-result.json
```

```text
60f72adee15451af60f559cdfb9609813b54c34565f7c76fe7e5cf8495a42470  fixtures/scenarios/lending/whale-shock-grid/simulation-result.json
```

### Sprint 39 surface

```sh
$ sha256sum fixtures/campaigns/lending/whale-shock-cartography/expected-risk-surface.json
```

```text
11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f  fixtures/campaigns/lending/whale-shock-cartography/expected-risk-surface.json
```

### perps scratch

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

### amm scratch

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

### lending replay

```sh
$ bash fixtures/replays/lending-whale-bad-debt/rerun.sh
```

```text
riptide replay: adapter=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/adapter.toml trajectory=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt
riptide-engine replay: adapter=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/adapter.toml trajectory=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt actors=10 ticks=4
wrote /tmp/riptide-replay-6rt7rb/simulation-result.json
riptide-engine: 1 invariant violation(s) recorded; --allow-invariant-violations restores exit 0
Riptide Simulation Summary
Scenario: replay:lending-whale-bad-debt
Agents: 10 | Ticks: 4 | Seed: 0
Final TVL: 500.00
Final Utilization: 0.00
Bad Debt: 3600.00
Largest Drawdown: 0.1667
Agent Status Counts: active=10, liquidated=0, depleted=0
Invariants:
  - no_bad_debt: bad_debt == 0 (1×)
Simulation Boundaries:
- Replay mode bypasses persona compilation and dispatches a declared instruction trajectory directly.
- Trajectory args are supplied inline per event; generic adapters may still fall back to adapter literals for unmapped constants.
- initial-state.json, when present, is applied as a pre-tick bootstrap instruction list before tick 0 is recorded.
- Agent balance/PnL fields are bookkeeping-only in replay mode; authoritative outputs are primitive snapshots, events, and invariant rollups.

T4 otc-liquidator-0 (otc-liquidator-0) liquidate success
T4 otc-liquidator-1 (otc-liquidator-1) liquidate success
T4 otc-liquidator-2 (otc-liquidator-2) liquidate success
T4 otc-liquidator-3 (otc-liquidator-3) liquidate success
T4 otc-liquidator-4 (otc-liquidator-4) liquidate success
T4 invariant (__engine__) invariant_violation:no_bad_debt failed
Wrote artifact: /home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/riptide-output/replays/lending-whale-bad-debt/simulation-result.json
Wrote report:   /home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/riptide-output/replays/lending-whale-bad-debt/report.md
wrote pack: /home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/.riptide/pack/replay-lending-whale-bad-debt (run-id=replay-lending-whale-bad-debt, canonical-hash=6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1)
Wrote pack:     /home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/.riptide/pack/replay-lending-whale-bad-debt
```

## Assessment pins

### Lending cartography

The first probe used an absolute `/tmp/...` campaign root and moved the model
digest because the assessment intentionally records the reviewer-facing campaign
root label. That was discarded. The canonical active gate is the Sprint 42/44
relative root shape below.

```sh
$ node cli/dist/src/index.js campaign run fixtures/campaigns/lending/whale-shock-cartography/campaign.toml --out tmp/flagship-run
```

```text
Campaign finished: whale-shock-cartography

Result
  Outcome: 33 invariant failures observed, no setup errors
  Runs: 80/80 completed, 0 setup errors, 0 skipped runs
  Risk signals: bad debt max=4320, liquidations max=6, max utilization=19.2
  Coverage: 80 partial; confidence 47 low, 33 medium

Workload
  Size: 80x whale_shock_grid (20 agents x 20 ticks)
  Simulation time: 4.78s
  Configs: 80 created, 0 reused

Next
  riptide review tmp/flagship-run/campaign_40a5f239691a

Evidence
  Summary: tmp/flagship-run/campaign_40a5f239691a/campaign-summary.md
  Artifacts: tmp/flagship-run/campaign_40a5f239691a
  Retained cases: first_failure -> run_000000_a5b7ddc3218a, worst_bad_debt -> run_000011_897ec92f85ca, worst_liquidity -> run_000033_2f8cdcc55c8b, median -> run_000075_25d931d7c54f, surprising_outlier -> run_000033_2f8cdcc55c8b

Details
  Objective: liquidation-safety (lending.v1)
  Campaign ID: campaign_40a5f239691a
  Digest: 40a5f239691a...4277f2

Boundary
  No invariant violation observed means none was observed in this campaign, not proof of complete safety.
```

```sh
$ node cli/dist/src/index.js assess tmp/flagship-run/campaign_40a5f239691a --out /tmp/riptide-s45-close-lending-pin-assess-current
```

```text
Assessment generated: whale-shock-cartography

Result
  Verdict: needs_campaign_tuning (derived)
  Runs: 80/80 completed, 33 invariant-failed (41.25%)
  Risk surface: 8/8 cells populated, worst cell 100%, most sensitive `whale_share_bps`
  Safe region: bounded region at or under 5%

Artifacts
  Assessment: /tmp/riptide-s45-close-lending-pin-assess-current/assessment.json
  Report: /tmp/riptide-s45-close-lending-pin-assess-current/assessment.md

Hashes
  Assessment digest: 671e398508b4287451416be644c9398c693dd38caea83f9e188b1d3ce6cf9fd4
  Campaign digest: 40a5f239691a64309db2bc9a49ae14127f2c25a75260c802149f3f0a2c4277f2
  risk-surface.json sha256: 11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f

Next
  riptide review tmp/flagship-run/campaign_40a5f239691a

Boundary
  Simulation evidence over the campaign's declared, fixed-seed region — not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.
```

```sh
$ sha256sum /tmp/riptide-s45-close-lending-pin-assess-current/assessment.md /tmp/riptide-s45-close-lending-pin-assess-current/assessment.json
```

```text
11ac2ff70a156bbb7aff10ae67f4e2e819b3862f531edb64eb5cfc5a1f1bf04c  /tmp/riptide-s45-close-lending-pin-assess-current/assessment.md
f3eb17387f2cd3aa9c152ff8ede70a88e208b935ff90df5a434f7f89949f1eee  /tmp/riptide-s45-close-lending-pin-assess-current/assessment.json
```

### Defunds correctness

The local `case-studies/defundspg` working tree already had dirty
`.riptide/assess-inputs.json` and regenerated assessment files before this close.
Running that dirty input produced new noncanonical hashes. The active Sprint
42/44 Defunds pin is reproduced by using the committed Sprint 42 input JSON
against the real workspace evidence, writing only to `/tmp`.

```sh
$ git show HEAD:.riptide/assess-inputs.json > /tmp/riptide-s45-defunds-head-assess-inputs.json
```

```text
```

```sh
$ node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js assess .riptide --input /tmp/riptide-s45-defunds-head-assess-inputs.json --html --out /tmp/riptide-s45-defunds-head-input-real-evidence
```

```text
Assessment generated: Defunds managed_funds (correctness shape)

Result
  Verdict: ready_to_send (derived)
  Guided sim: 4000 flow(s), 25334 tx success, 11650 expected rejection(s), 0 unexpected, 0 panic(s) (status passed)
  Coverage: 6 flow(s) covered by guided sim
  Risk surface: none — correctness-dominated (no parameter-failure gradient)

Artifacts
  Assessment: /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.json
  Report: /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.md
  HTML: /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.html

Hashes
  Assessment digest: 2e1fc8d123d387374f09ccacf68d60017b4fd7a8666ea16b30b4444203a29103
  guided-sim-run.json sha256: 1b4437547253018cc0ebaa16bb806606c5b1496786f9257fdaf67e0bab018399

Next
  riptide assess .riptide

Boundary
  Simulation evidence bounded to the assessed guided-sim flows under a fixed seed — not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.
```

```sh
$ sha256sum /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.md /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.json
```

```text
e6f1750306afa87df87921c8ab1f2dd903d28aa4eb7b8290035ee461cdcf04f2  /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.md
dd7104d514d8c3f7f203f51e0ebbedfad653935c02a3f1d7286198a4b8ad9b8c  /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.json
```

## Copy gates

### no absolute path grep

```sh
$ grep -rn "/home/" README.md skills/riptide-assess/
```

```text
```

```sh
$ node cli/dist/src/index.js --help | grep -n "/home/"
```

```text
```

### overclaim grep

```sh
$ grep -nE "guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety" README.md
```

```text
31:> Riptide produces simulation evidence, not audit signoff. A failing cell is a
60:signoff or complete protocol safety.
```

```sh
$ grep -rnE "guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety" skills/riptide-assess/
```

```text
skills/riptide-assess/SKILL.md:42:  inputs, not audit signoff or complete protocol safety.
```

```sh
$ node cli/dist/src/index.js --help | grep -nE "guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety"
```

```text
4:  Reports are simulation evidence over declared inputs, not audit signoff.
```

## Full CLI suite

Full raw stdout is captured verbatim in
`reports/sprint-45/npm-test-2026-06-02.log` (1088 lines). The block below is
the command head and final tail copied from that raw log.

```sh
$ npm --prefix cli test
```

```text
> @riptide/cli@0.9.1 test
> npm run build && node ./scripts/run-tests.mjs

> @riptide/cli@0.9.1 build
> node ./scripts/clean-dist.mjs && tsc -p tsconfig.json && node ./scripts/build-studio-app.mjs && node ./scripts/copy-personas.mjs

> @riptide/studio-app@0.9.1 build
> tsc -p tsconfig.json && vite build

vite v5.4.21 building for production...
transforming...
✓ 65 modules transformed.
rendering chunks...
computing gzip size...
../assets/studio/index.html                   0.62 kB │ gzip:   0.34 kB
../assets/studio/assets/style-BUM64RWh.css   45.51 kB │ gzip:   8.54 kB
../assets/studio/assets/index-9Ns7OVCH.js   385.67 kB │ gzip: 112.81 kB
✓ built in 1.30s
...
✔ studio loads case-study workspaces from --case-studies-root (1683.894408ms)
✔ surface-narrative: renders a 2D heatmap over the two most-sensitive axes with shading glyphs (26.101557ms)
✔ surface-narrative: byte-deterministic across two renders of a fixed surface (1.422771ms)
✔ surface-narrative: 1D surface renders a per-bin column, no 2D grid (1.422704ms)
✔ surface-narrative: no-safe-region surface states it explicitly, never a blank section (0.954992ms)
✔ runSweep derives deterministic seeds and respects the parallelism cap (173.339444ms)
✔ runSweep fail-fast cancels in-flight cells and stops scheduling new seeds (22.608211ms)
✔ runSweep --full runs every cell and records fire frequency (21.272842ms)
✔ runSweep records engine_error summaries even when no cell produced a result (20.3884ms)
ℹ tests 721
ℹ suites 0
ℹ pass 716
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 63243.891775
```
