//! Generic primitive helpers.
//!
//! This module owns the non-domain-specific pieces the generic path needs:
//! - minimal IDL/catalog parsing for instruction dispatch,
//! - deterministic observation decoding from account bytes,
//! - adapter persona compilation into runtime `Policy` values.
//!
//! The LiteSVM-backed harness wiring lands on top of these helpers; the
//! helpers themselves are pure and unit-testable.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};

use crate::{
    adapter::{AccountKind, Adapter, InstructionMapping, ObservationType},
    agent::policy::RuntimeAction,
    types::{
        ComparisonOp, ObservationValue, Policy, PositionSizing, PositionSizingStrategy, Trigger,
        TriggerCondition, TriggerValue,
    },
};

#[cfg(any(feature = "litesvm-backend", test))]
use {
    litesvm::LiteSVM,
    solana_account::Account,
    solana_sdk::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        signature::{Keypair, Signer},
    },
    solana_transaction::{Transaction, TransactionError},
    std::path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericIdl {
    pub instructions: Vec<GenericInstruction>,
    #[serde(default)]
    pub accounts: Vec<GenericAccountType>,
    #[serde(default)]
    pub types: Vec<GenericDefinedType>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericInstruction {
    pub name: String,
    pub discriminator: Vec<u8>,
    #[serde(default)]
    pub accounts: Vec<GenericInstructionAccount>,
    #[serde(default)]
    pub args: Vec<GenericArg>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericInstructionAccount {
    pub name: String,
    #[serde(default)]
    pub signer: bool,
    #[serde(default)]
    pub writable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericArg {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: GenericTypeRef,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericAccountType {
    pub name: String,
    pub fields: Vec<GenericField>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericDefinedType {
    pub name: String,
    pub fields: Vec<GenericField>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericField {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: GenericTypeRef,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(untagged)]
pub enum GenericTypeRef {
    Primitive(String),
    Vec { vec: Box<GenericTypeRef> },
    Defined { defined: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GenericValue {
    Int(i64),
    UInt(u64),
    Bool(bool),
    Pubkey(String),
    Struct(BTreeMap<String, GenericValue>),
    Vec(Vec<GenericValue>),
}

pub fn parse_generic_idl_str(raw: &str) -> Result<GenericIdl> {
    serde_json::from_str(raw).context("parse generic IDL JSON")
}

pub fn load_generic_idl(path: &std::path::Path) -> Result<GenericIdl> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("read generic IDL {}", path.display()))?;
    parse_generic_idl_str(&raw)
}

pub fn generic_runtime_actions(adapter: &Adapter) -> Vec<RuntimeAction> {
    adapter
        .actions
        .keys()
        .map(|name| RuntimeAction::Custom(name.clone()))
        .collect()
}

pub fn build_generic_policies<F>(adapter: &Adapter, mut log: F) -> Result<Vec<Policy>>
where
    F: FnMut(String),
{
    let mut policies = Vec::with_capacity(adapter.personas.len());

    for (persona_id, persona) in &adapter.personas {
        let mut action_weights = BTreeMap::new();
        for action_name in adapter.actions.keys() {
            let weight = persona.action_weights.get(action_name).copied().unwrap_or_else(|| {
                log(format!(
                    "generic persona `{persona_id}` missing action weight for `{action_name}`; defaulting to 0"
                ));
                0.0
            });
            action_weights.insert(action_name.clone(), weight);
        }

        let mut triggers = Vec::with_capacity(persona.triggers.len());
        for trigger in &persona.triggers {
            triggers.push(parse_generic_trigger(trigger)?);
        }

        policies.push(Policy {
            persona_id: persona_id.clone(),
            persona_label: persona
                .label
                .clone()
                .unwrap_or_else(|| persona_id.replace('-', " ")),
            action_rate_multiplier: persona.action_rate_multiplier,
            risk_tolerance: 0.5,
            action_weights,
            triggers,
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".into(), 1.0)]),
            },
            max_exposure: 1.0,
        });
    }

    Ok(policies)
}

pub fn observe_account_state(
    idl: &GenericIdl,
    adapter: &Adapter,
    account_name: &str,
    bytes: &[u8],
) -> Result<BTreeMap<String, ObservationValue>> {
    let account_type = idl
        .accounts
        .iter()
        .find(|candidate| candidate.name == account_name)
        .ok_or_else(|| anyhow!("generic IDL missing account type `{account_name}`"))?;
    let mut cursor = ByteCursor::new(bytes);
    let value = decode_struct(idl, &account_type.fields, &mut cursor)
        .with_context(|| format!("decode account `{account_name}`"))?;

    let mut observations = BTreeMap::new();
    for (mapping_key, logical_name) in &adapter.state_mapping {
        let Some((mapped_account, field_path)) = mapping_key.split_once('.') else {
            continue;
        };
        if mapped_account != account_name {
            continue;
        }
        let extracted = value
            .get_path(field_path)
            .ok_or_else(|| anyhow!("field path `{field_path}` missing in account `{account_name}`"))?;
        let expected = adapter
            .observations
            .get(logical_name)
            .ok_or_else(|| anyhow!("generic observation `{logical_name}` missing from adapter"))?
            .kind();
        observations.insert(logical_name.clone(), extracted.to_observation(expected)?);
    }

    Ok(observations)
}

pub struct GenericInstructionBuilder<'a> {
    idl: &'a GenericIdl,
    adapter: &'a Adapter,
}

impl<'a> GenericInstructionBuilder<'a> {
    pub fn new(idl: &'a GenericIdl, adapter: &'a Adapter) -> Self {
        Self { idl, adapter }
    }

    pub fn build_action_data(&self, action_name: &str, amount: u64) -> Result<Vec<u8>> {
        let (instruction_name, mapping, instruction) =
            resolve_instruction_for_action(self.idl, self.adapter, action_name)?;

        let action = self
            .adapter
            .actions
            .get(action_name)
            .ok_or_else(|| anyhow!("generic adapter missing action `{action_name}`"))?;
        if action.takes.len() > 1 {
            bail!("generic adapter actions support at most one arg");
        }

        let mut encoded = instruction.discriminator.clone();
        for arg in &instruction.args {
            match mapping.amount.as_deref() {
                Some(bound_name) if bound_name == arg.name => {
                    encode_numeric_arg(&mut encoded, &arg.ty, amount)?;
                }
                _ => bail!(
                    "generic instruction `{instruction_name}` arg `{}` is not bound in the adapter",
                    arg.name
                ),
            }
        }

        Ok(encoded)
    }
}

fn resolve_instruction_for_action<'a>(
    idl: &'a GenericIdl,
    adapter: &'a Adapter,
    action_name: &str,
) -> Result<(&'a str, &'a InstructionMapping, &'a GenericInstruction)> {
    let (instruction_name, mapping) = adapter
        .instructions
        .iter()
        .find(|(_, mapping)| mapping.action == action_name)
        .ok_or_else(|| anyhow!("generic adapter missing instruction for action `{action_name}`"))?;
    let instruction = idl
        .instructions
        .iter()
        .find(|instruction| instruction.name == *instruction_name)
        .ok_or_else(|| anyhow!("generic IDL missing instruction `{instruction_name}`"))?;
    Ok((instruction_name.as_str(), mapping, instruction))
}

fn parse_generic_trigger(
    trigger: &crate::adapter::PersonaTriggerDefinition,
) -> Result<Trigger> {
    let parts: Vec<_> = trigger.condition.split_whitespace().collect();
    if parts.len() != 3 {
        bail!(
            "generic trigger `{}` must be `<observation> <op> <constant>`",
            trigger.condition
        );
    }

    let op = match parts[1] {
        "<" => ComparisonOp::Lt,
        ">" => ComparisonOp::Gt,
        "==" => ComparisonOp::Eq,
        other => bail!("unsupported generic trigger operator `{other}`"),
    };

    Ok(Trigger {
        condition: TriggerCondition::ObservationCompare {
            key: parts[0].to_string(),
            op,
            value: parse_trigger_value(parts[2]),
        },
        response: trigger.action.clone(),
        severity: 0,
        cooldown_ticks: 0,
        weight_boost: Some(trigger.weight_boost),
    })
}

fn parse_trigger_value(raw: &str) -> TriggerValue {
    if raw.eq_ignore_ascii_case("true") {
        return TriggerValue::Bool(true);
    }
    if raw.eq_ignore_ascii_case("false") {
        return TriggerValue::Bool(false);
    }
    if let Ok(value) = raw.parse::<i64>() {
        return TriggerValue::Int(value);
    }
    TriggerValue::String(raw.trim_matches('"').to_string())
}

fn encode_numeric_arg(out: &mut Vec<u8>, ty: &GenericTypeRef, amount: u64) -> Result<()> {
    match ty {
        GenericTypeRef::Primitive(name) if name == "u64" => {
            out.extend_from_slice(&amount.to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "i64" => {
            out.extend_from_slice(&(amount as i64).to_le_bytes());
            Ok(())
        }
        other => bail!("unsupported generic action arg type `{other:?}`"),
    }
}

fn decode_struct(idl: &GenericIdl, fields: &[GenericField], cursor: &mut ByteCursor<'_>) -> Result<GenericValue> {
    let mut values = BTreeMap::new();
    for field in fields {
        values.insert(field.name.clone(), decode_value(idl, &field.ty, cursor)?);
    }
    Ok(GenericValue::Struct(values))
}

fn decode_value(idl: &GenericIdl, ty: &GenericTypeRef, cursor: &mut ByteCursor<'_>) -> Result<GenericValue> {
    match ty {
        GenericTypeRef::Primitive(name) if name == "u64" => Ok(GenericValue::UInt(cursor.read_u64()?)),
        GenericTypeRef::Primitive(name) if name == "i64" => Ok(GenericValue::Int(cursor.read_i64()?)),
        GenericTypeRef::Primitive(name) if name == "bool" => Ok(GenericValue::Bool(cursor.read_bool()?)),
        GenericTypeRef::Primitive(name) if name == "pubkey" => Ok(GenericValue::Pubkey(cursor.read_pubkey()?)),
        GenericTypeRef::Vec { vec } => {
            let len = cursor.read_u32()? as usize;
            let mut items = Vec::with_capacity(len);
            for _ in 0..len {
                items.push(decode_value(idl, vec, cursor)?);
            }
            Ok(GenericValue::Vec(items))
        }
        GenericTypeRef::Defined { defined } => {
            let defined_type = idl
                .types
                .iter()
                .find(|candidate| candidate.name == *defined)
                .ok_or_else(|| anyhow!("generic IDL missing defined type `{defined}`"))?;
            decode_struct(idl, &defined_type.fields, cursor)
        }
        other => bail!("unsupported generic field type `{other:?}`"),
    }
}

impl GenericValue {
    fn get_path(&self, path: &str) -> Option<&GenericValue> {
        let mut current = self;
        for segment in path.split('.') {
            current = match current {
                GenericValue::Struct(fields) => fields.get(segment)?,
                _ => return None,
            };
        }
        Some(current)
    }

    fn to_observation(&self, expected: ObservationType) -> Result<ObservationValue> {
        match (self, expected) {
            (GenericValue::Int(value), ObservationType::Int) => Ok(ObservationValue::Int(*value)),
            (GenericValue::UInt(value), ObservationType::UInt) => Ok(ObservationValue::UInt(*value)),
            (GenericValue::Bool(value), ObservationType::Bool) => Ok(ObservationValue::Bool(*value)),
            (GenericValue::Pubkey(value), ObservationType::Pubkey) => {
                Ok(ObservationValue::Pubkey(value.clone()))
            }
            (GenericValue::Vec(values), ObservationType::Map) => vec_to_map(values),
            _ => bail!("generic observation type mismatch; expected `{expected:?}`, got `{self:?}`"),
        }
    }
}

fn vec_to_map(values: &[GenericValue]) -> Result<ObservationValue> {
    let mut mapped = BTreeMap::new();
    for value in values {
        let GenericValue::Struct(fields) = value else {
            bail!("generic map observations require a vec of structs");
        };
        let key = fields
            .values()
            .find_map(|value| match value {
                GenericValue::Pubkey(pubkey) => Some(pubkey.clone()),
                _ => None,
            })
            .ok_or_else(|| anyhow!("generic map observation entry missing pubkey key"))?;
        let amount = fields
            .values()
            .find_map(|value| match value {
                GenericValue::Int(number) => Some(*number),
                GenericValue::UInt(number) => Some(*number as i64),
                _ => None,
            })
            .ok_or_else(|| anyhow!("generic map observation entry missing integer value"))?;
        mapped.insert(key, amount);
    }
    Ok(ObservationValue::Map(mapped))
}

struct ByteCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ByteCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_exact<const N: usize>(&mut self) -> Result<[u8; N]> {
        if self.offset + N > self.bytes.len() {
            bail!("unexpected end of account data");
        }
        let mut chunk = [0u8; N];
        chunk.copy_from_slice(&self.bytes[self.offset..self.offset + N]);
        self.offset += N;
        Ok(chunk)
    }

    fn read_u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.read_exact()?))
    }

    fn read_u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.read_exact()?))
    }

    fn read_i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.read_exact()?))
    }

    fn read_bool(&mut self) -> Result<bool> {
        Ok(self.read_exact::<1>()?[0] != 0)
    }

    fn read_pubkey(&mut self) -> Result<String> {
        Ok(bs58::encode(self.read_exact::<32>()?).into_string())
    }
}

