# Examples

This directory contains the smallest hands-on demo for Riptide: two lending runs with the same seed, same program, same shock, and different persona mixes.

## Run The Demo

Preconditions:

```bash
cargo build --release -p riptide-engine
cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
(cd cli && npm install --ignore-scripts && npm run build)
```

Then run:

```bash
bash examples/run-demo.sh
```

The script executes:

- `examples/configs/safe.json` with cautious depositor/LP behavior.
- `examples/configs/risky.json` with leverage-heavy and panic behavior.

Both runs use `fixtures/adapters/lending.toml`, seed `42`, ten ticks, five agents, and the same price-shock scenario.

## What To Look For

Expected headline output:

| Metric | Safe | Risky |
| --- | ---: | ---: |
| Final TVL | 850.00 | 300.00 |
| Final utilization | 0.000 | 43.470 |
| Total liquidations | 0 | 2 |
| Total bad debt | 0.00 | 0.00 |
| Surviving agents | 5 | 3 |
| Liquidated agents | 0 | 2 |

The useful point is not the exact demo size. It is the posture: keep the program and shock fixed, swap declared actor behavior, and inspect how the economic outcome changes.

> [!NOTE]
> `bad_debt = 0` in both demo runs. The risky run demonstrates forced liquidations, not a bad-debt cascade. For the larger parameter-region example, read the [Solend-fork whale-shock grid](../docs/case-studies/lending.md).

## Other Entry Points

Run a shipping scenario through the normal CLI:

```bash
riptide run lending/whale-shock-grid --serve
```

Run the generic non-DeFi adapter directly:

```bash
cargo build-sbf --manifest-path programs/resource_grinder/Cargo.toml
mkdir -p examples/outputs/generic-smoke
target/release/riptide-engine \
  --adapter fixtures/adapters/resource-grinder.toml \
  --config fixtures/generic-demo.run.json \
  --policies fixtures/generic-demo.policies.json \
  --output examples/outputs/generic-smoke/simulation-result.json
```

Optional skills can draft larger starter catalogs from an adapter, but the examples here are intentionally plain files.
