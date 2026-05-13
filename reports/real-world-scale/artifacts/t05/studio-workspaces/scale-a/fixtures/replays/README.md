# Replay Fixture Format

The user-facing CLI takes a replay-config JSON (shipped examples are named `config.json`, but any path works):

```text
riptide replay <config.json>
```

The config JSON is a thin wrapper that points at the adapter + the
fixture directory:

```json
{
  "adapter": "./adapter.toml",
  "trajectory_dir": ".",
  "output_path": "riptide-output/replays/<incident>"
}
```

Paths in the config resolve relative to the config file's own
location, so a committed `config.json` next to the fixture is
portable. The engine binary itself takes adapter + trajectory +
output as separate flags; only the Node CLI wraps them in one JSON.

A fixture directory looks like this:

```text
fixtures/replays/<incident>/
├── trajectory.json          # required
├── oracle-trajectory.json   # optional
├── initial-state.json       # optional
├── expected-summary.json    # optional regression baseline
└── adapter.toml             # optional; replay-scoped adapter variant
```

`adapter.toml` is optional. Ship it alongside the trajectory when
the replay needs configuration or invariants that the shipped
adapter under `fixtures/adapters/` does not carry — for example,
the whale-bad-debt replay under `lending-whale-bad-debt/` ships a
replay-scoped `adapter.toml` with a `no_bad_debt` invariant so the
credibility gate can assert the cascade fires on a
machine-checkable invariant event, without mutating the shipped
`fixtures/adapters/lending.toml` and breaking the hero-grid
byte-stability. Replays that do not need custom
configuration can point the replay-config JSON directly at a
shipped adapter and skip the sibling `adapter.toml`.

Current named incident-shape fixtures include Mango oracle-pump,
Euler donate-and-liquidate, KelpDAO unbacked-LST, Loopscale
collateral-mispricing, and Drift fake-collateral vault-drain. These
are machine-checkable economic-shape replays with explicit boundaries,
not byte-level historical reconstructions or audit signoff.

## `trajectory.json`

Required. Declares the replay metadata plus the per-tick instruction stream.

```json
{
  "metadata": {
    "name": "lending-whale-bad-debt",
    "description": "Failure-shape pressure replay",
    "source": "Public post-mortem + on-chain archaeology"
  },
  "ticks": [
    {
      "tick": 0,
      "instructions": [
        {
          "name": "deposit",
          "agent": "whale_0",
          "args": { "amount": 5000000 }
        }
      ]
    }
  ]
}
```

- `name` is resolved against the adapter action surface first.
- For generic adapters, if `name` does not match an adapter action but does match an IDL instruction, the replay dispatches the raw IDL instruction directly.
- `agent` is a stable logical actor id. Replay sorts the unique actor ids deterministically before bootstrapping LiteSVM, so the same fixture always maps to the same on-chain signer ordering.
- `args` keys must match the instruction's Borsh argument names. `args.amount` is treated as the runtime amount.
- `args.target` is **context-sensitive**:
  - When the adapter does NOT declare a `target` arg for this action under `[actions.<name>].takes`, `args.target` is the replay-reserved **pairwise-actor key** — its string value resolves to an actor id via the replay's actor index, gets passed to the primitive as a separate `target_idx` (used by lending's `liquidate` to identify the victim position), and is stripped from the args passed to the encoder.
  - When the adapter DOES declare a `target` arg for this action (e.g. a generic IDL with `swap(amount_in, target, direction)` where `target` is a real Borsh arg), `args.target` is a normal IDL arg and is passed through to the encoder unchanged. In this case `target` is NOT read as an actor id and no `target_idx` is populated.
  - Adapters that do not map an action via `[actions.<name>]` at all (pure raw-IDL dispatch) currently fall back to the pairwise-actor interpretation. If your raw-IDL instruction has a real `target` arg, declare it via `[actions.<name>].takes` in the adapter so replay routes it correctly.

## `oracle-trajectory.json`

Optional. Tick-aligned oracle updates:

```json
{
  "ticks": [
    { "tick": 0, "price": 34.5, "exponent": 0 },
    { "tick": 42, "price": 22.1, "exponent": 0 }
  ]
}
```

- Ticks omitted from the file keep the most recent pushed price.
- Duplicate oracle ticks are rejected.

## `initial-state.json`

Optional. v0 uses a **bootstrap instruction list** that is applied before tick 0 is recorded:

```json
{
  "instructions": [
    {
      "name": "deposit",
      "agent": "whale_0",
      "args": { "amount": 2500000 }
    }
  ]
}
```

This keeps replay fixtures declarative while avoiding raw account snapshot import. The opening tick-0 snapshot reflects the state after these bootstrap instructions have been applied.

## `expected-summary.json`

Optional. Stored after the first successful replay and used as the regression baseline for replay integration tests. The fixtures capture the exact bytes the engine produced so replay determinism is CI-checkable.