#[cfg(any(feature = "litesvm-backend", test))]
pub struct GenericBootstrapConfig {
    pub program_so: PathBuf,
    pub idl_path: PathBuf,
    pub agent_count: usize,
    pub adapter: Adapter,
}

#[cfg(any(feature = "litesvm-backend", test))]
pub struct GenericHarness {
    pub(crate) svm: LiteSVM,
    pub program_id: Pubkey,
    pub admin: Keypair,
    pub agents: Vec<Keypair>,
    adapter: Adapter,
    idl: GenericIdl,
    agent_accounts: BTreeMap<String, Vec<Pubkey>>,
    shared_accounts: BTreeMap<String, Pubkey>,
    current_slot: u64,
}

#[cfg(any(feature = "litesvm-backend", test))]
impl GenericHarness {
    pub fn bootstrap(config: GenericBootstrapConfig) -> Result<Self> {
        let program_bytes = load_generic_program_bytes(&config.program_so)?;
        let idl = load_generic_idl(&config.idl_path)?;

        let per_identity_lamports: u64 = 10_000_000_000;
        let identity_count = (config.agent_count as u64) + 1;
        let base_lamports = identity_count * per_identity_lamports * 2;
        let mut svm = LiteSVM::new()
            .with_builtins()
            .with_sysvars()
            .with_lamports(base_lamports);

        let program_id = Pubkey::new_unique();
        svm.add_program(program_id, &program_bytes)
            .map_err(|error| anyhow!("failed to load generic program into LiteSVM: {error}"))?;

        let admin = Keypair::new();
        generic_airdrop(&mut svm, &admin.pubkey(), per_identity_lamports)?;

        let agents: Vec<Keypair> = (0..config.agent_count).map(|_| Keypair::new()).collect();
        for agent in &agents {
            generic_airdrop(&mut svm, &agent.pubkey(), per_identity_lamports)?;
        }

        let (agent_accounts, shared_accounts) =
            bootstrap_generic_accounts(&mut svm, &config.adapter, config.agent_count, &program_id)?;

        Ok(Self {
            svm,
            program_id,
            admin,
            agents,
            adapter: config.adapter,
            idl,
            agent_accounts,
            shared_accounts,
            current_slot: 0,
        })
    }

