# Riptide demo — safe vs risky (lending)

> This is the lending-primitive demo. For the non-DeFi generic-primitive
> demo, see the "Generic (non-DeFi) demo" section at the bottom, or run
> the engine directly with
> `--adapter fixtures/adapters/resource-grinder.toml` and the
> `fixtures/generic-demo.*.json` fixtures.

## Two paths in

> *"Two ways to use Riptide: write your own experiments if you already know what you're testing for, or let the `riptide-scenarios` skill propose a starter catalog based on your program. Both run deterministically against your real code and surface the knife edges. Zero setup inside Claude Code."*

This demo directory exercises **both** paths. They are additive — Path B does not replace Path A, it just lowers the activation energy for devs who don't yet know what to test.

### Path A — write your own experiments

The safe-vs-risky walkthrough below is the canonical Path A demo: two hand-authored `RunConfig` files (`configs/safe.json`, `configs/risky.json`), the shipped persona policies, and one shell script (`run-demo.sh`) that drives them. You already know what you're testing for — "does persona mix alone flip the outcome at a 50 % shock?" — so you write the experiment directly.

The Sprint 4 hero grid at [`../docs/sprint-4/hero-grid.md`](../docs/sprint-4/hero-grid.md) is the same Path A posture at a larger scale: a 3×3 whale × shock parameter-boundary discovery run, hand-authored against the Solend fork, with the load-bearing claim *Riptide maps the danger region; Solend's actual parameters sit inside it.*

### Path B — let the `riptide-scenarios` skill propose a starter catalog

Install the skill at [`../skills/riptide-scenarios/SKILL.md`](../skills/riptide-scenarios/SKILL.md) and invoke it inside a Claude Code session on an adapter + IDL. The skill classifies plausible failure modes for your program and proposes 3–5 ranked starter experiments (whale concentration, shock cascades, utilization stress, persona-mix instability, oracle lag), writing generated run-configs to `fixtures/scenarios/<adapter>/<experiment>/`. The skill does **not** autorun — the dev picks what to run.

One-command invocation inside a Claude Code session on the Solend-fork adapter:

```
/riptide-scenarios fixtures/adapters/solend-fork.toml
```

The Solend run independently proposes a whale-share sweep from classification — the same shape as the hero grid's whale axis — which is the R2.8 credibility gate for the pitch claim. See `fixtures/scenarios/solend-fork/whale-share-sweep/` for the generated starter.

## Caveat — lab, not oracle

> **Riptide is a lab, not an oracle.** The dev picks the experiment —
> Riptide does not tell you what's wrong with your program. Riptide runs the
> experiment deterministically: same seed in, same bytes out, every time, so
> the grid you're reading is reproducible from the adapter TOML and the
> persona TOML alone. And nobody is claiming this catches bugs on its own.
> The grid maps a parameter region; the dev draws the conclusions. A cell
> that comes back with bad debt is not a bug report — it is a point in
> parameter space where the program's math lost headroom, and the dev is the
> one who decides whether that point matters.

---

## Path A — safe vs risky walkthrough

Two `RunConfig` files (`configs/safe.json`, `configs/risky.json`) plus
`run-demo.sh`, which drives the Node CLI wrapper
(`node cli/dist/src/index.js simulate --adapter
fixtures/adapters/solend-fork.toml`) against each and prints a
side-by-side comparison of headline metrics. The engine itself boots
from `--config / --policies / --output / --adapter` flags; the Node
wrapper composes the persona/policy artifacts and invokes it under the
hood.

Both configs use:
- identical scenario (`price-shock`)
- identical seed (`42`)
- identical pool protocol parameters (LTV 7000, liquidation threshold
  8000, liquidation bonus 500)
- identical tick count (`10`) and agent count (`5`)
- the same adapter TOML (`fixtures/adapters/solend-fork.toml`) — the
  demo drives the Solend-fork `LendingPrimitive` via the adapter, not
  via hardcoded harness wiring

The only difference is the persona mix:
- **safe** → `cautious-yield-farmer`, `steady-lp`
- **risky** → `panic-whale`, `degen-borrower`, `aggressive-arb-bot`

The shipped persona policies are **not modified** — they are the same
defaults the CLI ships with.

## Preconditions

1. Engine built: `cargo build --release -p riptide-engine`
2. Lending program built: `cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml`
3. CLI built: `(cd cli && npm run build)`

No external validator or funded payer keypair is required — the engine
runs an in-process LiteSVM backend.

## Run

```bash
bash demo/run-demo.sh
```

## Tuning — the one knob the demo turns

`run-demo.sh` sets exactly one tuning env var:

| env var                    | default | demo | rationale |
|----------------------------|---------|------|-----------|
| `RIPTIDE_PRICE_SHOCK_DROP` | 0.40    | 0.50 | A 50% drop is where degen-borrower's borrow ratio flips from healthy to underwater against the default 8000-bps liquidation threshold. A 40% drop is a stress event but not a cascade event for the shipped persona mix; a 50% drop is. |

Pool parameters (`LTV 7000 / liquidation threshold 8000 / liquidation
bonus 500`) and per-agent starting balance (`$20,000 cash + $10,000 in
seed collateral`) stay at their engine defaults. The demo is not
cherry-picking pool params — it's exercising the baseline economic
regime and just turning the shock up one notch so leveraged personas
get tested at their breaking point.

## Expected output (baseline, for regression detection)

With the demo's one knob and seed 42:

```
metric                                  safe           risky
------------------------------------------------------------
final TVL                             850.00          300.00
final utilization                      0.000          43.470
total liquidations                         0               2
total bad debt                          0.00            0.00
surviving agents                           5               3
liquidated agents                          0               2
largest tick drawdown                  12.00          200.00
event count                               50              40
```

These numbers are reproducible (same seed) and come from an actual
`bash demo/run-demo.sh` run, not a projection.

### Per-agent outcomes

**safe (all active, MTM-only losses):**

| agent       | persona                | status | realized PnL |
|-------------|------------------------|--------|--------------|
| agent-001   | cautious-yield-farmer  | active | -6,422       |
| agent-002   | steady-lp              | active | -6,723       |
| agent-003   | cautious-yield-farmer  | active | -6,422       |
| agent-004   | steady-lp              | active | -6,723       |
| agent-005   | cautious-yield-farmer  | active | -6,422       |

**risky (2 liquidations, split across personas):**

| agent       | persona              | status      | PnL    | liquidated at tick |
|-------------|----------------------|-------------|--------|--------------------|
| agent-001   | panic-whale          | active      | +5     | —                  |
| agent-002   | degen-borrower       | active      | -4,616 | —                  |
| agent-003   | aggressive-arb-bot   | liquidated  | -5,246 | 5                  |
| agent-004   | panic-whale          | active      | +5     | —                  |
| agent-005   | degen-borrower       | liquidated  | -5,175 | 7                  |

### Action mix

Same 10-tick window, same pool, same seed — the behavior diverges
qualitatively, not just in magnitude:

| action / outcome        | safe | risky |
|-------------------------|------|-------|
| deposit / success       | 44   | 8     |
| withdraw / success      | 6    | 12    |
| borrow / success        | 0    | 8     |
| borrow / failed         | 0    | 8     |
| liquidate / success     | 0    | 2     |
| liquidate / failed      | 0    | 1     |
| liquidate / skipped     | 0    | 1     |

Safe never opens a single borrow or liquidation; risky attempts 16
borrows and 4 liquidations and lands half of each.

## What the demo proves — plainly

**Same protocol, same shock, same seed. Persona mix alone drives the
outcome.**

- **Safe** never opens a borrow. The 50% price drop still hurts their
  deposited collateral (MTM losses of ~6,500 per agent against a
  20,000 starting balance, i.e. ~32% of equity), but nobody is
  insolvent, nobody is liquidated, and the pool carries zero bad debt.
  The two cautious personas shipped with the tool produce a market
  state that absorbs the shock.
- **Risky** opens 8 successful borrows, pushes pool utilization to 43x
  of available headroom, and ends with 2 realized on-chain
  liquidations (agent-003 at tick 5, agent-005 at tick 7). Panic-whale
  agents never took leverage and exit with ~0 PnL; the leveraged
  personas (aggressive-arb-bot and degen-borrower) get wiped or
  heavily drawn down.
- The safe cohort's MTM losses (~6.5k each, active agents) and the
  risky cohort's realized losses (~5k each, liquidated) are comparable
  in dollar terms but very different in *kind*: safe is a cohort of
  surviving holders marked down together; risky is a cohort with
  winners and losers, forced closures, and protocol-level solvency
  events.

**Caveats, documented honestly:**

- `final_utilization = 43.47` on the risky side looks like an
  off-by-default because it's stored as `total_borrows /
  total_deposits` and the aggressive personas drain most deposits via
  withdraws while leaving borrows on the book. It is a real number —
  the pool has 20 deposit-units and 870 borrow-units outstanding at
  the end of tick 10 — but it is an artifact of withdraw-heavy
  behavior under a small seed pool, not a pool-health metric. Read it
  as "borrows dominate deposits in the risky tail", not as "utilization
  is 4347%".
- `bad_debt = 0` in both runs. The risky cohort loses money through
  liquidation, but the liquidator seized enough collateral to cover
  the debt; no bad debt accrues to the pool. Larger agent counts or a
  harsher shock would start producing bad debt, but that's future
  work, not this demo.

## Relationship to T15

The T15 e2e test (`cli/test/e2e.test.ts`) asserts the same three
outcomes as first-class test gates:

1. Risky mix: `total_liquidations >= 1`, `agents_liquidated >= 1`,
   at least one successful `borrow` event.
2. Safe mix: `total_liquidations == 0`, `agents_liquidated == 0`,
   `agents_active == 5`, zero `borrow` and zero `liquidate` events.
3. Determinism: two back-to-back runs of the risky mix produce
   byte-identical artifacts modulo the tmp `output_path` field.

The test is gated on `RIPTIDE_RUN_E2E=1` so the standard `npm test`
run stays hermetic; the gated run exercises the exact same subprocess
path the demo script uses.

## Generic (non-DeFi) demo

The resource-grinder demo proves the `GenericPrimitive` escape hatch
end-to-end against a program with zero lending semantics. It boots the
engine directly (no Node wrapper needed) off the generic fixtures:

```bash
cargo run --release -p riptide-engine -- \
  --config fixtures/generic-demo.run.json \
  --policies fixtures/generic-demo.policies.json \
  --adapter fixtures/adapters/resource-grinder.toml \
  --output /tmp/riptide-generic-demo.json
```

Preconditions: `cargo build-sbf --manifest-path
programs/resource_grinder/Cargo.toml` must have been run at least once
so the `.so` referenced by the adapter exists. The generic demo is
byte-stable under
`cargo test -p riptide-engine --test t15_e2e_determinism`.
