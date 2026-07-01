# Setup — the guided-sim authoring contract

Step 3 of the flow: with the family detected and the triggers classified, author
the adapter, generate the project-owned sim crate, fill the setup seams with
deterministic facts, and author the flows + the sweep.

## 3. Setup (folded inline — the guided-sim authoring contract)

This skill is self-contained: the setup below is the essential authoring
altitude. For the full configuration contract (repair-loop taxonomy, profiles,
verdict semantics), see the public repo at
`https://github.com/riptidesim/riptide` — it is optional reading, never a
required co-located file.

**a. Bootstrap the scaffold.**

```bash
riptide init      # only if .riptide/ is absent and the program name is unambiguous
```

`riptide init` creates only a thin `.riptide/` bootstrap (adapter placeholder +
`GETTING-STARTED.md`). You own the rest.

**b. Author the adapter** (`.riptide/adapters/<program>.toml`). It declares
account shape, instruction mappings, scheduled actions, observations, personas,
invariants, semantics, oracle channels, and `[lineage]`. Rules:

- If `program_so` and `idl_path` are both set, the runtime is Generic SBF/IDL.
- Every required IDL account must be represented by `[accounts.<name>]`, a
  recognized signer alias (`authority`, `owner`, `user`, `payer`), a well-known
  program/sysvar alias, or an IDL literal `address`. Do not omit setup-heavy
  accounts (`price_update_v2`, reserve vaults, per-agent token accounts) just
  because generated setup fills their bytes later.
- Top-level `[[invariants]]` may reference only keys declared in
  `[observations]`.
- Always include `[lineage]` with the IDL source, assumptions, and unsupported
  surfaces.

Validate after every adapter edit: `riptide doctor`. Fix any named field error
before moving on.

**c. Generate the sim crate.**

```bash
riptide sim generate --adapter .riptide/adapters/<program>.toml
```

This scaffolds `.riptide/sim` with `Riptide.toml`, `src/flows.rs`,
`src/invariants.rs`, generated `types.rs` / `accounts.rs`, and a `services/`
directory. Setup code carries `TODO(setup)` markers where pre-tick-0 state must
exist. Keep `types.rs` / `accounts.rs` regenerated-only; put hand-authored
actions, dynamic account resolution, and service models under `flows.rs`,
`invariants.rs`, `services/`.

**d. Fill the `TODO(setup)` seams.** Fill every seam with **deterministic
facts** — account bytes, SPL mints/vaults, PDAs, sibling programs, oracle
accounts — derived from local source, IDL, tests, constants, and fixtures.
Fixed amounts, fixed decimals, fixed seeds, no network calls. **TODO-only setup
is not acceptable** when setup-heavy accounts are required and derivable: before
declaring a blocker, inspect source/tests/IDL/dependency types/constants/fixtures
for owners, discriminators, sizes, PDA seeds, feed IDs, and serialization. If a
fact genuinely cannot be determined locally, stop and report
`blocked = missing deterministic <fact> for guided-sim setup`, naming the
account/instruction — never hide it behind a vague comment.

Declare external programs, accounts, and forked snapshots generically in
`Riptide.toml` (do not teach Riptide core protocol-specific layouts):

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

**e. Author flows, personas, and the sweep.** Generic personas stay inline in
the adapter; the sweep and flows in the crate drive them. Map triggers to seams:
A → typed builders; B → deterministic oracle-account bytes in setup seams or
project-owned services; C/D/E → hand-authored flows in `flows.rs`; F →
`Riptide.toml` program/account declarations plus bootstrap services. Then
declare the sweep + evidence-honesty blocks in `.riptide/sim/Riptide.toml` (see
[authoring-patterns.md](./authoring-patterns.md)). Map IDL changes forward with
`riptide sim refresh --adapter .riptide/adapters/<program>.toml --dir .riptide/sim`.
