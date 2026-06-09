// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::{collections::BTreeMap, path::Path};

use anyhow::{anyhow, Context, Result};
use borsh::{to_vec, BorshDeserialize, BorshSerialize};
use litesvm::LiteSVM;
use serde::Serialize;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_clock::Clock;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use solana_transaction::Transaction;

use crate::{
    bootstrap::{BootstrapReport, MetricsConfig, RegressionConfig},
    rng::RiptideRng,
    services::Service,
    spl::{
        spl_mint_data, spl_token_2022_mint_data, spl_token_account_data, token_2022_program_id,
        token_program_id,
    },
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TxOutcome {
    pub label: Option<String>,
    pub ok: bool,
    pub expected_error: bool,
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
    service_tick_count: u64,
    rng: RiptideRng,
    metrics_config: MetricsConfig,
    regression_config: RegressionConfig,
    /// Per-iteration swept-parameter coordinates recorded by the runner (and
    /// readable by flows via `sweep_value`). Surfaced in the guided-sim
    /// artifact so a parameter sweep can be cross-tabulated into a risk
    /// surface. Empty for non-sweep runs (omitted from the artifact).
    iteration_parameters: BTreeMap<String, f64>,
    /// Per-iteration outcome metrics a flow records (e.g. `bad_debt`,
    /// `liquidations`) for the risk-surface cell metrics. Empty by default.
    iteration_metrics: BTreeMap<String, f64>,
    /// Per-iteration error-severity invariant fires a flow records. A
    /// non-empty list marks the iteration as a surface `fail`. Empty by default.
    iteration_invariant_fires: Vec<String>,
}

pub struct WorldTransactionBuilder<'world> {
    world: &'world mut World,
    instructions: Vec<Instruction>,
    label: Option<String>,
    signer_pubkeys: Vec<Pubkey>,
    expectation: TxExpectation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TxExpectation {
    Outcome,
    Success,
    Error,
}

impl World {
    pub fn new(program_id: Pubkey) -> Self {
        let admin = deterministic_admin_keypair();
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
            service_tick_count: 0,
            rng: RiptideRng::default(),
            metrics_config: MetricsConfig::default(),
            regression_config: RegressionConfig::default(),
            iteration_parameters: BTreeMap::new(),
            iteration_metrics: BTreeMap::new(),
            iteration_invariant_fires: Vec::new(),
        }
    }

    /// Record a swept-parameter coordinate for this iteration. The runner calls
    /// this to inject the active sweep value; flows read it back via
    /// `sweep_value`. Recorded into the guided-sim artifact for risk-surface
    /// axis placement. Deterministic: BTreeMap keeps keys sorted.
    pub fn record_parameter(&mut self, name: &str, value: f64) {
        self.iteration_parameters.insert(name.to_owned(), value);
    }

    /// Read back a swept-parameter coordinate the runner injected for this
    /// iteration (e.g. the active `rate_shock_bps`). Returns `None` outside a
    /// sweep or before the runner sets it.
    pub fn sweep_value(&self, name: &str) -> Option<f64> {
        self.iteration_parameters.get(name).copied()
    }

    /// Record an outcome metric for this iteration (e.g. `bad_debt`,
    /// `liquidations`). Surfaced as risk-surface cell metric percentiles.
    pub fn record_metric(&mut self, name: &str, value: f64) {
        self.iteration_metrics.insert(name.to_owned(), value);
    }

    /// Record an error-severity invariant fire for this iteration. A non-empty
    /// set marks the iteration as a risk-surface `fail`. Deduplicated and kept
    /// sorted for deterministic serialization.
    pub fn record_invariant_fire(&mut self, name: &str) {
        if let Err(insert_at) = self.iteration_invariant_fires.binary_search_by(|n| n.as_str().cmp(name)) {
            self.iteration_invariant_fires.insert(insert_at, name.to_owned());
        }
    }

    pub fn iteration_parameters(&self) -> &BTreeMap<String, f64> {
        &self.iteration_parameters
    }

    pub fn iteration_metrics(&self) -> &BTreeMap<String, f64> {
        &self.iteration_metrics
    }

    pub fn iteration_invariant_fires(&self) -> &[String] {
        &self.iteration_invariant_fires
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

    pub fn register_keypair_ref(&mut self, keypair: &Keypair) -> Pubkey {
        self.register_keypair(keypair.insecure_clone())
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

    pub fn load_primary_program_from_so(&mut self, so_path: impl AsRef<Path>) -> Result<Pubkey> {
        self.load_program_from_so(so_path)
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

    pub fn load_dependency_program_from_so(
        &mut self,
        program_id: Pubkey,
        so_path: impl AsRef<Path>,
    ) -> Result<Pubkey> {
        self.add_program_from_so(program_id, so_path)
    }

    pub fn transaction(&mut self) -> WorldTransactionBuilder<'_> {
        WorldTransactionBuilder::new(self)
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
        enforce_expected_success(outcome, label)
    }

    pub fn process_transaction_expect_error(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
    ) -> Result<TxOutcome> {
        let outcome = self.process_transaction_outcome(ixs, label)?;
        self.enforce_expected_error(outcome, label)
    }

    pub fn process_transaction_outcome(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
    ) -> Result<TxOutcome> {
        let signer_pubkeys = self.legacy_transaction_signers(ixs);
        self.send_transaction_with_signers(ixs, label, &signer_pubkeys)
    }

    fn process_transaction_outcome_with_selected_signers(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
        selected_signers: &[Pubkey],
    ) -> Result<TxOutcome> {
        let signer_pubkeys = self.resolve_transaction_signers(ixs, label, selected_signers)?;
        self.send_transaction_with_signers(ixs, label, &signer_pubkeys)
    }

    fn send_transaction_with_signers(
        &mut self,
        ixs: &[Instruction],
        label: Option<&str>,
        signer_pubkeys: &[Pubkey],
    ) -> Result<TxOutcome> {
        let blockhash = self.svm.latest_blockhash();
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
                expected_error: false,
                signature: meta.signature.to_string(),
                error: None,
                logs: meta.logs,
                compute_units_consumed: meta.compute_units_consumed,
            },
            Err(failed) => TxOutcome {
                label: label.map(str::to_owned),
                ok: false,
                expected_error: false,
                signature: failed.meta.signature.to_string(),
                error: Some(format!("{:?}", failed.err)),
                logs: failed.meta.logs,
                compute_units_consumed: failed.meta.compute_units_consumed,
            },
        };
        self.tx_log.push(outcome.clone());
        Ok(outcome)
    }

    fn legacy_transaction_signers(&self, ixs: &[Instruction]) -> Vec<Pubkey> {
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
        signer_pubkeys
    }

    fn resolve_transaction_signers(
        &self,
        ixs: &[Instruction],
        label: Option<&str>,
        selected_signers: &[Pubkey],
    ) -> Result<Vec<Pubkey>> {
        let label = label.unwrap_or("unlabelled");
        let admin = self.admin.pubkey();
        let required_signers = required_instruction_signers(ixs);
        let mut signer_pubkeys = vec![admin];

        for pubkey in selected_signers {
            if !self.signers.contains_key(pubkey) {
                anyhow::bail!(
                    "transaction `{label}` requested signer {pubkey}, but World has no registered keypair"
                );
            }
            if *pubkey != admin && !required_signers.contains(pubkey) {
                anyhow::bail!(
                    "transaction `{label}` requested signer {pubkey}, but no instruction requires that signer"
                );
            }
            push_unique_pubkey(&mut signer_pubkeys, *pubkey);
        }

        for pubkey in required_signers {
            if pubkey == admin {
                continue;
            }
            if !self.signers.contains_key(&pubkey) {
                anyhow::bail!(
                    "transaction `{label}` requires signer {pubkey}, but World has no registered keypair"
                );
            }
            push_unique_pubkey(&mut signer_pubkeys, pubkey);
        }

        Ok(signer_pubkeys)
    }

    fn enforce_expected_error(
        &mut self,
        mut outcome: TxOutcome,
        label: Option<&str>,
    ) -> Result<TxOutcome> {
        if outcome.ok {
            Err(anyhow!(
                "transaction `{}` succeeded, but the simulation expected an error",
                label.unwrap_or("unlabelled")
            ))
        } else {
            outcome.expected_error = true;
            if let Some(last) = self.tx_log.last_mut() {
                if last.signature == outcome.signature {
                    last.expected_error = true;
                }
            }
            Ok(outcome)
        }
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

    pub fn mutate_account(
        &mut self,
        pubkey: &Pubkey,
        mutate: impl FnOnce(&mut Account),
    ) -> Result<()> {
        let mut account = self
            .get_account(pubkey)
            .ok_or_else(|| anyhow!("account {pubkey} is missing"))?;
        mutate(&mut account);
        self.set_account(*pubkey, account)
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

    pub fn set_account_data_with_borsh<T: BorshSerialize>(
        &mut self,
        pubkey: &Pubkey,
        value: &T,
    ) -> Result<()> {
        let data = to_vec(value)?;
        self.mutate_account(pubkey, |account| {
            account.data = data;
        })
    }

    pub fn set_account_with_borsh<T: BorshSerialize>(
        &mut self,
        pubkey: Pubkey,
        owner: Pubkey,
        lamports: u64,
        value: &T,
    ) -> Result<Pubkey> {
        self.set_account(
            pubkey,
            Account {
                lamports,
                data: to_vec(value)?,
                owner,
                ..Default::default()
            },
        )?;
        Ok(pubkey)
    }

    pub fn get_sysvar<T>(&self) -> T
    where
        T: solana_sysvar::Sysvar + solana_sysvar_id::SysvarId + serde::de::DeserializeOwned,
    {
        self.svm.get_sysvar::<T>()
    }

    pub fn set_sysvar<T>(&mut self, sysvar: &T)
    where
        T: solana_sysvar::Sysvar + solana_sysvar_id::SysvarId + solana_sysvar::SysvarSerialize,
    {
        self.svm.set_sysvar(sysvar);
        self.svm.expire_blockhash();
    }

    pub fn clock(&self) -> Clock {
        self.get_sysvar::<Clock>()
    }

    pub fn set_clock(&mut self, clock: Clock) {
        self.set_sysvar(&clock);
    }

    pub fn warp_to_slot(&mut self, slot: u64) {
        self.svm.warp_to_slot(slot);
        let mut clock = self.clock();
        clock.slot = slot;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    pub fn warp_to_epoch(&mut self, epoch: u64) {
        let mut clock = self.clock();
        clock.epoch = epoch;
        self.set_clock(clock);
    }

    pub fn warp_to_timestamp(&mut self, unix_timestamp: i64) {
        let mut clock = self.clock();
        clock.unix_timestamp = unix_timestamp;
        self.set_clock(clock);
    }

    pub fn advance_slots(&mut self, slots: u64) {
        let current = self.clock().slot;
        self.warp_to_slot(current.saturating_add(slots));
    }

    pub fn advance_time(&mut self, seconds: i64) {
        let current = self.clock().unix_timestamp;
        self.warp_to_timestamp(current.saturating_add(seconds));
    }

    pub fn advance_clock(&mut self, slots: u64, seconds: i64) {
        let mut clock = self.clock();
        clock.slot = clock.slot.saturating_add(slots);
        clock.unix_timestamp = clock.unix_timestamp.saturating_add(seconds);
        self.svm.warp_to_slot(clock.slot);
        self.set_clock(clock);
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
            self.service_tick_count = self.service_tick_count.saturating_add(1);
        }
        self.services = services;
    }

    pub fn service_tick_count(&self) -> u64 {
        self.service_tick_count
    }

    pub fn configure_guided_artifacts(
        &mut self,
        metrics: MetricsConfig,
        regression: RegressionConfig,
    ) {
        self.metrics_config = metrics;
        self.regression_config = regression;
    }

    pub fn metrics_config(&self) -> &MetricsConfig {
        &self.metrics_config
    }

    pub fn regression_config(&self) -> &RegressionConfig {
        &self.regression_config
    }

    pub fn account_state_hash(&self, pubkey: &Pubkey) -> Result<String> {
        let account = self
            .get_account(pubkey)
            .ok_or_else(|| anyhow!("account {pubkey} is missing for regression hashing"))?;
        Ok(account_state_hash(pubkey, &account))
    }
}

impl<'world> WorldTransactionBuilder<'world> {
    fn new(world: &'world mut World) -> Self {
        Self {
            world,
            instructions: Vec::new(),
            label: None,
            signer_pubkeys: Vec::new(),
            expectation: TxExpectation::Success,
        }
    }

    pub fn instruction(mut self, instruction: Instruction) -> Self {
        self.instructions.push(instruction);
        self
    }

    pub fn instructions(mut self, instructions: impl IntoIterator<Item = Instruction>) -> Self {
        self.instructions.extend(instructions);
        self
    }

    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn signer(mut self, pubkey: Pubkey) -> Self {
        push_unique_pubkey(&mut self.signer_pubkeys, pubkey);
        self
    }

    pub fn signers(mut self, pubkeys: impl IntoIterator<Item = Pubkey>) -> Self {
        for pubkey in pubkeys {
            push_unique_pubkey(&mut self.signer_pubkeys, pubkey);
        }
        self
    }

    pub fn expect_success(mut self) -> Self {
        self.expectation = TxExpectation::Success;
        self
    }

    pub fn expect_error(mut self) -> Self {
        self.expectation = TxExpectation::Error;
        self
    }

    pub fn record_outcome(mut self) -> Self {
        self.expectation = TxExpectation::Outcome;
        self
    }

    pub fn send(self) -> Result<TxOutcome> {
        let Self {
            world,
            instructions,
            label,
            signer_pubkeys,
            expectation,
        } = self;
        let outcome = world.process_transaction_outcome_with_selected_signers(
            &instructions,
            label.as_deref(),
            &signer_pubkeys,
        )?;
        match expectation {
            TxExpectation::Outcome => Ok(outcome),
            TxExpectation::Success => enforce_expected_success(outcome, label.as_deref()),
            TxExpectation::Error => world.enforce_expected_error(outcome, label.as_deref()),
        }
    }
}

fn enforce_expected_success(outcome: TxOutcome, label: Option<&str>) -> Result<TxOutcome> {
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

fn required_instruction_signers(ixs: &[Instruction]) -> Vec<Pubkey> {
    let mut required = Vec::new();
    for ix in ixs {
        for account in &ix.accounts {
            if account.is_signer {
                push_unique_pubkey(&mut required, account.pubkey);
            }
        }
    }
    required
}

fn push_unique_pubkey(pubkeys: &mut Vec<Pubkey>, pubkey: Pubkey) {
    if !pubkeys.contains(&pubkey) {
        pubkeys.push(pubkey);
    }
}

fn account_state_hash(pubkey: &Pubkey, account: &Account) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pubkey.as_ref());
    hasher.update(account.lamports.to_le_bytes());
    hasher.update(account.owner.as_ref());
    hasher.update([u8::from(account.executable)]);
    hasher.update(account.rent_epoch.to_le_bytes());
    hasher.update(&account.data);
    format!("{:x}", hasher.finalize())
}

fn deterministic_admin_keypair() -> Keypair {
    Keypair::new_from_array([0xAD; 32])
}

impl Default for World {
    fn default() -> Self {
        Self::new(Pubkey::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::{BorshDeserialize, BorshSerialize};
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
    fn process_transaction_signatures_are_stable_across_worlds() {
        let recipient = Pubkey::new_from_array([9; 32]);
        let mut left = World::default();
        let mut right = World::default();
        left.airdrop(&recipient, 1_000_000_000).unwrap();
        right.airdrop(&recipient, 1_000_000_000).unwrap();

        assert_eq!(left.admin_pubkey(), right.admin_pubkey());

        let left_ix = transfer(&left.admin_pubkey(), &recipient, 1);
        let right_ix = transfer(&right.admin_pubkey(), &recipient, 1);
        let left_outcome = left
            .process_transaction(&[left_ix], Some("stable_transfer"))
            .unwrap();
        let right_outcome = right
            .process_transaction(&[right_ix], Some("stable_transfer"))
            .unwrap();

        assert_eq!(left_outcome.signature, right_outcome.signature);
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
        assert!(world.tx_log()[0].expected_error);
    }

    #[test]
    fn process_transaction_outcome_preserves_legacy_missing_signer_panic() {
        let mut world = World::default();
        let missing_authority = Keypair::new_from_array([6; 32]).pubkey();
        let recipient = Pubkey::new_unique();
        world.airdrop(&recipient, 1_000_000_000).unwrap();
        let ix = transfer(&missing_authority, &recipient, 1);

        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            world
                .process_transaction_outcome(&[ix], Some("legacy_missing_signer"))
                .unwrap();
        }));
        std::panic::set_hook(previous_hook);

        assert!(result.is_err());
        assert!(world.tx_log().is_empty());
    }

    #[test]
    fn transaction_builder_runs_instruction_with_label_and_selected_signer() {
        let mut world = World::default();
        let authority = Keypair::new_from_array([3; 32]);
        let authority_pubkey = world.register_keypair(authority);
        let recipient = Pubkey::new_from_array([4; 32]);
        world.airdrop(&authority_pubkey, 1_000_000_000).unwrap();
        world.airdrop(&recipient, 1_000_000_000).unwrap();
        let recipient_before = world.get_account(&recipient).unwrap().lamports;
        let ix = transfer(&authority_pubkey, &recipient, 7);

        let outcome = world
            .transaction()
            .label("builder_transfer")
            .instruction(ix)
            .signer(authority_pubkey)
            .expect_success()
            .send()
            .unwrap();

        assert!(outcome.ok);
        assert_eq!(outcome.label.as_deref(), Some("builder_transfer"));
        assert_eq!(world.tx_log()[0].label.as_deref(), Some("builder_transfer"));
        assert_eq!(
            world.get_account(&recipient).unwrap().lamports,
            recipient_before + 7
        );
    }

    #[test]
    fn transaction_builder_records_expected_error() {
        let mut world = World::default();
        let recipient = Pubkey::new_unique();
        let ix = transfer(&world.admin_pubkey(), &recipient, u64::MAX);

        let outcome = world
            .transaction()
            .label("builder_too_large_transfer")
            .instruction(ix)
            .expect_error()
            .send()
            .unwrap();

        assert!(!outcome.ok);
        assert!(outcome.expected_error);
        assert!(outcome.error.is_some());
        assert_eq!(
            world.tx_log()[0].label.as_deref(),
            Some("builder_too_large_transfer")
        );
        assert!(world.tx_log()[0].expected_error);
    }

    #[test]
    fn transaction_builder_can_return_raw_outcome() {
        let mut world = World::default();
        let recipient = Pubkey::new_unique();
        let ix = transfer(&world.admin_pubkey(), &recipient, u64::MAX);

        let outcome = world
            .transaction()
            .label("builder_raw_outcome")
            .instruction(ix)
            .record_outcome()
            .send()
            .unwrap();

        assert!(!outcome.ok);
        assert!(!outcome.expected_error);
        assert_eq!(
            world.tx_log()[0].label.as_deref(),
            Some("builder_raw_outcome")
        );
        assert!(!world.tx_log()[0].expected_error);
    }

    #[test]
    fn transaction_builder_reports_missing_required_signer() {
        let mut world = World::default();
        let missing_authority = Keypair::new_from_array([5; 32]).pubkey();
        let recipient = Pubkey::new_unique();
        world.airdrop(&recipient, 1_000_000_000).unwrap();
        let ix = transfer(&missing_authority, &recipient, 1);

        let error = world
            .transaction()
            .label("missing_authority")
            .instruction(ix)
            .expect_success()
            .send()
            .unwrap_err()
            .to_string();

        assert!(error.contains("transaction `missing_authority` requires signer"));
        assert!(error.contains("World has no registered keypair"));
        assert!(world.tx_log().is_empty());
    }

    #[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
    struct TinyState {
        value: u64,
    }

    #[test]
    fn borsh_account_helpers_round_trip_and_mutate() {
        let mut world = World::default();
        let address = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        world
            .set_account_with_borsh(address, owner, 10, &TinyState { value: 7 })
            .unwrap();
        assert_eq!(
            world.get_account_with_borsh::<TinyState>(&address).unwrap(),
            TinyState { value: 7 }
        );

        world
            .set_account_data_with_borsh(&address, &TinyState { value: 9 })
            .unwrap();
        world
            .mutate_account(&address, |account| account.lamports += 1)
            .unwrap();

        assert_eq!(
            world.get_account_with_borsh::<TinyState>(&address).unwrap(),
            TinyState { value: 9 }
        );
        assert_eq!(world.get_account(&address).unwrap().lamports, 11);
        assert_eq!(world.get_account(&address).unwrap().owner, owner);
    }

    #[test]
    fn sysvar_time_helpers_are_deterministic() {
        let mut world = World::default();

        world.warp_to_slot(50);
        world.warp_to_epoch(3);
        world.warp_to_timestamp(1_700_000_000);
        world.advance_clock(7, 11);

        let clock = world.clock();
        assert_eq!(clock.slot, 57);
        assert_eq!(clock.epoch, 3);
        assert_eq!(clock.unix_timestamp, 1_700_000_011);
    }
}
