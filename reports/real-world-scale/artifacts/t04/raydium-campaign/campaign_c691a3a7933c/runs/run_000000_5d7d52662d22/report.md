# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/case-studies/raydium-cp-swap/.riptide/adapters/raydium-cp-swap.toml`
- **Seed**: 1350
- **Ticks**: 100
- **Agents**: 40 (20× Arbitrage trader, 20× Flow trader)
- **Scenario**: baseline
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-campaign/campaign_c691a3a7933c/runs/run_000000_5d7d52662d22`

## Summary

| Metric | Value |
|--------|-------|
| input_vault.amount_avg | 1000003500000 |
| input_vault.amount_max | 1000007000000 |
| input_vault.amount_min | 1000000000000 |
| output_vault.amount_avg | 999996504000 |
| output_vault.amount_max | 1000000000000 |
| output_vault.amount_min | 999993008000 |

**Agent lifecycle**: 40 active, 0 liquidated, 0 depleted

## Invariants

No invariant violations detected in this run.

## Notable events

No notable events.

## Simulation boundaries

- In-process LiteSVM backend (no external validator).
- Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.
- Project Rust harness setup ran before tick 0; custom account bytes are developer-owned.
- Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.

## How to reproduce

```sh
exec riptide run /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-campaign/campaign_c691a3a7933c/runs/run_000000_5d7d52662d22/run-config.json --adapter .riptide/adapters/raydium-cp-swap.toml --harness .riptide/harness
```