    fn resolve_account_meta(
        &self,
        agent_idx: usize,
        account: &GenericInstructionAccount,
    ) -> Result<AccountMeta> {
        let pubkey = if let Some(pubkeys) = self.agent_accounts.get(&account.name) {
            *pubkeys.get(agent_idx).ok_or_else(|| {
                anyhow!(
                    "generic agent account `{}` missing index {}",
                    account.name,
                    agent_idx
                )
            })?
        } else if let Some(pubkey) = self.shared_accounts.get(&account.name) {
            *pubkey
        } else if account.signer {
            if account.name.eq_ignore_ascii_case("admin") {
                self.admin.pubkey()
            } else {
                self.agents
                    .get(agent_idx)
                    .ok_or_else(|| anyhow!("generic agent signer index {agent_idx} out of range"))?
                    .pubkey()
            }
        } else {
            bail!(
                "generic instruction account `{}` is not declared under `[accounts]` and is not a recognized signer account",
                account.name
            );
        };

        Ok(if account.writable {
            AccountMeta::new(pubkey, account.signer)
        } else {
            AccountMeta::new_readonly(pubkey, account.signer)
        })
    }

    fn payer_for_instruction(
        &self,
        agent_idx: usize,
        instruction: &GenericInstruction,
    ) -> Result<Keypair> {
        if instruction
            .accounts
            .iter()
            .any(|account| account.signer && account.name.eq_ignore_ascii_case("admin"))
        {
            Ok(self.admin.insecure_clone())
        } else {
            Ok(self
                .agents
                .get(agent_idx)
                .ok_or_else(|| anyhow!("generic agent signer index {agent_idx} out of range"))?
                .insecure_clone())
        }
    }

