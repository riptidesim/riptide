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
    adapter::{
        AccountDefinition, AccountKind, Adapter, ArgLiteral, InstructionMapping, ObservationType,
    },
    agent::policy::RuntimeAction,
    types::{
        ComparisonOp, ObservationValue, Policy, PositionSizing, PositionSizingStrategy, Trigger,
        TriggerCondition, TriggerValue,
    },
};

#[cfg(any(feature = "litesvm-backend", test))]
use {
    crate::adapter::loader::sibling_deploy_keypair_path,
    crate::adapter::OracleKind,
    crate::scenario::{oracle_layout_for, OracleUpdate},
    litesvm::LiteSVM,
    solana_account::Account,
    solana_sdk::{
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        signature::{read_keypair_file, Keypair, Signer},
    },
    solana_transaction::{Transaction, TransactionError},
    std::{
        path::{Path, PathBuf},
        str::FromStr,
    },
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
            // carry persona-supplied named args into the
            // compiled policy so the tick loop can hand them to the
            // encoder when dispatching a multi-runtime-arg action. Empty
            // for personas that only use single-arg dispatch.
            persona_args: persona.persona_args.clone(),
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

    /// Build the raw instruction-data blob for a dispatched action.
    ///
    /// semantics (preserved byte-for-byte for single-arg
    /// adapters): the IDL's instruction has at most one arg; the
    /// adapter binds it via `[instructions].<ix>.amount = "<name>"`;
    /// the engine encodes the runtime-supplied `amount` into that
    /// arg's declared Borsh type.
    ///
    /// extension — three binding forms per IDL arg:
    ///
    /// 1. **Runtime amount** — `mapping.amount = "<arg-name>"` binds
    /// the tick-loop's decision amount (a `u64`) into the named
    /// IDL arg. At most one IDL arg can be amount-bound per
    /// instruction.
    /// 2. **Adapter literal** — `mapping.args.<arg-name> = <literal>`
    /// declares a constant value the encoder emits for every
    /// dispatch. Types: u64/i64/u32/u8/bool (naturally), pubkey
    /// (base58 string).
    /// 3. **Persona-supplied runtime value** —
    /// `mapping.args.<arg-name> = "@persona.<field>"` resolves
    /// at dispatch time against the executing agent's
    /// `policy.persona_args.<field>`. Every agent running under
    /// that persona supplies its own value, so one adapter can
    /// parameterize `open_position(side, leverage, notional)`
    /// across dozens of persona archetypes without forking into
    /// one action per variant.
    ///
    /// Walks IDL args in declaration order (Borsh is position-
    /// dependent). Supported Borsh types: `u64`, `i64`, `u32`, `u8`,
    /// `bool`, `pubkey`. Wider scalars, Option, Vec, and user-
    /// defined structs are out of scope for.
    ///
    /// callers that passed a single `amount` and nothing
    /// else continue to work via the
    /// `build_action_data_single_arg` shim. callers that
    /// dispatch against multi-arg instructions call through here
    /// with the active persona's `persona_args` map.
    pub fn build_action_data(
        &self,
        action_name: &str,
        amount: u64,
        persona_args: &BTreeMap<String, ArgLiteral>,
    ) -> Result<Vec<u8>> {
        let (instruction_name, mapping, instruction) =
            resolve_instruction_for_action(self.idl, self.adapter, action_name)?;

        let mut encoded = instruction.discriminator.clone();
        for arg in &instruction.args {
            if mapping.amount.as_deref() == Some(arg.name.as_str()) {
                encode_runtime_amount(&mut encoded, &arg.ty, amount, instruction_name, &arg.name)?;
                continue;
            }
            if let Some(binding) = mapping.args.get(&arg.name) {
                // `@persona.<field>` in a String literal is not a
                // pubkey — it's a runtime reference into the
                // executing agent's `persona_args`. Resolve first,
                // then encode with the same type-coercion rules
                // every other literal goes through.
                let resolved = match binding {
                    ArgLiteral::String(s) if s.starts_with("@persona.") => {
                        let field = &s["@persona.".len()..];
                        persona_args.get(field).ok_or_else(|| {
                            anyhow!(
                                "generic instruction `{instruction_name}` arg `{}` references \
                                 `@persona.{field}` but the executing persona has no `persona_args.{field}` \
                                 value. Declare it under `[personas.<id>.persona_args]` in the adapter.",
                                arg.name
                            )
                        })?
                    }
                    other => other,
                };
                encode_literal_arg(&mut encoded, &arg.ty, resolved, instruction_name, &arg.name)?;
                continue;
            }
            bail!(
                "generic instruction `{instruction_name}` arg `{}` is not bound in the adapter. \
                 Either add `amount = \"{}\"` (runtime-bound), `args.{} = <literal>` \
                 (adapter constant), or `args.{} = \"@persona.<field>\"` (per-persona \
                 runtime value) to `[instructions.{instruction_name}]`.",
                arg.name,
                arg.name,
                arg.name,
                arg.name,
            );
        }

        Ok(encoded)
    }

    /// Convenience wrapper for single-arg call sites (
    /// shape). Calls through to `build_action_data` with an empty
    /// `persona_args` map. Prefer `build_action_data` directly in
    /// + code paths so the persona context is explicit.
    pub fn build_action_data_single_arg(
        &self,
        action_name: &str,
        amount: u64,
    ) -> Result<Vec<u8>> {
        static EMPTY: std::sync::OnceLock<BTreeMap<String, ArgLiteral>> =
            std::sync::OnceLock::new();
        let empty = EMPTY.get_or_init(BTreeMap::new);
        self.build_action_data(action_name, amount, empty)
    }

    /// Replay-mode dispatch.
    ///
    /// Resolution rules:
    /// 1. If `name` matches an adapter action, use that action's mapped
    /// instruction. Inline replay args are matched against the IDL arg
    /// names and override any `@persona.*` mapping that would
    /// otherwise require persona state.
    /// 2. If `name` does not match an adapter action but does match an IDL
    /// instruction, dispatch the raw instruction directly. Every IDL arg
    /// must then be supplied inline under `args`.
    pub fn build_replay_data(
        &self,
        name: &str,
        replay_args: &BTreeMap<String, ArgLiteral>,
    ) -> Result<Vec<u8>> {
        match resolve_replay_instruction(self.idl, self.adapter, name)? {
            ReplayInstructionResolution::Mapped {
                action_name,
                instruction_name,
                mapping,
                instruction,
            } => {
                let mut encoded = instruction.discriminator.clone();
                for arg in &instruction.args {
                    if let Some(literal) = replay_args.get(&arg.name) {
                        encode_literal_arg(
                            &mut encoded,
                            &arg.ty,
                            literal,
                            instruction_name,
                            &arg.name,
                        )?;
                        continue;
                    }
                    if let Some(binding) = mapping.args.get(&arg.name) {
                        match binding {
                            ArgLiteral::String(s) if s.starts_with("@persona.") => {
                                bail!(
                                    "replay action `{action_name}` must supply inline arg `{}` \
                                     because the adapter mapping resolves it from persona state",
                                    arg.name
                                );
                            }
                            other => {
                                encode_literal_arg(
                                    &mut encoded,
                                    &arg.ty,
                                    other,
                                    instruction_name,
                                    &arg.name,
                                )?;
                                continue;
                            }
                        }
                    }
                    if mapping.amount.as_deref() == Some(arg.name.as_str()) {
                        bail!(
                            "replay action `{action_name}` missing inline arg `{}` required by \
                             adapter instruction `{instruction_name}`",
                            arg.name
                        );
                    }
                    bail!(
                        "replay action `{action_name}` cannot bind IDL arg `{}` for instruction \
                         `{instruction_name}`; supply it inline under `args.{}`",
                        arg.name,
                        arg.name
                    );
                }
                Ok(encoded)
            }
            ReplayInstructionResolution::Raw { instruction } => {
                let mut encoded = instruction.discriminator.clone();
                for arg in &instruction.args {
                    let literal = replay_args.get(&arg.name).ok_or_else(|| {
                        anyhow!(
                            "replay instruction `{name}` missing inline arg `{}`",
                            arg.name
                        )
                    })?;
                    encode_literal_arg(&mut encoded, &arg.ty, literal, &instruction.name, &arg.name)?;
                }
                Ok(encoded)
            }
        }
    }

    pub fn resolve_instruction_for_replay<'b>(
        &'b self,
        name: &'b str,
    ) -> Result<&'b GenericInstruction> {
        match resolve_replay_instruction(self.idl, self.adapter, name)? {
            ReplayInstructionResolution::Mapped { instruction, .. } => Ok(instruction),
            ReplayInstructionResolution::Raw { instruction } => Ok(instruction),
        }
    }
}

