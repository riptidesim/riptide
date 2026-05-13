# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/case-studies/raydium-cp-swap/.riptide/adapters/raydium-cp-swap.toml`
- **Seed**: 1337
- **Ticks**: 100
- **Agents**: 40 (28× Flow trader, 12× Arbitrage trader)
- **Scenario**: baseline
- **Output**: `/home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-run/swap-pressure`

## Summary

| Metric | Value |
|--------|-------|
| input_vault.amount_avg | 1000002900000 |
| input_vault.amount_max | 1000005800000 |
| input_vault.amount_min | 1000000000000 |
| output_vault.amount_avg | 999997104000 |
| output_vault.amount_max | 1000000000000 |
| output_vault.amount_min | 999994208000 |

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
exec riptide run .riptide/scenarios/swap-pressure/run-config.json --adapter .riptide/adapters/raydium-cp-swap.toml --harness .riptide/harness
```
