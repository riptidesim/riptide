# Setup — the guided-sim authoring contract

With the target classified and the triggers scoped, author the adapter,
generate the project-owned sim crate, fill the setup seams with deterministic
facts, and author the flows, personas, invariants and sweep. Every file here is
an Internal Artifact in the `.riptide/` Workspace: the agent writes and repairs
all of it.

## a. The Workspace

```bash
riptide init      # only when .riptide/ is absent
```

`riptide init` never reads stdin. It writes one adapter per detected program
and the Workspace ignore file `.riptide/.gitignore`, which excludes build
output and run scratch (`target/`, `runs/`, `last-run.json`) so the rest of
`.riptide/` can be committed. When the Steering Hint names one program, pass
`--program <name>`. When several programs are detected and no Steering Hint
narrows them, scaffold all of them and record the chosen target in the Scope
Declaration.

A thin init scaffold is normal input, not an unfinished user task. Own
adapter, persona, flow, sweep and invariant authoring from it.

### Reusing an existing Workspace

When `.riptide/` already carries authored choices, they are source-of-truth
inputs, not disposable scaffolding:

- Preserve selected personas in the adapter unless source facts prove a
  persona cannot execute against it. A removed or renamed persona goes into
  the Scope Declaration with the reason.
- Preserve selected flow emphasis and existing `.riptide/sim/Riptide.toml`
  sweep values for `name`, `values`, `seeds_per_value` and the persona mix
  unless a bounded run proves a value invalid. A changed value goes into the
  Scope Declaration with before/after values.
- Sweep and flow defaults may differ per run (a baseline run sweeps a narrow
  axis, a stress run a wider one). Report those as existing run settings, not
  as rewrites.
- A single `--seed <hex>` with low `--iterations` is for bounded smoke gates
  only. Do not rewrite the stored `[sim.sweep] seeds_per_value` just because
  the smoke used a one-seed override.
- Any other changed persona, flow, invariant, setup seam or sweep is recorded
  with the validation reason for the change.
- After IDL changes, refresh the generated builders without overwriting
  authored flows:

  ```bash
  riptide sim refresh --adapter .riptide/adapters/<program>.toml --dir .riptide/sim
  ```

## b. Author the adapter

`.riptide/adapters/<program>.toml` declares account shape, instruction
mappings, scheduled actions, observations, personas, invariants, semantics,
oracle channels and `[lineage]`. Fill or repair it before generating the sim
crate.

- If `program_so` and `idl_path` are both set, the runtime is Generic SBF/IDL,
  even when a `protocol = "lending"` hint remains.
- For mapped IDL instructions, every required IDL account must be represented
  by `[accounts.<name>]`, a recognized signer alias (`authority`, `owner`,
  `user`, `payer`), a well-known program/sysvar alias, or an IDL literal
  `address`.
- Do not omit setup-heavy accounts just because generated setup fills their
  bytes later. Declare bindings for accounts like `price_update_v2`,
  `receipt_mint`, reserve vault/token accounts and per-agent token accounts.
- `[[scheduled_actions]].accounts` must name declared `[accounts.*]` entries.
- Top-level `[[invariants]]` may reference only keys declared in
  `[observations]`. Remove snapshot metrics such as `active_agents`,
  `utilization`, `cumulative_bad_debt`, `cumulative_liquidations`,
  `oracle_price` and `tick` unless the adapter declares them as observations.
- Always include `[lineage]` with the IDL source, assumptions and unsupported
  surfaces.

Validate after every adapter edit:

```bash
riptide doctor --json
```

If doctor names an adapter field error, fix that field before moving on. If
doctor passes but a later sim load fails on missing account bindings, repair
the adapter and rerun doctor — that is a `CLI validation gap` (see
[repair.md](./repair.md)).

## c. Generate the sim crate

```bash
riptide sim generate --adapter .riptide/adapters/<program>.toml
```

This scaffolds `.riptide/sim` with `Riptide.toml`, `src/flows.rs`,
`src/invariants.rs`, generated `types.rs` / `accounts.rs`, a `services/`
directory and `setup-gaps.json`, which names every tick-0 seam the Engine
refused to invent. Setup code carries `TODO(setup)` markers where pre-tick-0
state must exist. Keep `types.rs` / `accounts.rs` regenerated-only; put
authored actions, dynamic account resolution and service models under
`flows.rs`, `invariants.rs` and `services/`.

## d. Fill the setup seams

