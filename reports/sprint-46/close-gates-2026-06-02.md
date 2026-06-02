# Sprint 46 close gates - 2026-06-02

Internal close artifact for the coverage and honesty statement re-pin. The
assessment markdown/json movement below is intentional and additive only:
`Coverage & Limits` in markdown plus `coverage_statement` in JSON. Engine hashes
and the Sprint 39 surface remain frozen.

## Additive-only investigation

The first regenerated markdown diff removed the existing executive-summary
`Main limit` line. That failed the additive-only gate. The renderer was corrected
to preserve that existing line and the reports were regenerated before re-pinning.

## Assessment re-pin hashes

```sh
$ sha256sum /tmp/riptide-s45-close-lending-pin-assess-current/assessment.md /tmp/riptide-s45-close-lending-pin-assess-current/assessment.json /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.md /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.json
```

```text
11ac2ff70a156bbb7aff10ae67f4e2e819b3862f531edb64eb5cfc5a1f1bf04c  /tmp/riptide-s45-close-lending-pin-assess-current/assessment.md
f3eb17387f2cd3aa9c152ff8ede70a88e208b935ff90df5a434f7f89949f1eee  /tmp/riptide-s45-close-lending-pin-assess-current/assessment.json
e6f1750306afa87df87921c8ab1f2dd903d28aa4eb7b8290035ee461cdcf04f2  /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.md
dd7104d514d8c3f7f203f51e0ebbedfad653935c02a3f1d7286198a4b8ad9b8c  /tmp/riptide-s45-defunds-head-input-real-evidence/assessment.json
```

```sh
$ sha256sum /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.json /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.json
```

```text
aa9ab5894ceb9454695004a8d4b537bf506f72fd60ce7bac82ff0465d4107d21  /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md
2de4739b505241dd9e73e715a661bf13a55a68e4e302045be8e882c5a6a29f9e  /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.json
ddb3ed72b0442a2f6f5bcf6b7f0e32f600c7786068c5b1ca6cf2edee32d5684c  /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md
780794193b4b9f9ee1a5e8cd8a3babc19e8a1fdfa94dbcd6b98a7caacd51bf6a  /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.json
```

Old -> new:

- lending `assessment.md`: `11ac2ff70a156bbb7aff10ae67f4e2e819b3862f531edb64eb5cfc5a1f1bf04c` -> `aa9ab5894ceb9454695004a8d4b537bf506f72fd60ce7bac82ff0465d4107d21`
- lending `assessment.json`: `f3eb17387f2cd3aa9c152ff8ede70a88e208b935ff90df5a434f7f89949f1eee` -> `2de4739b505241dd9e73e715a661bf13a55a68e4e302045be8e882c5a6a29f9e`
- Defunds `assessment.md`: `e6f1750306afa87df87921c8ab1f2dd903d28aa4eb7b8290035ee461cdcf04f2` -> `ddb3ed72b0442a2f6f5bcf6b7f0e32f600c7786068c5b1ca6cf2edee32d5684c`
- Defunds `assessment.json`: `dd7104d514d8c3f7f203f51e0ebbedfad653935c02a3f1d7286198a4b8ad9b8c` -> `780794193b4b9f9ee1a5e8cd8a3babc19e8a1fdfa94dbcd6b98a7caacd51bf6a`

## Lending regeneration

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
  Simulation time: 15s
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
$ node cli/dist/src/index.js assess tmp/flagship-run/campaign_40a5f239691a --out /tmp/riptide-s46-lending-assess-tJPZ2D
```

```text
Assessment generated: whale-shock-cartography

Result
  Verdict: needs_campaign_tuning (derived)
  Runs: 80/80 completed, 33 invariant-failed (41.25%)
  Risk surface: 8/8 cells populated, worst cell 100%, most sensitive `whale_share_bps`
  Safe region: bounded region at or under 5%

Artifacts
  Assessment: /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.json
  Report: /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md

Hashes
  Assessment digest: 6a7d504e0c825d12a2408ea039ce0cb69cdf10c6bca3e9116ebd253214a770c2
  Campaign digest: 40a5f239691a64309db2bc9a49ae14127f2c25a75260c802149f3f0a2c4277f2
  risk-surface.json sha256: 11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f

Next
  riptide review tmp/flagship-run/campaign_40a5f239691a

Boundary
  Simulation evidence over the campaign's declared, fixed-seed region — not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.
```

## Defunds regeneration

```sh
$ git show HEAD:.riptide/assess-inputs.json > /tmp/riptide-s46-defunds-head-assess-inputs.json
```

```text
```

```sh
$ node /home/ailton/Work/riptide/riptide/cli/dist/src/index.js assess .riptide --input /tmp/riptide-s46-defunds-head-assess-inputs.json --html --out /tmp/riptide-s46-defunds-assess-W0ESaY
```

```text
Assessment generated: Defunds managed_funds (correctness shape)