    fn send_instruction(
        &mut self,
        payer: &Keypair,
        instruction: Instruction,
    ) -> Result<(), crate::primitive::PrimitiveError> {
        let blockhash = self.svm.latest_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[payer],
            blockhash,
        );
        match self.svm.send_transaction(tx) {
            Ok(_) => Ok(()),
            Err(error) => match error.err {
                TransactionError::InstructionError(_, _) => Err(
                    crate::primitive::PrimitiveError::ProgramRejected(format!("{:?}", error.err)),
                ),
                other => Err(crate::primitive::PrimitiveError::Infra(format!("{other:?}"))),
            },
        }
    }

    fn account_bytes(&self, pubkey: &Pubkey, account_name: &str) -> Result<Vec<u8>, crate::primitive::PrimitiveError> {
        let account = self
            .svm
            .get_account(pubkey)
            .ok_or_else(|| {
                crate::primitive::PrimitiveError::Infra(format!(
                    "generic account `{account_name}` ({pubkey}) not found"
                ))
            })?;
        Ok(account.data)
    }
}

#[cfg(any(feature = "litesvm-backend", test))]
impl crate::primitive::Primitive for GenericHarness {
    fn agent_count(&self) -> usize {
        self.agents.len()
    }

    fn advance_tick(&mut self) {
        self.current_slot += 1;
        self.svm.warp_to_slot(self.current_slot);
        self.svm.expire_blockhash();
    }

