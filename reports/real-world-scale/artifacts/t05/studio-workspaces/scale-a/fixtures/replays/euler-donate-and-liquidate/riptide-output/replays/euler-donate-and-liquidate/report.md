# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/replays/euler-donate-and-liquidate/adapter.toml`
- **Seed**: 0
- **Ticks**: 2
- **Agents**: 2 (1× attacker-donor, 1× attacker-liquidator)
- **Scenario**: replay:euler-donate-and-liquidate
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/replays/euler-donate-and-liquidate/riptide-output/replays/euler-donate-and-liquidate`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 20 |
| final_utilization | 0 |
| largest_single_tick_drawdown | 0 |
| total_bad_debt | 4720 |

**Agent lifecycle**: 2 active, 0 liquidated, 0 depleted

## Invariants

| Invariant | Firings | First tick |
|-----------|---------|------------|
| no_bad_debt | 1 | T2 |

## Notable events

- T2: attacker-liquidator (attacker-liquidator) — liquidate → success
- T2: Engine — invariant_violation:no_bad_debt → failed

## Simulation boundaries

- Replay mode bypasses persona compilation and dispatches a declared instruction trajectory directly.
- Trajectory args are supplied inline per event; generic adapters may still fall back to adapter literals for unmapped constants.
- initial-state.json, when present, is applied as a pre-tick bootstrap instruction list before tick 0 is recorded.
- Agent balance/PnL fields are bookkeeping-only in replay mode; authoritative outputs are primitive snapshots, events, and invariant rollups.

## How to reproduce

```sh
riptide replay fixtures/replays/euler-donate-and-liquidate/config.json
```
