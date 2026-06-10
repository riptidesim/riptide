# Guided-sim fixture eval — 2026-06-10

Acceptance check: the assessment skill's classify→playbook→author→gates path,
run end-to-end against the three ground-truth fixtures
(`~/Work/riptide/case-studies/{anemone,agio,defunds}`), must re-derive each
fixture's known verdict with the execution-honesty gates green.

- CLI: 0.9.1, built from `feat/guided-sim-cartography-bridge` (post
  gates/helpers), `cd cli && npm run build`.
- Procedure + expected answers: `.specs/features/sprint-48-trustworthy-skill/eval.md`.
- Fixture-side authoring done by following the skill: `[sim.positive_control]`
  + `[sim.lifecycle]` declared in each fixture's `Riptide.toml`; Agio's
  `flows.rs` rewired onto `riptide_sim::oracle::PythPriceUpdate` /
  `crash_in_place` (replacing hand-rolled 134-byte construction) and
  `riptide_sim::dispatch::ThirdPartyDispatch` (replacing the hand-rolled
  lender-acts-on-borrower's-loan account set).
- `riptide-sim` manifest parser extended to accept the two honesty blocks
  (`deny_unknown_fields` previously rejected them); `cargo test -p riptide-sim`
  green: `48 passed; 0 failed` (lib) + `3 passed` (oracle SDK proof).

## Verdict summary

| Fixture | Expected | Result | Gates | Surface vs committed pin |
| --- | --- | --- | --- | --- |
| anemone | LP-outflow onset at stated line, solvency held | ✅ `lp_outflow_material` 0% at 0–200, 100% at 300/400/490 (12/24); no solvency fire | ✅✅✅ | byte-identical `c69d4027…` |
| agio | lender bad-debt onset ~33% crash (4000 bps coordinate) | ✅ `lender_bad_debt` 0% at 0–3000, 100% at 4000/5000/6000 (12/28) | ✅✅✅ | byte-identical `de748996…` |
| defunds | dilution HELD across 0–50% markdown | ✅ 0 fires, flat 0% surface, `dilution_loss`/`early_overpayment` = 0.0 at every coordinate | ✅✅✅ | byte-identical `cb9bc99c…` |

The byte-identical surfaces double as (a) determinism evidence across the
re-derivation and (b) proof the Agio helper rewire is behavior-preserving
(same labels — `create_lend_offer` 28, `accept_lend_offer` 28,
`liquidate_loan` 20 — and the same fires at the same coordinates as the
retained flagship run).

Committed Agio/Anemone flagship assessments carry a *declared* `ready_to_send`
(via `assessment-input.json`); the eval asserts the *derived* surface finding.
Defunds derives `ready_to_send` directly.

## Verbatim logs

### anemone

```
$ riptide sim run .riptide/sim --flows 20 --out .riptide/sim/artifacts/eval-sweep
  [24 iterations: rate_shock_bps {0,100,200,300,400,490} × 4 seeds]

$ riptide sim surface .riptide/sim/artifacts/eval-sweep --sim .riptide/sim --out .riptide/eval-assess
riptide sim surface: wrote cartography artifacts to /home/ailton/Work/riptide/case-studies/anemone/.riptide/eval-assess
  campaign-summary.json (id guided-sim-59b0a9875a186dff)
  risk-surface.json
  retention-manifest.json
  execution-honesty gates: pass
    ✓ positive_control: positive control rate_shock_bps=0 passed across 4 iteration(s).
    ✓ lifecycle_executed: all 5 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 c69d402734a32b82…).
  next: riptide assess .riptide/eval-assess

$ riptide assess .riptide/eval-assess
Assessment generated: rate_shock_bps sweep

Result
  Verdict: needs_campaign_tuning (derived)
  Runs: 24/24 completed, 12 invariant-failed (50%)
  Risk surface: 6/6 cells populated, worst cell 100%, most sensitive `rate_shock_bps`
  Safe region: bounded region at or under 5%
  Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism

Hashes
  Assessment digest: 1fde434727cf60c204d9ece914da8bac1e08c549dd2489ae82ae491759ea51ea
  Campaign digest: 59b0a9875a186dff34b7e75a7d5524b5a5b02ebfeab2eea959bf902b7d68f361
  risk-surface.json sha256: c69d402734a32b82672f476b7bca033207ed4e8668ec6884a2a89596c7e26f1b

$ sha256sum .riptide/risk-surface.json .riptide/eval-assess/risk-surface.json
c69d402734a32b82672f476b7bca033207ed4e8668ec6884a2a89596c7e26f1b  .riptide/risk-surface.json
c69d402734a32b82672f476b7bca033207ed4e8668ec6884a2a89596c7e26f1b  .riptide/eval-assess/risk-surface.json
```

Invariant fires by coordinate (from `eval-sweep/guided-sim-run.json`):
`lp_outflow_material` ×4 at each of 300 / 400 / 490; nothing at 0–200; the
solvency bound never fired anywhere — the finding is LP P&L, not insolvency.

### agio

```
$ riptide sim run .riptide/sim --flows 12 --out .riptide/sim/artifacts/eval-sweep
  [28 iterations: collateral_price_drop_bps {0,1000,…,6000} × 4 seeds]

$ riptide sim surface .riptide/sim/artifacts/eval-sweep --sim .riptide/sim --out .riptide/eval-assess
riptide sim surface: wrote cartography artifacts to /home/ailton/Work/riptide/case-studies/agio/program/.riptide/eval-assess
  campaign-summary.json (id guided-sim-e9b6b620cc6fd896)
  risk-surface.json
  retention-manifest.json
  execution-honesty gates: pass
    ✓ positive_control: positive control collateral_price_drop_bps=0 passed across 4 iteration(s).
    ✓ lifecycle_executed: all 3 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 de748996f19bb373…).
  next: riptide assess .riptide/eval-assess

$ riptide assess .riptide/eval-assess
Assessment generated: collateral_price_drop_bps sweep

Result
  Verdict: needs_campaign_tuning (derived)
  Runs: 28/28 completed, 12 invariant-failed (42.8571%)
  Risk surface: 7/7 cells populated, worst cell 100%, most sensitive `collateral_price_drop_bps`
  Safe region: bounded region at or under 5%
  Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism

Hashes
  Assessment digest: 373e969d895dca50155200be92ab036f7ead87a92e761dcaa11f2cdaad8f0501
  Campaign digest: e9b6b620cc6fd89696689574827a14397a486cc689996042b16c4896dfd28e73
  risk-surface.json sha256: de748996f19bb373ef7afb03152cac0880456b37dd40f59d964271e6a5eec8fa

$ sha256sum .riptide/risk-surface.json .riptide/eval-assess/risk-surface.json
de748996f19bb373ef7afb03152cac0880456b37dd40f59d964271e6a5eec8fa  risk-surface.json
de748996f19bb373ef7afb03152cac0880456b37dd40f59d964271e6a5eec8fa  eval-assess/risk-surface.json
```

Invariant fires by coordinate: `lender_bad_debt` ×4 at each of 4000 / 5000 /
6000; nothing at 0–3000. `liquidate_loan` executed 20× (eligible from the 2000
coordinate; the lender stays whole until collateral value crosses below debt at
~33%). Run-parity vs the retained flagship sweep: identical labels and fires.

### defunds

```
$ riptide sim run .riptide/sim --flows 12 --out .riptide/sim/artifacts/eval-sweep
  [28 iterations: nav_markdown_bps {0,500,1000,…,5000} × 4 seeds]

$ riptide sim surface .riptide/sim/artifacts/eval-sweep --sim .riptide/sim --out .riptide/eval-assess
riptide sim surface: wrote cartography artifacts to /home/ailton/Work/riptide/case-studies/defunds/.riptide/eval-assess
  campaign-summary.json (id guided-sim-ef1c9a79e2556af9)
  risk-surface.json
  retention-manifest.json
  execution-honesty gates: pass
    ✓ positive_control: positive control nav_markdown_bps=0 passed across 4 iteration(s).
    ✓ lifecycle_executed: all 9 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 cb9bc99c579fd454…).
  next: riptide assess .riptide/eval-assess

$ riptide assess .riptide/eval-assess
Assessment generated: nav_markdown_bps sweep

Result
  Verdict: ready_to_send (derived)
  Runs: 28/28 completed, 0 invariant-failed (0%)
  Risk surface: 7/7 cells populated, worst cell 0%, most sensitive `nav_markdown_bps`
  Safe region: entire declared region at or under 5%
  Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism

Hashes
  Assessment digest: 6f2a40d040de1c69b2ffd0ecfe7255a1c1fdc0d7325c71386c2a147ca8e9857b
  Campaign digest: ef1c9a79e2556af9539d02ddf22ba2da8a6a99f76eff2fed6c77f8fdf11d295e
  risk-surface.json sha256: cb9bc99c579fd454bc7097a3b4f4e172b373351fb25286229cd64fc79161f629

$ sha256sum .riptide/risk-surface.json .riptide/eval-assess/risk-surface.json
cb9bc99c579fd454bc7097a3b4f4e172b373351fb25286229cd64fc79161f629  .riptide/risk-surface.json
cb9bc99c579fd454bc7097a3b4f4e172b373351fb25286229cd64fc79161f629  .riptide/eval-assess/risk-surface.json
```

Metrics by coordinate (every coordinate, all seeds): `dilution_loss = 0.0`,
`early_overpayment = 0.0` — the flat surface is robustness, not a no-op: the
9-flow withdrawal-run lifecycle executed and the markdown-0 positive control
paid exact pro-rata.