    fn execute_action(
        &mut self,
        agent_idx: usize,
        action: &str,
        amount: u64,
        _target_idx: Option<usize>,
    ) -> Result<(), crate::primitive::PrimitiveError> {
        let (_, _, instruction) = resolve_instruction_for_action(&self.idl, &self.adapter, action)
            .map_err(|error| crate::primitive::PrimitiveError::ProgramRejected(error.to_string()))?;
        let data = GenericInstructionBuilder::new(&self.idl, &self.adapter)
            .build_action_data(action, amount)
            .map_err(|error| crate::primitive::PrimitiveError::ProgramRejected(error.to_string()))?;
        let accounts = instruction
            .accounts
            .iter()
            .map(|account| self.resolve_account_meta(agent_idx, account))
            .collect::<Result<Vec<_>>>()
            .map_err(|error| crate::primitive::PrimitiveError::Infra(error.to_string()))?;
        let payer = self
            .payer_for_instruction(agent_idx, instruction)
            .map_err(|error| crate::primitive::PrimitiveError::Infra(error.to_string()))?;
        self.send_instruction(
            &payer,
            Instruction {
                program_id: self.program_id,
                accounts,
                data,
            },
        )
    }

    fn observation_values(
        &self,
        agent_idx: usize,
    ) -> Result<BTreeMap<String, ObservationValue>, crate::primitive::PrimitiveError> {
        let mut observed = BTreeMap::new();

        for (account_name, pubkeys) in &self.agent_accounts {
            let pubkey = pubkeys.get(agent_idx).ok_or_else(|| {
                crate::primitive::PrimitiveError::Infra(format!(
                    "generic agent account `{account_name}` missing index {agent_idx}"
                ))
            })?;
            let bytes = self.account_bytes(pubkey, account_name)?;
            let values = observe_account_state(&self.idl, &self.adapter, account_name, &bytes)
                .map_err(|error| crate::primitive::PrimitiveError::Infra(error.to_string()))?;
            observed.extend(values);
        }

        for (account_name, pubkey) in &self.shared_accounts {
            let bytes = self.account_bytes(pubkey, account_name)?;
            let values = observe_account_state(&self.idl, &self.adapter, account_name, &bytes)
                .map_err(|error| crate::primitive::PrimitiveError::Infra(error.to_string()))?;
            observed.extend(values);
        }

        Ok(observed)
    }

    fn snapshot_metrics(
        &self,
    ) -> Result<BTreeMap<String, serde_json::Value>, crate::primitive::PrimitiveError> {
        // Per-tick aggregate of adapter-declared observations across all
        // agents. For each key declared in `[observations]`, fold the
        // per-agent values into a single representative value so the
        // timeseries entry stays a flat JSON object (one column per key).
        //
        // Aggregation rules (v0):
        // - int/uint → mean across agents, emitted as f64
        // - bool     → count of `true` across agents, as u64
        // - pubkey   → count of distinct pubkeys across agents, as u64
        // - map      → mean entry count across agents, as f64
        let mut per_agent: Vec<BTreeMap<String, ObservationValue>> =
            Vec::with_capacity(self.agents.len());
        for idx in 0..self.agents.len() {
            per_agent.push(
                <Self as crate::primitive::Primitive>::observation_values(self, idx)?,
            );
        }

        let mut metrics = BTreeMap::new();
        for key in self.adapter.observations.keys() {
            let values: Vec<&ObservationValue> =
                per_agent.iter().filter_map(|map| map.get(key)).collect();
            if values.is_empty() {
                continue;
            }
            let cell = aggregate_observation_column(&values);
            metrics.insert(key.clone(), cell);
        }
        Ok(metrics)
    }