Fill every `TODO(setup)` seam and every `setup-gaps.json` entry with
**deterministic facts** — account bytes, SPL mints/vaults, PDAs, sibling
programs, oracle accounts — derived from local source, IDL, tests, constants
and fixtures. Fixed amounts, fixed decimals, fixed seeds, no network calls.

The crate may build with `TODO(setup)` seams still present, but
**TODO-only setup is not acceptable** when setup-heavy accounts are required
and derivable. Before declaring a blocker, inspect source, tests, IDL, dependency
types, constants and local fixtures for account owners, discriminators, sizes,
PDA seeds, feed IDs and serialization.

For external-owned accounts such as oracle receiver accounts, use local
account bytes, checked-in snapshots or fork-cache entries. For Pyth
`PriceUpdateV2`, use `riptide_sim::oracle::PythPriceUpdate` instead of
hand-rolled bytes; other protocol-specific layouts stay project-owned. If the
exact layout, owner, feed ID or serialization cannot be determined from local
facts or an explicit `.riptide/sim/Riptide.toml` snapshot, record
`blocked = missing deterministic <fact> for guided-sim setup`, naming the
account and instruction. That surface becomes a Gap whose unblock is the
missing fact. Never hide it behind a vague TODO comment.

Declare external programs, accounts and forked snapshots generically in
`Riptide.toml` (never teach the Engine protocol-specific layouts):

```toml
[[sim.programs]]
address = "<program-id>"
program = "../target/deploy/dependency.so"

[[sim.accounts]]
address = "<account-pubkey>"
filename = "fixtures/accounts/dependency-account.json"

[[sim.fork]]
address = "<mainnet-account-pubkey>"
cluster = "mainnet"
filename = "fork-cache/mainnet/dependency-account.json"
overwrite = false
```

## e. Author flows, personas, invariants and the sweep

Map triggers to seams: A → typed builders; B → deterministic oracle-account
bytes in setup seams or project-owned services; C/D/E → authored flows in
`flows.rs`; F → `Riptide.toml` program/account declarations plus bootstrap
services. Wire the provided helpers instead of re-deriving their patterns (see
[authoring-patterns.md](./authoring-patterns.md)):

- `riptide_sim::oracle::PythPriceUpdate` (+ `crash_in_place`) constructs and
  mutates the Pyth `PriceUpdateV2` bytes a program's price read consumes.
- `riptide_sim::dispatch::ThirdPartyDispatch` builds the account set for an
  actor operating on another actor's position or order; `build()` enforces
  that the actor is the sole signer and the target never signs.

Do not add OpenBook, Drift, Mango, Marinade, Whirlpool or other
protocol-specific layouts to the Engine. When external account bytes must
evolve during a run, declare the programs/accounts/snapshots generically in
`Riptide.toml` and model the mutation in project-owned services.

Generic personas stay inline in the
adapter; the sweep and flows in the crate drive them. Do not write fixture `manifest.json`, `policies.json`,
or `.riptide/personas/` in user repos.

Wire every Floor Invariant the family requires (see
[family-library.md](./family-library.md)) and mark each invariant's
provenance: `floor` for the family's Floor Invariants, `agent` for anything
added on top.

Declare the sweep and the evidence-honesty blocks in `.riptide/sim/Riptide.toml`.
`riptide sim run` reads `[sim.sweep]` and runs one iteration per (value, seed
replicate). There is no `--sweep` flag and no campaign TOML — the sweep lives in `Riptide.toml`.
Size it to the Depth in [SKILL.md](./SKILL.md).

```toml
[sim.sweep]                      # the exogenous stress axis
name = "collateral_price_drop_bps"
values = [0, 1000, 2000, 3000, 4000, 5000, 6000]
seeds_per_value = 4

[sim.positive_control]           # the known-correct baseline coordinate
value = 0                        # usually axis value 0

[sim.lifecycle]                  # core flows that must execute on-chain
required_flows = ["create_lend_offer", "accept_lend_offer", "liquidate_loan"]
```

These blocks are load-bearing: `riptide sim run` warns when the positive
control or lifecycle checks fail, and `riptide assess` blocks the Engine Output
until they pass. In `flows.rs`, read the swept coordinate with
`world.sweep_value("<axis>")`, echo it with `world.record_parameter`, record
the deciding signal with `world.record_metric`, and fire the deciding
invariant with `world.record_invariant_fire` when the metric crosses the
stated risk line.
