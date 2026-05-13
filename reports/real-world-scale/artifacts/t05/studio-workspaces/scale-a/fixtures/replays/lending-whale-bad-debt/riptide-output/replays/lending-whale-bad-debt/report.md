# Riptide Simulation Report

## Run metadata

- **Adapter**: `/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/adapter.toml`
- **Seed**: 0
- **Ticks**: 4
- **Agents**: 10 (1× otc-liquidator-0, 1× otc-liquidator-1, 1× otc-liquidator-2, 1× otc-liquidator-3, 1× otc-liquidator-4, 1× whale-0, 1× whale-1, 1× whale-2, 1× whale-3, 1× whale-4)
- **Scenario**: replay:lending-whale-bad-debt
- **Output**: `/home/ailton/Work/riptide/riptide/fixtures/replays/lending-whale-bad-debt/riptide-output/replays/lending-whale-bad-debt`

## Summary

| Metric | Value |
|--------|-------|
| final_tvl | 500 |
| final_utilization | 0 |
| largest_single_tick_drawdown | 0.1667 |
| total_bad_debt | 3600 |

**Agent lifecycle**: 10 active, 0 liquidated, 0 depleted

## Invariants

| Invariant | Firings | First tick |
|-----------|---------|------------|
| no_bad_debt | 1 | T4 |

## Notable events

- T4: otc-liquidator-0 (otc-liquidator-0) — liquidate → success
- T4: otc-liquidator-1 (otc-liquidator-1) — liquidate → success
- T4: otc-liquidator-2 (otc-liquidator-2) — liquidate → success
- T4: otc-liquidator-3 (otc-liquidator-3) — liquidate → success
- T4: otc-liquidator-4 (otc-liquidator-4) — liquidate → success
- T4: Engine — invariant_violation:no_bad_debt → failed

## Simulation boundaries

- Replay mode bypasses persona compilation and dispatches a declared instruction trajectory directly.
- Trajectory args are supplied inline per event; generic adapters may still fall back to adapter literals for unmapped constants.
- initial-state.json, when present, is applied as a pre-tick bootstrap instruction list before tick 0 is recorded.
- Agent balance/PnL fields are bookkeeping-only in replay mode; authoritative outputs are primitive snapshots, events, and invariant rollups.

## How to reproduce

```sh
riptide replay config.json
```