    fn summarize_metrics(
        &self,
        timeseries: &[crate::types::TickSnapshot],
    ) -> Result<BTreeMap<String, serde_json::Value>, crate::primitive::PrimitiveError> {
        // For each adapter-declared observation, walk the timeseries
        // column and emit primitive-appropriate stats. Numeric columns
        // produce `<key>_avg/_max/_min` (alphabetical); bool columns
        // produce `_true_count`/`_false_count`; map columns produce
        // `_entry_count_avg`/`_entry_count_max`; pubkey columns produce
        // `_unique_count` (taking the max per-tick unique count as the
        // current approximation).
        let mut summary = BTreeMap::new();
        for (key, definition) in &self.adapter.observations {
            let column: Vec<&serde_json::Value> = timeseries
                .iter()
                .filter_map(|entry| entry.get(key))
                .collect();
            if column.is_empty() {
                continue;
            }
            match definition.kind() {
                crate::adapter::ObservationType::Int
                | crate::adapter::ObservationType::UInt => {
                    let numeric: Vec<f64> =
                        column.iter().filter_map(|v| v.as_f64()).collect();
                    if numeric.is_empty() {
                        continue;
                    }
                    let avg = numeric.iter().sum::<f64>() / (numeric.len() as f64);
                    let min = numeric.iter().copied().fold(f64::INFINITY, f64::min);
                    let max = numeric
                        .iter()
                        .copied()
                        .fold(f64::NEG_INFINITY, f64::max);
                    summary.insert(format!("{key}_avg"), json_f64_gen(avg));
                    summary.insert(format!("{key}_max"), json_f64_gen(max));
                    summary.insert(format!("{key}_min"), json_f64_gen(min));
                }
                crate::adapter::ObservationType::Bool => {
                    let true_count: u64 =
                        column.iter().filter_map(|v| v.as_u64()).sum();
                    // Each tick's column value is the number of agents
                    // with `true`. `false_count` = agents*ticks - trues.
                    let total_cells = (self.agents.len() as u64)
                        .saturating_mul(column.len() as u64);
                    let false_count = total_cells.saturating_sub(true_count);
                    summary
                        .insert(format!("{key}_true_count"), serde_json::json!(true_count));
                    summary
                        .insert(format!("{key}_false_count"), serde_json::json!(false_count));
                }
                crate::adapter::ObservationType::Pubkey => {
                    let max_unique: u64 = column
                        .iter()
                        .filter_map(|v| v.as_u64())
                        .max()
                        .unwrap_or(0);
                    summary.insert(
                        format!("{key}_unique_count"),
                        serde_json::json!(max_unique),
                    );
                }
                crate::adapter::ObservationType::Map => {
                    let numeric: Vec<f64> =
                        column.iter().filter_map(|v| v.as_f64()).collect();
                    if numeric.is_empty() {
                        continue;
                    }
                    let avg = numeric.iter().sum::<f64>() / (numeric.len() as f64);
                    let max = numeric
                        .iter()
                        .copied()
                        .fold(f64::NEG_INFINITY, f64::max);
                    summary.insert(
                        format!("{key}_entry_count_avg"),
                        json_f64_gen(avg),
                    );
                    summary.insert(
                        format!("{key}_entry_count_max"),
                        json_f64_gen(max),
                    );
                }
            }
        }
        Ok(summary)
    }
}

/// Fold a column of per-agent observation values into a single JSON
/// cell for the per-tick timeseries entry. Type dispatch mirrors the
/// v0 aggregation rules spelled out in `snapshot_metrics` above.
#[cfg(any(feature = "litesvm-backend", test))]
fn aggregate_observation_column(values: &[&ObservationValue]) -> serde_json::Value {
    // Peek the first entry to pick the aggregation strategy; adapter
    // validation guarantees the column is homogeneous per tick.
    match values.first() {
        None => serde_json::Value::Null,
        Some(ObservationValue::Int(_)) | Some(ObservationValue::UInt(_)) => {
            let numeric: Vec<f64> = values
                .iter()
                .map(|value| match value {
                    ObservationValue::Int(number) => *number as f64,
                    ObservationValue::UInt(number) => *number as f64,
                    _ => 0.0,
                })
                .collect();
            let mean = numeric.iter().sum::<f64>() / (numeric.len() as f64);
            json_f64_gen(mean)
        }
        Some(ObservationValue::Bool(_)) => {
            let trues: u64 = values
                .iter()
                .filter(|value| matches!(value, ObservationValue::Bool(true)))
                .count() as u64;
            serde_json::json!(trues)
        }
        Some(ObservationValue::Pubkey(_)) => {
            let distinct: std::collections::BTreeSet<&String> = values
                .iter()
                .filter_map(|value| match value {
                    ObservationValue::Pubkey(key) => Some(key),
                    _ => None,
                })
                .collect();
            serde_json::json!(distinct.len() as u64)
        }
        Some(ObservationValue::Map(_)) => {
            let sizes: Vec<f64> = values
                .iter()
                .map(|value| match value {
                    ObservationValue::Map(map) => map.len() as f64,
                    _ => 0.0,
                })
                .collect();
            let mean = sizes.iter().sum::<f64>() / (sizes.len() as f64);
            json_f64_gen(mean)
        }
    }
}

