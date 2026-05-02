//! Rust harness extension points for generic adapters.
//!
//! A project harness owns protocol-specific world construction while
//! the engine owns the tick loop, adapter dispatch, artifacts, and
//! invariant evaluation. Harness setup runs after the generic LiteSVM
//! bootstrap and before tick 0, so developers can replace zeroed
//! accounts with realistic bytes, load sibling programs, or bind
//! adapter account names to custom pubkeys.

use std::{path::Path, str::FromStr};

use anyhow::{anyhow, bail, Result};
use solana_account::Account;
pub use solana_sdk::{pubkey::Pubkey, signature::Signer};

use crate::primitive::generic::{load_generic_program_bytes, resolve_generic_program_id};
use crate::primitive::GenericHarness;

const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// Developer-owned setup hook for a generic Riptide simulation.
///
/// Implement this trait in the generated harness crate. Keep setup
/// deterministic: use fixed seeds/pubkeys or adapter-derived PDAs
/// whenever the account identity is part of a scenario or invariant.
pub trait RiptideHarness {
    fn setup(&self, ctx: &mut HarnessContext<'_>) -> Result<()>;
}

/// Default no-op harness used by tests and by callers that want the
/// same behavior as the plain generic runtime through the harness API.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopHarness;

impl RiptideHarness for NoopHarness {
    fn setup(&self, _ctx: &mut HarnessContext<'_>) -> Result<()> {
        Ok(())
    }
}

/// Safe, small surface area over the bootstrapped generic LiteSVM
/// harness. The context intentionally exposes helpers in protocol
/// terms rather than raw field access so generated project harnesses
/// stay readable.
pub struct HarnessContext<'a> {
    harness: &'a mut GenericHarness,
}

impl<'a> HarnessContext<'a> {
    pub fn new(harness: &'a mut GenericHarness) -> Self {
        Self { harness }
    }

    pub fn program_id(&self) -> Pubkey {
        self.harness.program_id
    }

    pub fn admin_pubkey(&self) -> Pubkey {
        self.harness.admin.pubkey()
    }

    pub fn agent_pubkey(&self, agent_idx: usize) -> Result<Pubkey> {
        self.harness
            .agents
            .get(agent_idx)
            .map(Signer::pubkey)
            .ok_or_else(|| anyhow!("harness requested agent {agent_idx}, but no such agent exists"))
    }

    pub fn agent_count(&self) -> usize {
        self.harness.agents.len()
    }

    pub fn shared_pubkey(&self, name: &str) -> Result<Pubkey> {
        self.harness
            .inspect_shared_account_pubkey(name)
            .ok_or_else(|| {
                anyhow!("harness account `{name}` is not declared as a shared adapter account")
            })
    }

    pub fn agent_account_pubkey(&self, name: &str, agent_idx: usize) -> Result<Pubkey> {
        self.harness
            .inspect_agent_account_pubkey(name, agent_idx)
            .ok_or_else(|| {
                anyhow!(
                    "harness account `{name}` is not declared as an agent adapter account \
                     or has no entry for agent index {agent_idx}"
                )
            })
    }

    pub fn bind_shared_account(&mut self, name: &str, pubkey: Pubkey) -> Result<()> {
        self.harness.bind_shared_account(name, pubkey)
    }

    pub fn bind_agent_accounts(&mut self, name: &str, pubkeys: Vec<Pubkey>) -> Result<()> {
        self.harness.bind_agent_accounts(name, pubkeys)
    }

    pub fn minimum_balance_for_rent_exemption(&mut self, space: usize) -> u64 {
        self.harness
            .svm_mut()
            .minimum_balance_for_rent_exemption(space)
    }

    pub fn set_raw_account(
        &mut self,
        pubkey: Pubkey,
        owner: Pubkey,
        data: Vec<u8>,
        lamports: Option<u64>,
    ) -> Result<()> {
        let lamports = lamports.unwrap_or_else(|| {
            self.harness
                .svm_mut()
                .minimum_balance_for_rent_exemption(data.len())
        });
        self.harness
            .svm_mut()
            .set_account(
                pubkey,
                Account {
                    lamports,
                    data,
                    owner,
                    ..Default::default()
                },
            )
            .map_err(|error| anyhow!("harness failed to set account {pubkey}: {error}"))
    }

    pub fn set_shared_account_data(
        &mut self,
        name: &str,
        owner: Pubkey,
        data: Vec<u8>,
    ) -> Result<Pubkey> {
        let pubkey = self.shared_pubkey(name)?;
        self.set_raw_account(pubkey, owner, data, None)?;
        Ok(pubkey)
    }

    pub fn set_agent_account_data(
        &mut self,
        name: &str,
        agent_idx: usize,
        owner: Pubkey,
        data: Vec<u8>,
    ) -> Result<Pubkey> {
        let pubkey = self.agent_account_pubkey(name, agent_idx)?;
        self.set_raw_account(pubkey, owner, data, None)?;
        Ok(pubkey)
    }

    pub fn load_program_from_so(&mut self, so_path: impl AsRef<Path>) -> Result<Pubkey> {
        let so_path = so_path.as_ref();
        let program_bytes = load_generic_program_bytes(so_path)?;
        let program_id = resolve_generic_program_id(so_path, None, None)?;
        self.harness
            .svm_mut()
            .add_program(program_id, &program_bytes)
            .map_err(|error| {
                anyhow!(
                    "harness failed to load program {} as {program_id}: {error}",
                    so_path.display()
                )
            })?;
        Ok(program_id)
    }

    pub fn derive_pda(&self, seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(seeds, program_id)
    }

    pub fn token_program_id(&self) -> Pubkey {
        Pubkey::from_str(SPL_TOKEN_PROGRAM_ID).expect("SPL token program id is valid")
    }

    pub fn spl_mint(
        &mut self,
        account_name: &str,
        mint_authority: Pubkey,
        supply: u64,
        decimals: u8,
    ) -> Result<Pubkey> {
        self.set_shared_account_data(
            account_name,
            self.token_program_id(),
            spl_token_mint_data(mint_authority, supply, decimals),
        )
    }

    pub fn spl_token_account(
        &mut self,
        account_name: &str,
        mint: Pubkey,
        authority: Pubkey,
        amount: u64,
    ) -> Result<Pubkey> {
        self.set_shared_account_data(
            account_name,
            self.token_program_id(),
            spl_token_account_data(mint, authority, amount),
        )
    }

    pub fn agent_spl_token_account(
        &mut self,
        account_name: &str,
        agent_idx: usize,
        mint: Pubkey,
        authority: Pubkey,
        amount: u64,
    ) -> Result<Pubkey> {
        self.set_agent_account_data(
            account_name,
            agent_idx,
            self.token_program_id(),
            spl_token_account_data(mint, authority, amount),
        )
    }

    pub fn require_declared_account(&self, name: &str) -> Result<()> {
        if self.harness.adapter().accounts.contains_key(name) {
            Ok(())
        } else {
            bail!("harness references `{name}`, but the adapter has no `[accounts.{name}]` entry")
        }
    }
}

fn spl_token_mint_data(mint_authority: Pubkey, supply: u64, decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(mint_authority.as_ref());
    data[36..44].copy_from_slice(&supply.to_le_bytes());
    data[44] = decimals;
    data[45] = 1;
    data
}

fn spl_token_account_data(mint: Pubkey, authority: Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(authority.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    data
}