enum ReplayInstructionResolution<'a> {
    Mapped {
        action_name: &'a str,
        instruction_name: &'a str,
        mapping: &'a InstructionMapping,
        instruction: &'a GenericInstruction,
    },
    Raw {
        instruction: &'a GenericInstruction,
    },
}

fn resolve_replay_instruction<'a>(
    idl: &'a GenericIdl,
    adapter: &'a Adapter,
    name: &'a str,
) -> Result<ReplayInstructionResolution<'a>> {
    if let Ok((instruction_name, mapping, instruction)) =
        resolve_instruction_for_action(idl, adapter, name)
    {
        return Ok(ReplayInstructionResolution::Mapped {
            action_name: name,
            instruction_name,
            mapping,
            instruction,
        });
    }
    let instruction = idl
        .instructions
        .iter()
        .find(|instruction| instruction.name == name)
        .ok_or_else(|| anyhow!("generic adapter/IDL missing action or instruction `{name}`"))?;
    Ok(ReplayInstructionResolution::Raw { instruction })
}

pub(crate) fn resolve_instruction_for_action<'a>(
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

/// Encode the runtime-computed `amount` (always a `u64` at the
/// decision layer) into the byte slot an IDL arg of type `ty`
/// occupies. Mirrors the single-arg code path plus the
/// scalar additions (`u32`, `u8`). Range overflow
/// surfaces as an adapter error — a u64 amount wider than the
/// declared target type is always a misconfiguration.
fn encode_runtime_amount(
    out: &mut Vec<u8>,
    ty: &GenericTypeRef,
    amount: u64,
    instruction_name: &str,
    arg_name: &str,
) -> Result<()> {
    match ty {
        GenericTypeRef::Primitive(name) if name == "u64" => {
            out.extend_from_slice(&amount.to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "i64" => {
            // Match behavior: bit-pattern cast, no range check.
            // The runtime amount is `u64` but the IDL arg is signed;
            // adapters that genuinely need a signed runtime arg in the
            // upper half of u64 should declare `u64` on the IDL side.
            out.extend_from_slice(&(amount as i64).to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "u32" => {
            if amount > u64::from(u32::MAX) {
                bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `u32` \
                     but runtime amount {amount} exceeds u32::MAX"
                );
            }
            out.extend_from_slice(&(amount as u32).to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "u8" => {
            if amount > u64::from(u8::MAX) {
                bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `u8` \
                     but runtime amount {amount} exceeds u8::MAX"
                );
            }
            out.push(amount as u8);
            Ok(())
        }
        other => bail!(
            "instruction `{instruction_name}` arg `{arg_name}`: runtime-bound args only \
             support `u64`/`i64`/`u32`/`u8` (got `{other:?}`). For `bool`/`pubkey` args, \
             declare a literal under `[instructions].{instruction_name}.args.{arg_name}`."
        ),
    }
}

/// Encode an adapter-declared literal constant into the byte slot an
/// IDL arg of type `ty` occupies. enables multi-arg
/// dispatch where the runtime amount flows into one IDL arg and every
/// other IDL arg's value is fixed at adapter load time.
fn encode_literal_arg(
    out: &mut Vec<u8>,
    ty: &GenericTypeRef,
    literal: &ArgLiteral,
    instruction_name: &str,
    arg_name: &str,
) -> Result<()> {
    match ty {
        GenericTypeRef::Primitive(name) if name == "u64" => {
            let value = literal_as_u64(literal, instruction_name, arg_name, "u64")?;
            out.extend_from_slice(&value.to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "i64" => {
            let value = literal_as_i64(literal, instruction_name, arg_name, "i64")?;
            out.extend_from_slice(&value.to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "u32" => {
            let value = literal_as_u64(literal, instruction_name, arg_name, "u32")?;
            if value > u64::from(u32::MAX) {
                bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `u32` \
                     but literal value {value} exceeds u32::MAX"
                );
            }
            out.extend_from_slice(&(value as u32).to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "u8" => {
            let value = literal_as_u64(literal, instruction_name, arg_name, "u8")?;
            if value > u64::from(u8::MAX) {
                bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `u8` \
                     but literal value {value} exceeds u8::MAX"
                );
            }
            out.push(value as u8);
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "bool" => {
            let value = match literal {
                ArgLiteral::Bool(b) => *b,
                other => bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `bool` \
                     but literal was `{other:?}`; expected `true` / `false`"
                ),
            };
            out.push(if value { 1 } else { 0 });
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "pubkey" => {
            let encoded = match literal {
                ArgLiteral::String(s) => bs58::decode(s)
                    .into_vec()
                    .map_err(|e| anyhow!(
                        "instruction `{instruction_name}` arg `{arg_name}` declared as `pubkey` \
                         but literal `{s}` is not base58-decodable: {e}"
                    ))?,
                other => bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `pubkey` \
                     but literal was `{other:?}`; expected a base58-encoded 32-byte key"
                ),
            };
            if encoded.len() != 32 {
                bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `pubkey` \
                     but literal decoded to {} bytes (expected 32)",
                    encoded.len()
                );
            }
            out.extend_from_slice(&encoded);
            Ok(())
        }
        other => bail!(
            "instruction `{instruction_name}` arg `{arg_name}`: unsupported IDL arg type \
             `{other:?}` for literal binding. Supported: \
             u64/i64/u32/u8/bool/pubkey — wider scalars, Option, Vec, and user-defined \
             structs are out of scope."
        ),
    }
}

fn literal_as_u64(
    literal: &ArgLiteral,
    instruction_name: &str,
    arg_name: &str,
    target_ty: &str,
) -> Result<u64> {
    match literal {
        ArgLiteral::Int(v) if *v >= 0 => Ok(*v as u64),
        ArgLiteral::Int(v) => bail!(
            "instruction `{instruction_name}` arg `{arg_name}` declared as `{target_ty}` \
             but literal `{v}` is negative"
        ),
        other => bail!(
            "instruction `{instruction_name}` arg `{arg_name}` declared as `{target_ty}` \
             but literal was `{other:?}`; expected a non-negative integer"
        ),
    }
}

fn literal_as_i64(
    literal: &ArgLiteral,
    instruction_name: &str,
    arg_name: &str,
    target_ty: &str,
) -> Result<i64> {
    match literal {
        ArgLiteral::Int(v) => Ok(*v),
        other => bail!(
            "instruction `{instruction_name}` arg `{arg_name}` declared as `{target_ty}` \
             but literal was `{other:?}`; expected an integer"
        ),
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
    /// Runtime binding of the one declared oracle (if any) to the
    /// shared account it targets. Present only when the adapter's
    /// `[[oracles]]` block declared a single oracle entry — bootstrap
    /// already rejects adapters that declare more than one. `None` for
    /// adapters that declare no `[[oracles]]` block; `push_oracle_price`
    /// is a no-op in that case so existing generic adapters without an
    /// oracle binding (perps-fork, amm-fork) keep their byte-identical
    /// regression behavior.
    oracle_binding: Option<RuntimeOracleBinding>,
    current_slot: u64,
}

/// Runtime resolution of the declared oracle to the shared-account pubkey
/// the generic harness bound at bootstrap time. `kind` selects which
/// `OracleLayout` encodes each subsequent price push; the account pubkey
/// is resolved through `shared_accounts[account_name]` at push time so
/// the binding stays durable across harness mutations.
#[cfg(any(feature = "litesvm-backend", test))]
#[derive(Debug, Clone)]
pub(crate) struct RuntimeOracleBinding {
    pub(crate) account_name: String,
    pub(crate) kind: OracleKind,
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

        let (agent_accounts, shared_accounts, oracle_binding) = bootstrap_generic_accounts(
            &mut svm,
            &config.adapter,
            config.agent_count,
            &program_id,
            &admin.pubkey(),
        )?;

        Ok(Self {
            svm,
            program_id,
            admin,
            agents,
            adapter: config.adapter,
            idl,
            agent_accounts,
            shared_accounts,
            oracle_binding,
            current_slot: 0,
        })
    }

    /// Look up an agent-scoped account's pubkey by its adapter-declared
    /// name + agent index. Returns `None` for shared accounts or unknown
    /// names. Mirrors [`Self::inspect_shared_account_pubkey`] for
    /// integration tests that need to hand agent-scoped accounts to
    /// raw instructions the adapter runtime does not dispatch.
    pub fn inspect_agent_account_pubkey(
        &self,
        name: &str,
        agent_idx: usize,
    ) -> Option<Pubkey> {
        self.agent_accounts
            .get(name)
            .and_then(|pubkeys| pubkeys.get(agent_idx).copied())
    }

    /// Immutable access to the harness's LiteSVM instance. Integration
    /// tests use this to read arbitrary program-owned accounts that the
    /// adapter does not declare under `[accounts]` (e.g. when the test
    /// drives program-level instructions directly alongside the generic
    /// harness's adapter-level dispatch).
    pub fn svm(&self) -> &LiteSVM {
        &self.svm
    }

    /// Mutable access to the harness's LiteSVM instance. Used by proof
    /// tests that need to dispatch program instructions outside the
    /// adapter's `[instructions]` registry (e.g. `open_position` /
    /// `close_position` on `perps-fork`, which are intentionally not
    /// bound to runtime actions in the shipping adapter).
    pub fn svm_mut(&mut self) -> &mut LiteSVM {
        &mut self.svm
    }

    /// Look up a shared account's pubkey by its adapter-declared name.
    /// Returns `None` for agent-scoped accounts or unknown names.
    /// Used by integration tests that need to inspect an
    /// adapter-bootstrapped account without reaching into private
    /// fields.
    pub fn inspect_shared_account_pubkey(&self, name: &str) -> Option<Pubkey> {
        self.shared_accounts.get(name).copied()
    }

    /// Read the current on-chain state of a shared account by its
    /// adapter-declared name. Returns `None` if the account is not
    /// declared or has not been materialized yet.
    pub fn inspect_shared_account(&self, name: &str) -> Option<Account> {
        let pubkey = self.shared_accounts.get(name)?;
        self.svm.get_account(pubkey)
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

    /// Write a new oracle value into the adapter-declared shared oracle
    /// account through the real layout dispatcher.
    ///
    /// - Adapters with no `[[oracles]]` block keep the trait's no-op
    ///   semantics (preserves the shipped `perps-fork.toml` /
    ///   `amm-fork.toml` scratch-gate hashes).
    /// - Adapters that declared one oracle reach this path on every
    ///   tick: encode through `oracle_layout_for(kind)`, write into the
    ///   bound shared account via `svm.set_account`, then decode the
    ///   post-write bytes to verify the layout round-trips. Owner and
    ///   lamports are preserved so a sibling-program-owned oracle
    ///   (admin-mock, Pyth) stays readable by programs that enforce
    ///   owner checks.
    /// - Any inconsistency — missing binding despite declaration,
    ///   undersized account buffer, decode failure — surfaces as
    ///   `PrimitiveError::Infra` with the offending account name in the
    ///   message. The tick loop will retry once and then bail; a silent
    ///   no-op would hide real adapter misconfiguration.
    fn push_oracle_price(
        &mut self,
        update: &OracleUpdate,
    ) -> Result<(), crate::primitive::PrimitiveError> {
        let Some(binding) = self.oracle_binding.clone() else {
            return Ok(());
        };
        let pubkey = self
            .shared_accounts
            .get(&binding.account_name)
            .copied()
            .ok_or_else(|| {
                crate::primitive::PrimitiveError::Infra(format!(
                    "generic oracle binding targets shared account `{}` but no such \
                     account is registered on the harness. Bootstrap should have \
                     created it — this indicates a bootstrap invariant violation.",
                    binding.account_name
                ))
            })?;
        let existing = self.svm.get_account(&pubkey).ok_or_else(|| {
            crate::primitive::PrimitiveError::Infra(format!(
                "generic oracle account `{}` ({pubkey}) vanished between bootstrap and \
                 oracle push. Something wrote the account out from under us — inspect \
                 the adapter's instruction dispatch for unintended reassignment.",
                binding.account_name
            ))
        })?;
        let layout = oracle_layout_for(binding.kind);
        let encoded = layout
            .encode(self.admin.pubkey().to_bytes(), update)
            .map_err(|error| {
                crate::primitive::PrimitiveError::Infra(format!(
                    "oracle layout `{:?}` failed to encode an update for account `{}`: {error}",
                    binding.kind, binding.account_name
                ))
            })?;
        if existing.data.len() < encoded.len() {
            return Err(crate::primitive::PrimitiveError::Infra(format!(
                "generic oracle account `{}` has {} bytes of space but the `{:?}` layout \
                 needs at least {} bytes. Raise `[accounts.{}].space` in the adapter \
                 TOML to at least {}.",
                binding.account_name,
                existing.data.len(),
                binding.kind,
                encoded.len(),
                binding.account_name,
                encoded.len(),
            )));
        }
        let mut data = existing.data.clone();
        data[..encoded.len()].copy_from_slice(&encoded);
        let new_account = Account {
            lamports: existing.lamports,
            data,
            owner: existing.owner,
            executable: existing.executable,
            rent_epoch: existing.rent_epoch,
        };
        self.svm.set_account(pubkey, new_account).map_err(|error| {
            crate::primitive::PrimitiveError::Infra(format!(
                "failed to write oracle bytes into account `{}` ({pubkey}): {error:?}",
                binding.account_name
            ))
        })?;
        let verify = self.svm.get_account(&pubkey).ok_or_else(|| {
            crate::primitive::PrimitiveError::Infra(format!(
                "oracle account `{}` ({pubkey}) disappeared immediately after write",
                binding.account_name
            ))
        })?;
        layout.decode(&verify.data).map_err(|error| {
            crate::primitive::PrimitiveError::Infra(format!(
                "oracle layout `{:?}` could not decode the bytes we just wrote to `{}`: {error}",
                binding.kind, binding.account_name
            ))
        })?;
        Ok(())
    }

    fn execute_action(
        &mut self,
        agent_idx: usize,
        action: &str,
        amount: u64,
        target_idx: Option<usize>,
    ) -> Result<(), crate::primitive::PrimitiveError> {
        // Default dispatch with no persona-supplied args — used by
        // single-arg adapters and by the integration tests
        // that drive GenericHarness directly.
        self.execute_action_with_persona_args(
            agent_idx,
            action,
            amount,
            target_idx,
            &BTreeMap::new(),
        )
    }

    fn execute_action_with_persona_args(
        &mut self,
        agent_idx: usize,
        action: &str,
        amount: u64,
        _target_idx: Option<usize>,
        persona_args: &BTreeMap<String, crate::adapter::ArgLiteral>,
    ) -> Result<(), crate::primitive::PrimitiveError> {
        let (_, _, instruction) = resolve_instruction_for_action(&self.idl, &self.adapter, action)
            .map_err(|error| crate::primitive::PrimitiveError::ProgramRejected(error.to_string()))?;
        let data = GenericInstructionBuilder::new(&self.idl, &self.adapter)
            .build_action_data(action, amount, persona_args)
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

    fn execute_replay_action(
        &mut self,
        agent_idx: usize,
        action: &str,
        args: &BTreeMap<String, crate::adapter::ArgLiteral>,
        _target_idx: Option<usize>,
    ) -> Result<(), crate::primitive::PrimitiveError> {
        let builder = GenericInstructionBuilder::new(&self.idl, &self.adapter);
        let instruction = builder
            .resolve_instruction_for_replay(action)
            .map_err(|error| crate::primitive::PrimitiveError::ProgramRejected(error.to_string()))?;
        let data = builder
            .build_replay_data(action, args)
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
            // Bound oracle accounts (declared under `[[oracles]]` and
            // pointed at via `account = "<name>"`) are driven through
            // the `oracle_layout_for(kind)` dispatcher, not the
            // simulated program's IDL — their byte layout is
            // deliberately NOT described in the program's account
            // types, so `observe_account_state` cannot decode them.
            // Skip only those exact account names; every other shared
            // account (including externally-owned ones whose bytes
            // the IDL *does* describe) still flows through the normal
            // observation path. Without this narrow guard, any
            // liquid-staking-style adapter that binds a sibling-owned
            // oracle red-lines the tick loop with "generic IDL missing
            // account type `oracle`" even though bootstrap succeeded;
            // a broader skip (on `owner.is_some()`) would silently
            // hide observations for future adapters that map into
            // IDL-described externally-owned accounts.
            let is_bound_oracle = self
                .adapter
                .oracles
                .iter()
                .any(|oracle| oracle.account.as_deref() == Some(account_name.as_str()));
            if is_bound_oracle {
                continue;
            }
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
        // - bool → count of `true` across agents, as u64
        // - pubkey → count of distinct pubkeys across agents, as u64
        // - map → mean entry count across agents, as f64
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
pub(crate) fn load_generic_program_bytes(path: &Path) -> Result<Vec<u8>> {
    if !path.exists() {
        bail!(
            "generic program .so not found at {}\nRun the matching `cargo build-sbf` command for this adapter first.",
            path.display()
        );
    }
    std::fs::read(path).with_context(|| format!("read generic program {}", path.display()))
}

#[cfg(any(feature = "litesvm-backend", test))]
pub(crate) fn generic_airdrop(svm: &mut LiteSVM, address: &Pubkey, lamports: u64) -> Result<()> {
    svm.airdrop(address, lamports)
        .map_err(|error| anyhow!("airdrop to {address}: {error:?}"))
        .map(|_| ())
}

#[cfg(any(feature = "litesvm-backend", test))]
pub(crate) fn bootstrap_generic_accounts(
    svm: &mut LiteSVM,
    adapter: &Adapter,
    agent_count: usize,
    program_id: &Pubkey,
    admin: &Pubkey,
) -> Result<(
    BTreeMap<String, Vec<Pubkey>>,
    BTreeMap<String, Pubkey>,
    Option<RuntimeOracleBinding>,
)> {
    if adapter.oracles.len() > 1 {
        bail!(
            "generic adapter declares {} `[[oracles]]` entries but the current scenario and \
             replay surfaces still emit a single oracle update stream. Single-oracle generic \
             semantics are an explicit contract for now — reduce to one `[[oracles]]` entry or \
             wait for multi-oracle dispatch to land.",
            adapter.oracles.len()
        );
    }
    // Pre-resolve the (at-most-one) oracle binding so account creation
    // has access to the layout floor and the starting oracle bytes.
    let oracle_binding = match adapter.oracles.first() {
        Some(oracle) => {
            let account = oracle.account.as_deref().ok_or_else(|| {
                anyhow!(
                    "generic adapter oracle `{}` has no `account` binding. The loader is \
                     expected to catch this — reaching it at bootstrap time implies a stale \
                     adapter was passed directly without going through `load_adapter`.",
                    oracle.name
                )
            })?;
            let layout = oracle_layout_for(oracle.kind);
            Some(OracleBinding {
                account_name: account.to_string(),
                kind: oracle.kind,
                layout,
                update: OracleUpdate {
                    price: oracle.base_price,
                    exponent: oracle.exponent,
                },
            })
        }
        None => None,
    };

    let mut agent_accounts = BTreeMap::new();
    let mut shared_accounts = BTreeMap::new();

    for (account_name, definition) in &adapter.accounts {
        let lamports = svm.minimum_balance_for_rent_exemption(definition.space);
        match definition.kind {
            AccountKind::Agent => {
                let owner = *program_id;
                let mut pubkeys = Vec::with_capacity(agent_count);
                for _ in 0..agent_count {
                    let pubkey = Pubkey::new_unique();
                    svm.set_account(
                        pubkey,
                        Account {
                            lamports,
                            data: vec![0u8; definition.space],
                            owner,
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
                let owner = resolve_shared_account_owner(account_name, definition, program_id)?;
                let pubkey = Pubkey::new_unique();
                let is_oracle = oracle_binding
                    .as_ref()
                    .is_some_and(|binding| binding.account_name == *account_name);
                let data = if is_oracle {
                    let binding = oracle_binding
                        .as_ref()
                        .expect("oracle_binding checked above");
                    let floor = binding.layout.byte_len();
                    if definition.space < floor {
                        bail!(
                            "generic adapter oracle account `{account_name}` declared \
                             `space = {}` but the `{:?}` oracle layout needs at least {floor} \
                             bytes. Raise `[accounts.{account_name}].space` to at least {floor}.",
                            definition.space,
                            adapter
                                .oracles
                                .first()
                                .map(|o| o.kind)
                                .expect("oracle_binding implies first() is Some"),
                        );
                    }
                    let mut buf = binding
                        .layout
                        .encode(admin.to_bytes(), &binding.update)
                        .with_context(|| {
                            format!(
                                "encode tick-0 oracle bytes for generic adapter oracle \
                                 account `{account_name}`"
                            )
                        })?;
                    buf.resize(definition.space, 0);
                    buf
                } else {
                    vec![0u8; definition.space]
                };
                svm.set_account(
                    pubkey,
                    Account {
                        lamports,
                        data,
                        owner,
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

    let runtime_binding = oracle_binding.map(|binding| RuntimeOracleBinding {
        account_name: binding.account_name,
        kind: binding.kind,
    });
    Ok((agent_accounts, shared_accounts, runtime_binding))
}

#[cfg(any(feature = "litesvm-backend", test))]
struct OracleBinding {
    account_name: String,
    kind: OracleKind,
    layout: Box<dyn crate::scenario::OracleLayout>,
    update: OracleUpdate,
}

/// Resolve the on-chain owner pubkey for a shared account according to
/// the adapter's declared ownership metadata. Falls back to the
/// simulated program id when no external owner is declared — preserving
/// the pre-owner-aware behavior for every shipped adapter that opts out.
#[cfg(any(feature = "litesvm-backend", test))]
fn resolve_shared_account_owner(
    account_name: &str,
    definition: &AccountDefinition,
    program_id: &Pubkey,
) -> Result<Pubkey> {
    let Some(owner) = definition.owner.as_ref() else {
        return Ok(*program_id);
    };
    if let Some(pubkey_str) = owner.pubkey.as_deref() {
        return Pubkey::from_str(pubkey_str).map_err(|error| {
            anyhow!(
                "resolve owner for shared account `{account_name}`: `owner.pubkey` `{pubkey_str}` \
                 is not a valid base58-encoded pubkey: {error}"
            )
        });
    }
    if let Some(program_so) = owner.program_so.as_deref() {
        let so_path = Path::new(program_so);
        let keypair_path = sibling_deploy_keypair_path(so_path).ok_or_else(|| {
            anyhow!(
                "resolve owner for shared account `{account_name}`: cannot derive sibling \
                 keypair path from `{program_so}`"
            )
        })?;
        if !keypair_path.exists() {
            bail!(
                "resolve owner for shared account `{account_name}`: sibling-program keypair not \
                 found at {}. Build the sibling program with `cargo build-sbf` (which generates \
                 the keypair) before running the simulation.",
                keypair_path.display()
            );
        }
        let keypair = read_keypair_file(&keypair_path).map_err(|error| {
            anyhow!(
                "resolve owner for shared account `{account_name}`: failed to read sibling \
                 keypair {}: {error}",
                keypair_path.display()
            )
        })?;
        return Ok(keypair.pubkey());
    }
    // The loader rejects empty owner blocks, but defend the invariant.
    bail!(
        "resolve owner for shared account `{account_name}`: owner block declared but neither \
         `program_so` nor `pubkey` is set"
    );
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

        let bytes = builder.build_action_data_single_arg("mine", 7).unwrap();
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
