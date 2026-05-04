// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::{collections::BTreeMap, path::Path};

use anyhow::{anyhow, Context, Result};
use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use solana_transaction::Transaction;

use crate::{
    bootstrap::BootstrapReport,
    rng::RiptideRng,
    services::Service,
    spl::{
        spl_mint_data, spl_token_2022_mint_data, spl_token_account_data, token_2022_program_id,
        token_program_id,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxOutcome {
    pub label: Option<String>,
    pub ok: bool,
    pub signature: String,
    pub error: Option<String>,
    pub logs: Vec<String>,
    pub compute_units_consumed: u64,
}

pub struct World {
    svm: LiteSVM,
    program_id: Pubkey,
    admin: Keypair,
    signers: BTreeMap<Pubkey, Keypair>,
    tx_log: Vec<TxOutcome>,
    services: Vec<Box<dyn Service>>,
    rng: RiptideRng,
}

impl World {
    pub fn new(program_id: Pubkey) -> Self {
        let admin = Keypair::new();
        let mut svm = LiteSVM::new()
            .with_builtins()
            .with_sysvars()
            .with_lamports(20_000_000_000);
        svm.airdrop(&admin.pubkey(), 10_000_000_000)
            .expect("admin airdrop succeeds in LiteSVM");
        let mut signers = BTreeMap::new();
        signers.insert(admin.pubkey(), admin.insecure_clone());
        Self {
            svm,
            program_id,
            admin,
            signers,
            tx_log: Vec::new(),
            services: Vec::new(),
            rng: RiptideRng::default(),
        }
    }

    pub fn svm(&self) -> &LiteSVM {
        &self.svm
    }

    pub fn svm_mut(&mut self) -> &mut LiteSVM {
        &mut self.svm
    }

    pub fn program_id(&self) -> Pubkey {
        self.program_id
    }

    pub fn set_program_id(&mut self, program_id: Pubkey) {
        self.program_id = program_id;
    }

    pub fn admin_pubkey(&self) -> Pubkey {
        self.admin.pubkey()
    }

    pub fn admin_keypair(&self) -> &Keypair {
        &self.admin
    }

    pub fn rng(&mut self) -> &mut RiptideRng {
        &mut self.rng
    }

    pub fn set_rng_seed(&mut self, seed: [u8; 32]) {
        self.rng = RiptideRng::from_seed(seed);
    }

    pub fn register_keypair(&mut self, keypair: Keypair) -> Pubkey {
        let pubkey = keypair.pubkey();
        self.signers.insert(pubkey, keypair);
        pubkey
    }

    pub fn keypair(&self, pubkey: &Pubkey) -> Option<&Keypair> {
        self.signers.get(pubkey)
    }

    pub fn airdrop(&mut self, pubkey: &Pubkey, lamports: u64) -> Result<()> {
        self.svm
            .airdrop(pubkey, lamports)
            .map(|_| ())
            .map_err(|error| anyhow!("airdrop to {pubkey} failed: {error:?}"))
    }

    pub fn load_program_from_so(&mut self, so_path: impl AsRef<Path>) -> Result<Pubkey> {
        let so_path = so_path.as_ref();
        let keypair_path = so_path.with_file_name(format!(
            "{}-keypair.json",
            so_path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("program")
        ));
        let program_keypair = read_keypair_file(&keypair_path).map_err(|error| {
            anyhow!(
                "read program keypair {} for {}: {error}",
                keypair_path.display(),
                so_path.display()
            )
        })?;
        let program_id = program_keypair.pubkey();
        self.add_program_from_so(program_id, so_path)?;
        self.program_id = program_id;
        Ok(program_id)
    }

    pub fn add_program_from_so(
        &mut self,
        program_id: Pubkey,
        so_path: impl AsRef<Path>,
    ) -> Result<Pubkey> {
        let so_path = so_path.as_ref();
        let program_bytes = std::fs::read(so_path)
            .with_context(|| format!("read program artifact {}", so_path.display()))?;
        self.svm
            .add_program(program_id, &program_bytes)
            .map_err(|error| {
                anyhow!(
                    "load program {} as {program_id}: {error}",
                    so_path.display()
                )
            })?;
        Ok(program_id)
    }

    pub fn process_transaction(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
    ) -> Result<TxOutcome> {
        self.process_transaction_expect_success(ixs, label)
    }

    pub fn process_transaction_expect_success(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
    ) -> Result<TxOutcome> {
        let outcome = self.process_transaction_outcome(ixs, label)?;
        if outcome.ok {
            Ok(outcome)
        } else {
            Err(anyhow!(
                "transaction `{}` failed: {}",
                label.unwrap_or("unlabelled"),
                outcome.error.as_deref().unwrap_or("unknown error")
            ))
        }
    }

    pub fn process_transaction_expect_error(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
    ) -> Result<TxOutcome> {
        let outcome = self.process_transaction_outcome(ixs, label)?;
        if outcome.ok {
            Err(anyhow!(
                "transaction `{}` succeeded, but the simulation expected an error",
                label.unwrap_or("unlabelled")
            ))
        } else {
            Ok(outcome)
        }
    }

    pub fn process_transaction_outcome(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
    ) -> Result<TxOutcome> {
        let blockhash = self.svm.latest_blockhash();
        let mut signer_pubkeys = vec![self.admin.pubkey()];
        for ix in ixs {
            for account in &ix.accounts {
                if account.is_signer
                    && self.signers.contains_key(&account.pubkey)
                    && !signer_pubkeys.contains(&account.pubkey)
                {
                    signer_pubkeys.push(account.pubkey);
                }
            }
        }
        let signers = signer_pubkeys
            .iter()
            .map(|pubkey| {
                self.signers.get(pubkey).ok_or_else(|| {
                    anyhow!(
                        "transaction requires signer {pubkey}, but World has no registered keypair"
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&self.admin.pubkey()),
            &signers,
            blockhash,
        );
        let outcome = match self.svm.send_transaction(tx) {
            Ok(meta) => TxOutcome {
                label: label.map(str::to_owned),
                ok: true,
                signature: meta.signature.to_string(),
                error: None,
                logs: meta.logs,
                compute_units_consumed: meta.compute_units_consumed,
            },
            Err(failed) => TxOutcome {
                label: label.map(str::to_owned),
                ok: false,
                signature: failed.meta.signature.to_string(),
                error: Some(format!("{:?}", failed.err)),
                logs: failed.meta.logs,
                compute_units_consumed: failed.meta.compute_units_consumed,
            },
        };
        self.tx_log.push(outcome.clone());
        Ok(outcome)
    }

    pub fn tx_log(&self) -> &[TxOutcome] {
        &self.tx_log
    }

    pub fn clear_tx_log(&mut self) {
        self.tx_log.clear();
    }

    pub fn get_account(&self, pubkey: &Pubkey) -> Option<Account> {
        self.svm.get_account(pubkey)
    }

    pub fn set_account(&mut self, pubkey: Pubkey, account: Account) -> Result<()> {
        self.svm
            .set_account(pubkey, account)
            .map_err(|error| anyhow!("set account {pubkey}: {error}"))
    }

    pub fn load_account_from_json_file(
        &mut self,
        pubkey: Pubkey,
        path: impl AsRef<Path>,
    ) -> Result<Pubkey> {
        let account = crate::bootstrap::read_account_snapshot_for_pubkey(&path, &pubkey)?;
        self.set_account(pubkey, account)?;
        Ok(pubkey)
    }

    pub fn fork_account_to_json_cache(
        &mut self,
        pubkey: Pubkey,
        cluster: &str,
        cache_path: impl AsRef<Path>,
        overwrite: bool,
    ) -> Result<Pubkey> {
        let account =
            crate::bootstrap::load_or_fetch_account(&pubkey, cluster, cache_path, overwrite)?;
        self.set_account(pubkey, account)?;
        Ok(pubkey)
    }

    pub fn apply_manifest(&mut self, manifest_path: impl AsRef<Path>) -> Result<BootstrapReport> {
        crate::bootstrap::apply_manifest(self, manifest_path)
    }

    pub fn apply_manifest_if_exists(
        &mut self,
        manifest_path: impl AsRef<Path>,
    ) -> Result<Option<BootstrapReport>> {
        crate::bootstrap::apply_manifest_if_exists(self, manifest_path)
    }

    pub fn get_account_with_borsh<T: BorshDeserialize>(&self, pubkey: &Pubkey) -> Result<T> {
        let account = self
            .get_account(pubkey)
            .ok_or_else(|| anyhow!("account {pubkey} is missing"))?;
        T::try_from_slice(&account.data).map_err(Into::into)
    }

    pub fn warp_to_slot(&mut self, slot: u64) {
        self.svm.warp_to_slot(slot);
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.slot = slot;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    pub fn warp_to_timestamp(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    pub fn advance_slots(&mut self, slots: u64) {
        let current = self.svm.get_sysvar::<Clock>().slot;
        self.warp_to_slot(current.saturating_add(slots));
    }

    pub fn spl_mint(
        &mut self,
        pubkey: Pubkey,
        mint_authority: Pubkey,
        supply: u64,
        decimals: u8,
    ) -> Result<Pubkey> {
        self.set_account(
            pubkey,
            Account {
                lamports: self.svm.minimum_balance_for_rent_exemption(82),
                data: spl_mint_data(mint_authority, supply, decimals),
                owner: token_program_id(),
                ..Default::default()
            },
        )?;
        Ok(pubkey)
    }

    pub fn spl_token_2022_mint(
        &mut self,
        pubkey: Pubkey,
        mint_authority: Pubkey,
        supply: u64,
        decimals: u8,
    ) -> Result<Pubkey> {
        self.set_account(
            pubkey,
            Account {
                lamports: self.svm.minimum_balance_for_rent_exemption(82),
                data: spl_token_2022_mint_data(mint_authority, supply, decimals),
                owner: token_2022_program_id(),
                ..Default::default()
            },
        )?;
        Ok(pubkey)
    }

    pub fn spl_token_account(
        &mut self,
        pubkey: Pubkey,
        mint: Pubkey,
        authority: Pubkey,
        amount: u64,
    ) -> Result<Pubkey> {
        self.set_account(
            pubkey,
            Account {
                lamports: self.svm.minimum_balance_for_rent_exemption(165),
                data: spl_token_account_data(mint, authority, amount),
                owner: token_program_id(),
                ..Default::default()
            },
        )?;
        Ok(pubkey)
    }

    pub fn add_service(&mut self, service: impl Service + 'static) {
        self.services.push(Box::new(service));
    }

    pub fn tick_services(&mut self) {
        let mut services = std::mem::take(&mut self.services);
        for service in &mut services {
            service.tick(self);
        }
        self.services = services;
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new(Pubkey::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_system_interface::instruction::transfer;

    #[test]
    fn process_transaction_records_success() {
        let mut world = World::default();
        let recipient = Pubkey::new_unique();
        world.airdrop(&recipient, 1_000_000_000).unwrap();
        let ix = transfer(&world.admin_pubkey(), &recipient, 1);

        let outcome = world.process_transaction(&[ix], Some("transfer")).unwrap();

        assert!(outcome.ok);
        assert_eq!(world.tx_log()[0].label.as_deref(), Some("transfer"));
    }

    #[test]
    fn process_transaction_expect_error_records_program_failure() {
        let mut world = World::default();
        let recipient = Pubkey::new_unique();
        let ix = transfer(&world.admin_pubkey(), &recipient, u64::MAX);

        let outcome = world
            .process_transaction_expect_error(&[ix], Some("too_large_transfer"))
            .unwrap();

        assert!(!outcome.ok);
        assert!(outcome.error.is_some());
        assert_eq!(
            world.tx_log()[0].label.as_deref(),
            Some("too_large_transfer")
        );
    }
}
