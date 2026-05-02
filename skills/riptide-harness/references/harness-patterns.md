# Riptide Harness Patterns

Use this reference after `SKILL.md` decides a harness is needed.

## Helper Surface

Import:

```rust
use riptide_engine::harness::{run_harness_cli, HarnessContext, RiptideHarness};
```

Common `HarnessContext` helpers:

- `ctx.require_declared_account(name)?`
- `ctx.admin_pubkey()`
- `ctx.agent_pubkey(agent_idx)?`
- `ctx.shared_pubkey(name)?`
- `ctx.agent_account_pubkey(name, agent_idx)?`
- `ctx.bind_shared_account(name, pubkey)?`
- `ctx.bind_agent_accounts(name, pubkeys)?`
- `ctx.set_shared_account_data(name, owner, data)?`
- `ctx.set_agent_account_data(name, agent_idx, owner, data)?`
- `ctx.load_program_from_so(path)?`
- `ctx.derive_pda(seeds, program_id)`
- `ctx.token_program_id()`
- `ctx.spl_mint(account_name, mint_authority, supply, decimals)?`
- `ctx.spl_token_account(account_name, mint, authority, amount)?`
- `ctx.agent_spl_token_account(account_name, agent_idx, mint, authority, amount)?`

Check `engine/src/harness/plugin.rs` for the authoritative helper
signatures when editing a harness.

## Minimal Skeleton

```rust
use riptide_engine::harness::{run_harness_cli, HarnessContext, RiptideHarness};

struct ProjectHarness;

impl RiptideHarness for ProjectHarness {
    fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
        ctx.require_declared_account("pool_state")?;
        Ok(())
    }
}

fn main() -> std::process::ExitCode {
    run_harness_cli(ProjectHarness)
}
```

## SPL Mint + Shared Vaults

For AMM-style vault observation:

```rust
fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
    let authority = ctx.admin_pubkey();
    let mint_src = ctx.spl_mint("mint_src", authority, 1_000_000_000, 6)?;
    let mint_dst = ctx.spl_mint("mint_dst", authority, 1_000_000_000, 6)?;

    ctx.spl_token_account("vault_src", mint_src, authority, 500_000)?;
    ctx.spl_token_account("vault_dst", mint_dst, authority, 500_000)?;

    Ok(())
}
```

Pair this with adapter accounts:

```toml
[accounts.vault_src]
kind = "shared"
space = 165
decoder = "spl_token_account"

[state_mapping]
"vault_src.amount" = "pool.reserve_src"
```

The SPL token account preset reads `amount` from byte offset 64. The
harness only needs to write valid SPL Token account bytes; decoding is
owned by the adapter.

## Agent Token Accounts

For one token account per simulated agent:

```rust
fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
    let authority = ctx.admin_pubkey();
    let mint = ctx.spl_mint("mint", authority, 1_000_000_000, 6)?;

    for idx in 0..ctx.agent_count() {
        let owner = ctx.agent_pubkey(idx)?;
        ctx.agent_spl_token_account("user_ata", idx, mint, owner, 100_000)?;
    }

    Ok(())
}
```

Use this only when `[accounts.user_ata].kind = "agent"`.

## PDA Binding

If an adapter account must use a concrete PDA rather than the default
bootstrap key:

```rust
fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
    let (pool_pda, _bump) = ctx.derive_pda(&[b"pool"], &ctx.program_id());
    ctx.bind_shared_account("pool_state", pool_pda)?;

    ctx.require_declared_account("pool_state")?;
    Ok(())
}
```

Prefer declaring PDA seeds in the adapter when the seed recipe is
static. Use harness binding when source/tests show a concrete address
or when the setup must coordinate multiple derived accounts.

## Raw Shared Account Bytes

When no helper exists, build the exact bytes the program expects:

```rust
fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
    let mut data = vec![0u8; 128];
    data[0..8].copy_from_slice(b"DISCRIM8"); // TODO: replace with real discriminator
    data[8..16].copy_from_slice(&1_000_000u64.to_le_bytes());

    ctx.set_shared_account_data("pool_state", ctx.program_id(), data)?;
    Ok(())
}
```

Keep a TODO comment beside every byte offset that came from inference
rather than source/test evidence.

## Sibling Program

Load a sibling CPI target before the simulation starts:

```rust
fn setup(&self, ctx: &mut HarnessContext<'_>) -> anyhow::Result<()> {
    let token_like_program = ctx.load_program_from_so("../target/deploy/dependency.so")?;
    // Bind or write accounts owned by `token_like_program` here.
    let _ = token_like_program;
    Ok(())
}
```

The path is resolved from the harness process working directory. Use a
relative path that works from the repo root when launched by:

```sh
riptide run --adapter .riptide/adapters/<program>.toml --harness .riptide/harness --seeds 1 --seed-root 1337
```

## Validation Checklist

Run:

```sh
riptide lint <adapter-name-or-path>
cargo build --release --quiet --manifest-path .riptide/harness/Cargo.toml
riptide run --adapter <adapter> --harness .riptide/harness --seeds 1 --seed-root 1337
```

Inspect `.riptide/run-collection.json` and the scenario artifacts if
the run is inconclusive. A successful harness smoke should produce
successful write events and at least one relevant observation delta
when the adapter is meant to prove state movement.