#[cfg(any(feature = "litesvm-backend", test))]
fn json_f64_gen(value: f64) -> serde_json::Value {
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn load_generic_program_bytes(path: &Path) -> Result<Vec<u8>> {
    if !path.exists() {
        bail!(
            "generic program .so not found at {}\nRun the matching `cargo build-sbf` command for this adapter first.",
            path.display()
        );
    }
    std::fs::read(path).with_context(|| format!("read generic program {}", path.display()))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn generic_airdrop(svm: &mut LiteSVM, address: &Pubkey, lamports: u64) -> Result<()> {
    svm.airdrop(address, lamports)
        .map_err(|error| anyhow!("airdrop to {address}: {error:?}"))
        .map(|_| ())
}

#[cfg(any(feature = "litesvm-backend", test))]
fn bootstrap_generic_accounts(
    svm: &mut LiteSVM,
    adapter: &Adapter,
    agent_count: usize,
    program_id: &Pubkey,
) -> Result<(BTreeMap<String, Vec<Pubkey>>, BTreeMap<String, Pubkey>)> {
    let mut agent_accounts = BTreeMap::new();
    let mut shared_accounts = BTreeMap::new();

    for (account_name, definition) in &adapter.accounts {
        let lamports = svm.minimum_balance_for_rent_exemption(definition.space);
        match definition.kind {
            AccountKind::Agent => {
                let mut pubkeys = Vec::with_capacity(agent_count);
                for _ in 0..agent_count {
                    let pubkey = Pubkey::new_unique();
                    svm.set_account(
                        pubkey,
                        Account {
                            lamports,
                            data: vec![0u8; definition.space],
                            owner: *program_id,
                            ..Default::default()
                        },
                    )
                    .map_err(|error| {
                        anyhow!(
                            "create generic agent account `{account_name}` for {pubkey}: {error}"
                        )
                    })?;
                    pubkeys.push(pubkey);
                }
                agent_accounts.insert(account_name.clone(), pubkeys);
            }
            AccountKind::Shared => {
                let pubkey = Pubkey::new_unique();
                svm.set_account(
                    pubkey,
                    Account {
                        lamports,
                        data: vec![0u8; definition.space],
                        owner: *program_id,
                        ..Default::default()
                    },
                )
                .map_err(|error| {
                    anyhow!("create generic shared account `{account_name}` for {pubkey}: {error}")
                })?;
                shared_accounts.insert(account_name.clone(), pubkey);
            }
        }
    }

    Ok((agent_accounts, shared_accounts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adapter::loader::parse_adapter_str,
        agent::{policy::score_actions, runtime::AgentObservation, state::Agent},
    };
    use rand::SeedableRng;

    const SYNTHETIC_IDL: &str = r#"
{
  "instructions": [
    {
      "name": "mine",
      "discriminator": [109, 105, 110, 101, 0, 0, 0, 0],
      "accounts": [
        { "name": "authority", "signer": true, "writable": true },
        { "name": "player", "writable": true }
      ],
      "args": [
        { "name": "amount", "type": "u64" }
      ]
    }
  ],
  "accounts": [
    {
      "name": "player",
      "fields": [
        { "name": "gold", "type": "u64" },
        { "name": "wood", "type": "u64" },
        { "name": "listed", "type": "bool" }
      ]
    },
    {
      "name": "marketplace",
      "fields": [
        { "name": "listings", "type": { "vec": { "defined": "listing" } } }
      ]
    }
  ],
  "types": [
    {
      "name": "listing",
      "fields": [
        { "name": "seller", "type": "pubkey" },
        { "name": "amount", "type": "i64" }
      ]
    }
  ]
}
"#;

    fn sample_generic_adapter() -> Adapter {
        parse_adapter_str(
            r#"
protocol = "generic"
program_so = "programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "fixtures/idls/resource-grinder.json"

[accounts.player]
kind = "agent"
space = 32

[accounts.marketplace]
kind = "shared"
space = 512

[instructions]
mine = { action = "mine", amount = "amount" }

[state_mapping]
"player.gold" = "player.gold"
"player.wood" = "player.wood"
"player.listed" = "player.listed"
"marketplace.listings" = "marketplace.listings"

[actions.mine]
takes = ["amount"]

[actions.craft]
takes = []

[observations]
"player.gold" = "uint"
"player.wood" = "uint"
"player.listed" = "bool"
"marketplace.listings" = "map"

[personas.grinder]
action_rate_multiplier = 1.5
action_weights = { mine = 1.0 }
triggers = [{ if = "player.wood < 10", then = "mine", weight_boost = 2.0 }]
"#,
            "generic.toml",
        )
        .unwrap()
    }

    #[test]
    fn action_dispatch_builds_instruction_data_from_synthetic_idl() {
        let idl = parse_generic_idl_str(SYNTHETIC_IDL).unwrap();
        let adapter = sample_generic_adapter();
        let builder = GenericInstructionBuilder::new(&idl, &adapter);

        let bytes = builder.build_action_data("mine", 7).unwrap();
        assert_eq!(&bytes[..8], &[109, 105, 110, 101, 0, 0, 0, 0]);
        assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 7);
    }

    #[test]
    fn observation_read_decodes_scalar_and_map_values() {
        let idl = parse_generic_idl_str(SYNTHETIC_IDL).unwrap();
        let adapter = sample_generic_adapter();

        let mut player_bytes = Vec::new();
        player_bytes.extend_from_slice(&5u64.to_le_bytes());
        player_bytes.extend_from_slice(&9u64.to_le_bytes());
        player_bytes.push(1);
        let observed = observe_account_state(&idl, &adapter, "player", &player_bytes).unwrap();
        assert_eq!(
            observed.get("player.gold"),
            Some(&ObservationValue::UInt(5))
        );
        assert_eq!(
            observed.get("player.listed"),
            Some(&ObservationValue::Bool(true))
        );

        let seller = [7u8; 32];
        let mut marketplace_bytes = Vec::new();
        marketplace_bytes.extend_from_slice(&1u32.to_le_bytes());
        marketplace_bytes.extend_from_slice(&seller);
        marketplace_bytes.extend_from_slice(&3i64.to_le_bytes());
        let observed =
            observe_account_state(&idl, &adapter, "marketplace", &marketplace_bytes).unwrap();
        assert_eq!(
            observed.get("marketplace.listings"),
            Some(&ObservationValue::Map(BTreeMap::from([(
                bs58::encode(seller).into_string(),
                3
            )])))
        );
    }

    #[test]
    fn generic_persona_trigger_boosts_matching_action_score() {
        let adapter = sample_generic_adapter();
        let policies = build_generic_policies(&adapter, |_| {}).unwrap();
        let policy = policies.iter().find(|policy| policy.persona_id == "grinder").unwrap();
        let mut agent = Agent::new("agent", policy.clone(), 0.0);
        let mut observation = AgentObservation::new(1, 0.0, 0.0, 0.0, 0.0, 0.0);
        observation
            .custom_observations
            .insert("player.wood".into(), ObservationValue::UInt(4));
        let mut runtime = crate::agent::AgentRuntime::new(9);
        let decision = runtime.decide(&mut agent, &observation, &generic_runtime_actions(&adapter));

        assert_eq!(decision.chosen, RuntimeAction::Custom("mine".into()));
        assert_eq!(decision.fired_triggers.len(), 1);
    }

    #[test]
    fn missing_generic_weights_default_to_zero_and_log() {
        let adapter = sample_generic_adapter();
        let mut warnings = Vec::new();
        let policies = build_generic_policies(&adapter, |warning| warnings.push(warning)).unwrap();
        let policy = policies.iter().find(|policy| policy.persona_id == "grinder").unwrap();
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        let agent = Agent::new("agent", policy.clone(), 0.0);
        let observation = AgentObservation::new(1, 0.0, 0.0, 0.0, 0.0, 0.0);

        let scores = score_actions(
            policy,
            &generic_runtime_actions(&adapter),
            &agent,
            &observation,
            &[],
            &mut rng,
        );
        let craft = scores
            .iter()
            .find(|score| score.action == RuntimeAction::Custom("craft".into()))
            .unwrap();

        assert_eq!(craft.score, 0.0);
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("missing action weight for `craft`")));
    }
}