Result
  Verdict: ready_to_send (derived)
  Guided sim: 4000 flow(s), 25334 tx success, 11650 expected rejection(s), 0 unexpected, 0 panic(s) (status passed)
  Coverage: 6 flow(s) covered by guided sim
  Risk surface: none — correctness-dominated (no parameter-failure gradient)

Artifacts
  Assessment: /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.json
  Report: /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md
  HTML: /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.html

Hashes
  Assessment digest: 1a74e651735295b4fd8db5e4506f3441e1c094436e05b789050102ab4a6208ef
  guided-sim-run.json sha256: 1b4437547253018cc0ebaa16bb806606c5b1496786f9257fdaf67e0bab018399

Next
  riptide assess .riptide

Boundary
  Simulation evidence bounded to the assessed guided-sim flows under a fixed seed — not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.
```

## Additive-only proof

```sh
$ node -e "const fs=require('fs'); const pairs=[['lending','/tmp/riptide-s45-close-lending-pin-assess-current','/tmp/riptide-s46-lending-assess-tJPZ2D'],['defunds','/tmp/riptide-s45-defunds-head-input-real-evidence','/tmp/riptide-s46-defunds-assess-W0ESaY']]; function stripCoverage(md){const start=md.indexOf('## Coverage & Limits\n'); if(start<0) throw new Error('missing Coverage & Limits'); const next=md.indexOf('\n## Coverage Matrix\n', start); if(next<0) throw new Error('missing following Coverage Matrix'); return md.slice(0,start)+md.slice(next+1); } for(const [name,oldDir,newDir] of pairs){ const oldMd=fs.readFileSync(oldDir+'/assessment.md','utf8'); const newMd=fs.readFileSync(newDir+'/assessment.md','utf8'); if(stripCoverage(newMd)!==oldMd){ throw new Error(name+' markdown is not additive-only'); } const oldJson=JSON.parse(fs.readFileSync(oldDir+'/assessment.json','utf8')); const newJson=JSON.parse(fs.readFileSync(newDir+'/assessment.json','utf8')); if(!newJson.coverage_statement) throw new Error(name+' missing coverage_statement'); const oldDigest=oldJson.assessment_digest; const newDigest=newJson.assessment_digest; delete oldJson.assessment_digest; delete newJson.assessment_digest; delete newJson.coverage_statement; const oldRest=JSON.stringify(oldJson); const newRest=JSON.stringify(newJson); if(oldRest!==newRest){ throw new Error(name+' json changed outside coverage_statement/assessment_digest'); } console.log(name+': ADDITIVE ONLY - markdown restores byte-identical after removing Coverage & Limits; JSON existing fields byte-identical after removing coverage_statement; assessment_digest '+oldDigest+' -> '+newDigest); }"
```

```text
lending: ADDITIVE ONLY - markdown restores byte-identical after removing Coverage & Limits; JSON existing fields byte-identical after removing coverage_statement; assessment_digest 671e398508b4287451416be644c9398c693dd38caea83f9e188b1d3ce6cf9fd4 -> 6a7d504e0c825d12a2408ea039ce0cb69cdf10c6bca3e9116ebd253214a770c2
defunds: ADDITIVE ONLY - markdown restores byte-identical after removing Coverage & Limits; JSON existing fields byte-identical after removing coverage_statement; assessment_digest 2e1fc8d123d387374f09ccacf68d60017b4fd7a8666ea16b30b4444203a29103 -> 1a74e651735295b4fd8db5e4506f3441e1c094436e05b789050102ab4a6208ef
```

## Frozen hash gates

```sh
$ sha256sum fixtures/scenarios/lending/whale-shock-grid/simulation-result.json
```

```text
60f72adee15451af60f559cdfb9609813b54c34565f7c76fe7e5cf8495a42470  fixtures/scenarios/lending/whale-shock-grid/simulation-result.json
```

```sh
$ sha256sum fixtures/campaigns/lending/whale-shock-cartography/expected-risk-surface.json
```

```text
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
riptide replay: adapter=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/adapter.toml trajectory=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt
riptide-engine replay: adapter=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/adapter.toml trajectory=/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt actors=10 ticks=4
wrote /tmp/riptide-replay-ITSwR5/simulation-result.json
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

## Copy gates

```sh
$ grep -rn "/home/" /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.json /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.json /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.html
```

```text
```

```sh
$ grep -rnE "guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety" /tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md
```

```text
/tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md:3:This report records simulation evidence. It is not audit signoff, complete protocol safety, formal verification, mainnet monitoring, or certification.
/tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md:22:This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.
/tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md:36:- Audit signoff, formal verification, and complete protocol safety.
/tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md:41:This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.
/tmp/riptide-s46-lending-assess-tJPZ2D/assessment.md:227:- [ ] The report says this is simulation evidence, not audit signoff or complete protocol safety.
/tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md:3:This report records simulation evidence. It is not audit signoff, complete protocol safety, formal verification, mainnet monitoring, or certification.
/tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md:25:This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.
/tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md:42:- Audit signoff, formal verification, and complete protocol safety.
/tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md:50:This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.
/tmp/riptide-s46-defunds-assess-W0ESaY/assessment.md:216:- [ ] The report says this is simulation evidence, not audit signoff or complete protocol safety.
```

```sh
$ grep -rnE "guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety" /tmp/riptide-s46-defunds-assess-W0ESaY/assessment.html
```

```text
198:<p class="rt-cover-boundary">Simulation evidence over a declared, fixed-seed region — not audit signoff, formal verification, complete protocol safety, or a mainnet prediction.</p>
205:<p class="rt-body">This report records simulation evidence. It is not audit signoff, complete protocol safety, formal verification, mainnet monitoring, or certification.</p>
222:<p class="rt-body">This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.</p>
237:<li>Audit signoff, formal verification, and complete protocol safety.</li>
244:<p class="rt-body">This assessment records simulation evidence observed within the campaign's declared, fixed-seed parameter region and run budget. It is evidence over that region only — not audit signoff, formal verification, complete protocol safety, or a prediction of mainnet behavior.</p>
400:<li class="rt-check"><span class="rt-box">☐</span> The report says this is simulation evidence, not audit signoff or complete protocol safety.</li>
```

## CLI suite

Full verbatim stdout/stderr is committed at
`reports/sprint-46/npm-test-2026-06-02.log` (1094 lines).

```sh
$ npm --prefix cli test > reports/sprint-46/npm-test-2026-06-02.log 2>&1
```

```text
✔ studio dashboard mount returns collection compatible with the existing dashboard (1383.908797ms)
✔ studio dashboard mount serves the dashboard.html shell (1311.638628ms)
✔ studio dashboard mount rejects sources that escape the workspace (1323.679493ms)
✔ studio server serves the React app from / (1361.132033ms)
✔ studio server rejects non-GET methods on read-only routes (1488.40852ms)
✔ studio server rejects non-loopback bind hosts (0.81379ms)
✔ studio server returns a 404 with route map for unknown paths (1422.466581ms)
✔ studio job queue maps each allowlisted kind to a deterministic argv (1.324933ms)
✔ studio job queue attaches campaign harness when available (1.142755ms)
✔ studio job queue rejects unknown kinds and missing required params (0.125829ms)
✔ studio job queue rejects publish/push/release tokens even via params (0.089051ms)
✔ studio job queue rejects shell metacharacters and absolute paths (0.263538ms)
✔ studio job queue persists job history under .riptide/studio/jobs/ (19.68253ms)
✔ studio jobs HTTP plan rejects publish-shaped commands and accepts run (1336.753832ms)
✔ studio jobs HTTP launch persists to disk and lists in /api/studio/jobs (1328.476934ms)
✔ studio jobs HTTP rejects non-allowlisted kinds and bad payloads (1351.938982ms)
✔ studio jobs hydration surfaces persisted jobs after restart (2777.86929ms)
✔ studio jobs hydration normalizes legacy current ids to the owning workspace (1324.183825ms)
✔ studio jobs HTTP list scopes rows to the selected workspace (2009.39444ms)
✔ studio configure preset is Risk Plan-first and preserves confirmation boundaries (0.929001ms)
✔ config intent generator returns prompt + proposed files for a complete payload (0.723647ms)
✔ config intent generator rejects missing fields and unknown protocol classes (0.151734ms)
✔ config intent HTTP endpoint returns the prompt and never claims it edited files (1816.792884ms)
✔ studio loads case-study workspaces from --case-studies-root (1651.448205ms)
✔ surface-narrative: renders a 2D heatmap over the two most-sensitive axes with shading glyphs (25.395598ms)
✔ surface-narrative: byte-deterministic across two renders of a fixed surface (1.223133ms)
✔ surface-narrative: 1D surface renders a per-bin column, no 2D grid (0.722125ms)
✔ surface-narrative: no-safe-region surface states it explicitly, never a blank section (1.171735ms)
✔ runSweep derives deterministic seeds and respects the parallelism cap (142.329636ms)
✔ runSweep fail-fast cancels in-flight cells and stops scheduling new seeds (19.197741ms)
✔ runSweep --full runs every cell and records fire frequency (14.149955ms)
✔ runSweep records engine_error summaries even when no cell produced a result (9.367768ms)
ℹ tests 727
ℹ suites 0
ℹ pass 722
ℹ fail 0
ℹ cancelled 0
ℹ skipped 5
ℹ todo 0
ℹ duration_ms 53508.404908
```
