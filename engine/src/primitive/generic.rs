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
use sha2::{Digest, Sha256};

use crate::{
    adapter::{
        AccountDecoder, AccountDefinition, AccountKind, Adapter, ArgLiteral, InstructionMapping,
        LayoutField, LayoutFieldType, ObservationType,
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
    crate::adapter::{OracleKind, SemanticClassRef, SemanticSourceBinding},
    crate::scenario::oracle::{oracle_layout_for, OracleEncodeContext, OracleUpdate},
    litesvm::LiteSVM,
    solana_account::Account,
    solana_clock::Clock,
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
    #[serde(default)]
    pub address: Option<String>,
    pub instructions: Vec<GenericInstruction>,
    #[serde(default)]
    pub accounts: Vec<GenericAccountType>,
    #[serde(default)]
    pub types: Vec<GenericDefinedType>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericInstruction {
    pub name: String,
    #[serde(default)]
    pub discriminator: Vec<u8>,
    #[serde(default)]
    pub accounts: Vec<GenericInstructionAccount>,
    #[serde(default)]
    pub args: Vec<GenericArg>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericInstructionAccount {
    pub name: String,
    #[serde(default, alias = "isSigner")]
    pub signer: bool,
    #[serde(default, alias = "isMut")]
    pub writable: bool,
    #[serde(default)]
    pub address: Option<String>,
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
    #[serde(default)]
    pub discriminator: Option<Vec<u8>>,
    #[serde(default)]
    pub fields: Vec<GenericField>,
    #[serde(default, rename = "type")]
    pub type_def: Option<GenericTypeDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericDefinedType {
    pub name: String,
    #[serde(default)]
    pub fields: Vec<GenericField>,
    #[serde(default, rename = "type")]
    pub type_def: Option<GenericTypeDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct GenericTypeDefinition {
    pub kind: String,
    #[serde(default)]
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
    Defined { defined: GenericDefinedRef },
    Option { option: Box<GenericTypeRef> },
    Array { array: (Box<GenericTypeRef>, usize) },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(untagged)]
pub enum GenericDefinedRef {
    Name(String),
    Object { name: String },
}

impl GenericDefinedRef {
    fn as_str(&self) -> &str {
        match self {
            Self::Name(name) | Self::Object { name } => name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GenericValue {
    Int(i64),
    UInt(u64),
    I128(i128),
    U128(u128),
    Bool(bool),
    Pubkey(String),
    String(String),
    Struct(BTreeMap<String, GenericValue>),
    Vec(Vec<GenericValue>),
    Bytes(Vec<u8>),
    Option(Option<Box<GenericValue>>),
}

pub fn parse_generic_idl_str(raw: &str) -> Result<GenericIdl> {
    let raw_value: serde_json::Value =
        serde_json::from_str(raw).context("parse generic IDL JSON")?;
    let legacy_anchor_instructions = raw_value
        .get("instructions")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|instructions| {
            instructions
                .iter()
                .any(|instruction| instruction.get("discriminator").is_none())
        });
    let legacy_anchor_accounts = raw_value
        .get("accounts")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|accounts| {
            accounts.iter().any(|account| {
                account.get("discriminator").is_none()
                    && account.get("type").is_some()
                    && account.get("fields").is_none()
            })
        });
    let legacy_anchor_shape =
        raw_value.get("metadata").is_some() || legacy_anchor_instructions || legacy_anchor_accounts;
    let mut idl: GenericIdl =
        serde_json::from_value(raw_value).context("parse generic IDL JSON")?;
    if legacy_anchor_shape {
        normalize_legacy_anchor_discriminators(&mut idl);
    }
    Ok(idl)
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
    if let Some(decoder) = adapter
        .accounts
        .get(account_name)
        .and_then(|account| account.decoder.as_ref())
    {
        return observe_decoded_account_state(adapter, account_name, decoder, bytes);
    }

    let account_type = idl
        .accounts
        .iter()
        .find(|candidate| idl_name_matches(&candidate.name, account_name))
        .ok_or_else(|| anyhow!("generic IDL missing account type `{account_name}`"))?;
    let fields = account_fields(idl, account_type)
        .ok_or_else(|| anyhow!("generic IDL account `{account_name}` has no decodable fields"))?;
    let mut cursor = ByteCursor::new(bytes);
    if let Some(discriminator) = account_type.discriminator.as_ref() {
        cursor.skip(discriminator.len()).with_context(|| {
            format!(
                "decode account `{account_name}`: account data shorter than {}-byte discriminator",
                discriminator.len()
            )
        })?;
    }
    let value = decode_struct(idl, fields, &mut cursor)
        .with_context(|| format!("decode account `{account_name}`"))?;

    let mut observations = BTreeMap::new();
    for (mapping_key, logical_name) in &adapter.state_mapping {
        let Some((mapped_account, field_path)) = mapping_key.split_once('.') else {
            continue;
        };
        if mapped_account != account_name {
            continue;
        }
        let extracted = value.get_path(field_path).ok_or_else(|| {
            anyhow!("field path `{field_path}` missing in account `{account_name}`")
        })?;
        let expected = adapter
            .observations
            .get(logical_name)
            .ok_or_else(|| anyhow!("generic observation `{logical_name}` missing from adapter"))?
            .kind();
        observations.insert(logical_name.clone(), extracted.to_observation(expected)?);
    }

    Ok(observations)
}

fn observe_decoded_account_state(
    adapter: &Adapter,
    account_name: &str,
    decoder: &AccountDecoder,
    bytes: &[u8],
) -> Result<BTreeMap<String, ObservationValue>> {
    let fields = decoder.layout().ok_or_else(|| match decoder {
        AccountDecoder::Preset(name) => anyhow!("unknown account decoder preset `{name}`"),
        AccountDecoder::Layout(layout) => {
            anyhow!("unknown account decoder kind `{}`", layout.kind)
        }
    })?;
    let mut observations = BTreeMap::new();
    for (mapping_key, logical_name) in &adapter.state_mapping {
        let Some((mapped_account, field_name)) = mapping_key.split_once('.') else {
            continue;
        };
        if mapped_account != account_name {
            continue;
        }
        let field = fields.get(field_name).ok_or_else(|| {
            anyhow!("decoder field `{field_name}` missing in account `{account_name}`")
        })?;
        let expected = adapter
            .observations
            .get(logical_name)
            .ok_or_else(|| anyhow!("generic observation `{logical_name}` missing from adapter"))?
            .kind();
        let value = decode_layout_field(field, bytes).with_context(|| {
            format!("decode account `{account_name}` layout field `{field_name}`")
        })?;
        observations.insert(logical_name.clone(), value.to_observation(expected)?);
    }
    Ok(observations)
}

fn account_fields<'a>(
    idl: &'a GenericIdl,
    account: &'a GenericAccountType,
) -> Option<&'a [GenericField]> {
    if !account.fields.is_empty() {
        return Some(&account.fields);
    }
    if let Some(type_def) = account.type_def.as_ref() {
        return Some(type_def.fields.as_slice());
    }
    let defined = idl
        .types
        .iter()
        .find(|candidate| idl_name_matches(&candidate.name, &account.name))?;
    Some(defined.fields())
}

fn idl_name_matches(idl_name: &str, adapter_name: &str) -> bool {
    idl_name == adapter_name
        || idl_name.eq_ignore_ascii_case(adapter_name)
        || normalize_idl_name(idl_name) == normalize_idl_name(adapter_name)
}

fn normalize_idl_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| *ch != '_' && *ch != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_pubkey_type_name(value: &str) -> bool {
    matches!(value, "pubkey" | "publicKey")
}

fn normalize_legacy_anchor_discriminators(idl: &mut GenericIdl) {
    for instruction in &mut idl.instructions {
        if instruction.discriminator.is_empty() {
            instruction.discriminator =
                anchor_discriminator("global", &to_anchor_snake_case(&instruction.name));
        }
    }
    for account in &mut idl.accounts {
        if account.discriminator.is_none()
            && account.type_def.is_some()
            && account.fields.is_empty()
        {
            account.discriminator = Some(anchor_discriminator("account", &account.name));
        }
    }
}

fn anchor_discriminator(namespace: &str, name: &str) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(name.as_bytes());
    hasher.finalize()[..8].to_vec()
}

fn to_anchor_snake_case(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    let mut previous_was_lower_or_digit = false;
    for ch in value.chars() {
        if ch == '-' || ch == ' ' {
            if !out.ends_with('_') {
                out.push('_');
            }
            previous_was_lower_or_digit = false;
            continue;
        }
        if ch == '_' {
            if !out.ends_with('_') {
                out.push('_');
            }
            previous_was_lower_or_digit = false;
            continue;
        }
        if ch.is_ascii_uppercase() {
            if previous_was_lower_or_digit && !out.ends_with('_') {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
            previous_was_lower_or_digit = false;
        } else {
            out.push(ch);
            previous_was_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        }
    }
    out
}

impl GenericDefinedType {
    fn fields(&self) -> &[GenericField] {
        if !self.fields.is_empty() {
            &self.fields
        } else {
            self.type_def
                .as_ref()
                .map(|type_def| type_def.fields.as_slice())
                .unwrap_or(&[])
        }
    }
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
    /// dispatch. Types: u128/i128/u64/i64/u32/u8/bool (naturally),
    /// pubkey (base58 string).
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
    /// dependent). Supported Borsh types: `u128`, `i128`, `u64`, `i64`,
    /// `u32`, `u8`, `bool`, `pubkey`. Option, Vec, and user-defined
    /// structs are out of scope for.
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
    pub fn build_action_data_single_arg(&self, action_name: &str, amount: u64) -> Result<Vec<u8>> {
        static EMPTY: std::sync::OnceLock<BTreeMap<String, ArgLiteral>> =
            std::sync::OnceLock::new();
        let empty = EMPTY.get_or_init(BTreeMap::new);
        self.build_action_data(action_name, amount, empty)
    }

    pub fn build_action_event_params(
        &self,
        action_name: &str,
        amount: u64,
        persona_args: &BTreeMap<String, ArgLiteral>,
    ) -> Result<BTreeMap<String, serde_json::Value>> {
        let (instruction_name, mapping, instruction) =
            resolve_instruction_for_action(self.idl, self.adapter, action_name)?;

        let mut params = BTreeMap::new();
        for arg in &instruction.args {
            if mapping.amount.as_deref() == Some(arg.name.as_str()) {
                params.insert(arg.name.clone(), serde_json::Value::from(amount));
                continue;
            }
            if let Some(binding) = mapping.args.get(&arg.name) {
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
                params.insert(
                    arg.name.clone(),
                    crate::primitive::lending::arg_literal_to_event_value(resolved),
                );
            }
        }
        Ok(params)
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
                    encode_literal_arg(
                        &mut encoded,
                        &arg.ty,
                        literal,
                        &instruction.name,
                        &arg.name,
                    )?;
                }
                Ok(encoded)
            }
        }
    }

    pub fn build_scheduled_data(
        &self,
        instruction_name: &str,
        scheduled_args: &BTreeMap<String, serde_json::Value>,
    ) -> Result<Vec<u8>> {
        let mapping = self
            .adapter
            .instructions
            .get(instruction_name)
            .ok_or_else(|| {
                anyhow!("generic adapter missing scheduled instruction `{instruction_name}`")
            })?;
        let instruction = self
            .idl
            .instructions
            .iter()
            .find(|instruction| instruction.name == instruction_name)
            .ok_or_else(|| anyhow!("generic IDL missing instruction `{instruction_name}`"))?;
        let scheduled_literals = scheduled_args
            .iter()
            .map(|(name, value)| {
                Ok((
                    name.clone(),
                    json_value_to_arg_literal(value).with_context(|| {
                        format!(
                            "scheduled instruction `{instruction_name}` arg `{name}` \
                         must be a bool, integer, or string literal"
                        )
                    })?,
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;

        let mut encoded = instruction.discriminator.clone();
        for arg in &instruction.args {
            if let Some(literal) = scheduled_literals.get(&arg.name) {
                encode_literal_arg(&mut encoded, &arg.ty, literal, instruction_name, &arg.name)?;
                continue;
            }
            if let Some(binding) = mapping.args.get(&arg.name) {
                match binding {
                    ArgLiteral::String(s) if s.starts_with("@persona.") => {
                        bail!(
                            "scheduled instruction `{instruction_name}` arg `{}` resolves from \
                             persona state in `[instructions.{instruction_name}].args`; scheduled \
                             actions must provide it inline under `[[scheduled_actions]].args.{}`",
                            arg.name,
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
                    "scheduled instruction `{instruction_name}` arg `{}` is bound as the \
                     runtime `amount` in `[instructions.{instruction_name}]`, but scheduled \
                     actions have no implicit runtime amount. Provide an explicit \
                     `[[scheduled_actions]].args.{}` value or use a zero-arg scheduled \
                     instruction.",
                    arg.name,
                    arg.name
                );
            }
            bail!(
                "scheduled instruction `{instruction_name}` arg `{}` is not bound. \
                 Add `[instructions.{instruction_name}].args.{}` or \
                 `[[scheduled_actions]].args.{}`.",
                arg.name,
                arg.name,
                arg.name
            );
        }
        Ok(encoded)
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

fn parse_generic_trigger(trigger: &crate::adapter::PersonaTriggerDefinition) -> Result<Trigger> {
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

fn json_value_to_arg_literal(value: &serde_json::Value) -> Result<ArgLiteral> {
    match value {
        serde_json::Value::Bool(value) => Ok(ArgLiteral::Bool(*value)),
        serde_json::Value::Number(value) => {
            let Some(int) = value.as_i64() else {
                bail!("numeric value `{value}` is not a signed 64-bit integer")
            };
            Ok(ArgLiteral::Int(int))
        }
        serde_json::Value::String(value) => Ok(ArgLiteral::String(value.clone())),
        other => bail!("unsupported scheduled arg literal `{other}`"),
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
        GenericTypeRef::Primitive(name) if name == "u128" => {
            let value = literal_as_u128(literal, instruction_name, arg_name, "u128")?;
            out.extend_from_slice(&value.to_le_bytes());
            Ok(())
        }
        GenericTypeRef::Primitive(name) if name == "i128" => {
            let value = literal_as_i128(literal, instruction_name, arg_name, "i128")?;
            out.extend_from_slice(&value.to_le_bytes());
            Ok(())
        }
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
        GenericTypeRef::Primitive(name) if is_pubkey_type_name(name) => {
            let encoded = match literal {
                ArgLiteral::String(s) => bs58::decode(s).into_vec().map_err(|e| {
                    anyhow!(
                        "instruction `{instruction_name}` arg `{arg_name}` declared as `pubkey`/`publicKey` \
                         but literal `{s}` is not base58-decodable: {e}"
                    )
                })?,
                other => bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `pubkey`/`publicKey` \
                     but literal was `{other:?}`; expected a base58-encoded 32-byte key"
                ),
            };
            if encoded.len() != 32 {
                bail!(
                    "instruction `{instruction_name}` arg `{arg_name}` declared as `pubkey`/`publicKey` \
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
             u128/i128/u64/i64/u32/u8/bool/pubkey — Option, Vec, and user-defined structs \
             are out of scope."
        ),
    }
}

fn literal_as_u128(
    literal: &ArgLiteral,
    instruction_name: &str,
    arg_name: &str,
    target_ty: &str,
) -> Result<u128> {
    match literal {
        ArgLiteral::Int(v) if *v >= 0 => Ok(*v as u128),
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

fn literal_as_i128(
    literal: &ArgLiteral,
    instruction_name: &str,
    arg_name: &str,
    target_ty: &str,
) -> Result<i128> {
    match literal {
        ArgLiteral::Int(v) => Ok(i128::from(*v)),
        other => bail!(
            "instruction `{instruction_name}` arg `{arg_name}` declared as `{target_ty}` \
             but literal was `{other:?}`; expected an integer"
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

fn decode_struct(
    idl: &GenericIdl,
    fields: &[GenericField],
    cursor: &mut ByteCursor<'_>,
) -> Result<GenericValue> {
    let mut values = BTreeMap::new();
    for field in fields {
        values.insert(field.name.clone(), decode_value(idl, &field.ty, cursor)?);
    }
    Ok(GenericValue::Struct(values))
}

fn decode_value(
    idl: &GenericIdl,
    ty: &GenericTypeRef,
    cursor: &mut ByteCursor<'_>,
) -> Result<GenericValue> {
    match ty {
        GenericTypeRef::Primitive(name) if name == "u8" => {
            Ok(GenericValue::UInt(u64::from(cursor.read_u8()?)))
        }
        GenericTypeRef::Primitive(name) if name == "u16" => {
            Ok(GenericValue::UInt(u64::from(cursor.read_u16()?)))
        }
        GenericTypeRef::Primitive(name) if name == "u32" => {
            Ok(GenericValue::UInt(u64::from(cursor.read_u32()?)))
        }
        GenericTypeRef::Primitive(name) if name == "u64" => {
            Ok(GenericValue::UInt(cursor.read_u64()?))
        }
        GenericTypeRef::Primitive(name) if name == "u128" => {
            Ok(GenericValue::U128(cursor.read_u128()?))
        }
        GenericTypeRef::Primitive(name) if name == "i8" => {
            Ok(GenericValue::Int(i64::from(cursor.read_i8()?)))
        }
        GenericTypeRef::Primitive(name) if name == "i16" => {
            Ok(GenericValue::Int(i64::from(cursor.read_i16()?)))
        }
        GenericTypeRef::Primitive(name) if name == "i32" => {
            Ok(GenericValue::Int(i64::from(cursor.read_i32()?)))
        }
        GenericTypeRef::Primitive(name) if name == "i64" => {
            Ok(GenericValue::Int(cursor.read_i64()?))
        }
        GenericTypeRef::Primitive(name) if name == "i128" => {
            Ok(GenericValue::I128(cursor.read_i128()?))
        }
        GenericTypeRef::Primitive(name) if name == "bool" => {
            Ok(GenericValue::Bool(cursor.read_bool()?))
        }
        GenericTypeRef::Primitive(name) if is_pubkey_type_name(name) => {
            Ok(GenericValue::Pubkey(cursor.read_pubkey()?))
        }
        GenericTypeRef::Primitive(name) if name == "string" => {
            Ok(GenericValue::String(cursor.read_string()?))
        }
        GenericTypeRef::Vec { vec } => {
            let len = cursor.read_u32()? as usize;
            let mut items = Vec::with_capacity(len);
            for _ in 0..len {
                items.push(decode_value(idl, vec, cursor)?);
            }
            Ok(GenericValue::Vec(items))
        }
        GenericTypeRef::Defined { defined } => {
            let defined = defined.as_str();
            let defined_type = idl
                .types
                .iter()
                .find(|candidate| candidate.name == defined)
                .ok_or_else(|| anyhow!("generic IDL missing defined type `{defined}`"))?;
            decode_struct(idl, defined_type.fields(), cursor)
        }
        GenericTypeRef::Option { option } => {
            let tag = cursor.read_u8()?;
            match tag {
                0 => Ok(GenericValue::Option(None)),
                1 => Ok(GenericValue::Option(Some(Box::new(decode_value(
                    idl, option, cursor,
                )?)))),
                other => bail!("invalid option tag `{other}`"),
            }
        }
        GenericTypeRef::Array { array } => {
            let (item_ty, len) = array;
            if matches!(&**item_ty, GenericTypeRef::Primitive(name) if name == "u8") {
                return Ok(GenericValue::Bytes(cursor.read_vec(*len)?));
            }
            let mut items = Vec::with_capacity(*len);
            for _ in 0..*len {
                items.push(decode_value(idl, item_ty, cursor)?);
            }
            Ok(GenericValue::Vec(items))
        }
        other => bail!("unsupported generic field type `{other:?}`"),
    }
}

fn decode_layout_field(field: &LayoutField, bytes: &[u8]) -> Result<GenericValue> {
    let width = field
        .ty
        .byte_width()
        .ok_or_else(|| anyhow!("unknown layout field type `{}`", field.ty))?;
    let end = field.offset.checked_add(width).ok_or_else(|| {
        anyhow!(
            "layout field offset {} + size {width} overflows",
            field.offset
        )
    })?;
    if end > bytes.len() {
        bail!(
            "layout field offset {} with size {width} exceeds account data length {}",
            field.offset,
            bytes.len()
        );
    }
    let chunk = &bytes[field.offset..end];
    match &field.ty {
        LayoutFieldType::U8 => Ok(GenericValue::UInt(u64::from(chunk[0]))),
        LayoutFieldType::U64 => {
            let raw: [u8; 8] = chunk.try_into().expect("slice width checked");
            Ok(GenericValue::UInt(u64::from_le_bytes(raw)))
        }
        LayoutFieldType::U128 => {
            let raw: [u8; 16] = chunk.try_into().expect("slice width checked");
            Ok(GenericValue::U128(u128::from_le_bytes(raw)))
        }
        LayoutFieldType::I64 => {
            let raw: [u8; 8] = chunk.try_into().expect("slice width checked");
            Ok(GenericValue::Int(i64::from_le_bytes(raw)))
        }
        LayoutFieldType::I128 => {
            let raw: [u8; 16] = chunk.try_into().expect("slice width checked");
            Ok(GenericValue::I128(i128::from_le_bytes(raw)))
        }
        LayoutFieldType::Bool => Ok(GenericValue::Bool(chunk[0] != 0)),
        LayoutFieldType::Pubkey => {
            let raw: [u8; 32] = chunk.try_into().expect("slice width checked");
            Ok(GenericValue::Pubkey(bs58::encode(raw).into_string()))
        }
        LayoutFieldType::Unknown(raw) => bail!("unknown layout field type `{raw}`"),
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
        if let Some(value) = self.wrapped_i80f48_integer()? {
            return match expected {
                ObservationType::Int => {
                    let narrowed = i64::try_from(value).map_err(|_| {
                        anyhow!("generic WrappedI80F48 value `{value}` does not fit i64")
                    })?;
                    Ok(ObservationValue::Int(narrowed))
                }
                ObservationType::UInt => {
                    let narrowed = u64::try_from(value).map_err(|_| {
                        anyhow!(
                            "generic WrappedI80F48 value `{value}` is negative or does not fit u64"
                        )
                    })?;
                    Ok(ObservationValue::UInt(narrowed))
                }
                _ => bail!(
                    "generic observation type mismatch; expected `{expected:?}`, got `{self:?}`"
                ),
            };
        }
        match (self, expected) {
            (GenericValue::Int(value), ObservationType::Int) => Ok(ObservationValue::Int(*value)),
            (GenericValue::I128(value), ObservationType::Int) => {
                let narrowed = i64::try_from(*value).map_err(|_| {
                    anyhow!("generic i128 observation value `{value}` does not fit i64")
                })?;
                Ok(ObservationValue::Int(narrowed))
            }
            (GenericValue::UInt(value), ObservationType::UInt) => {
                Ok(ObservationValue::UInt(*value))
            }
            (GenericValue::U128(value), ObservationType::UInt) => {
                let narrowed = u64::try_from(*value).map_err(|_| {
                    anyhow!("generic u128 observation value `{value}` does not fit u64")
                })?;
                Ok(ObservationValue::UInt(narrowed))
            }
            (GenericValue::Bool(value), ObservationType::Bool) => {
                Ok(ObservationValue::Bool(*value))
            }
            (GenericValue::Pubkey(value), ObservationType::Pubkey) => {
                Ok(ObservationValue::Pubkey(value.clone()))
            }
            (GenericValue::Vec(values), ObservationType::Map) => vec_to_map(values),
            _ => {
                bail!("generic observation type mismatch; expected `{expected:?}`, got `{self:?}`")
            }
        }
    }

    fn wrapped_i80f48_integer(&self) -> Result<Option<i128>> {
        let GenericValue::Struct(fields) = self else {
            return Ok(None);
        };
        let Some(GenericValue::Bytes(bytes)) = fields.get("value") else {
            return Ok(None);
        };
        if bytes.len() != 16 {
            bail!(
                "generic WrappedI80F48 value field has {} bytes; expected 16",
                bytes.len()
            );
        }
        let mut raw = [0u8; 16];
        raw.copy_from_slice(bytes);
        Ok(Some(i128::from_le_bytes(raw) >> 48))
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

    fn skip(&mut self, len: usize) -> Result<()> {
        if self.offset + len > self.bytes.len() {
            bail!("unexpected end of account data");
        }
        self.offset += len;
        Ok(())
    }

    fn read_vec(&mut self, len: usize) -> Result<Vec<u8>> {
        if self.offset + len > self.bytes.len() {
            bail!("unexpected end of account data");
        }
        let out = self.bytes[self.offset..self.offset + len].to_vec();
        self.offset += len;
        Ok(out)
    }

    fn read_u8(&mut self) -> Result<u8> {
        Ok(self.read_exact::<1>()?[0])
    }

    fn read_u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.read_exact()?))
    }

    fn read_u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.read_exact()?))
    }

    fn read_u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.read_exact()?))
    }

    fn read_u128(&mut self) -> Result<u128> {
        Ok(u128::from_le_bytes(self.read_exact()?))
    }

    fn read_i8(&mut self) -> Result<i8> {
        Ok(i8::from_le_bytes(self.read_exact()?))
    }

    fn read_i16(&mut self) -> Result<i16> {
        Ok(i16::from_le_bytes(self.read_exact()?))
    }

    fn read_i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.read_exact()?))
    }

    fn read_i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.read_exact()?))
    }

    fn read_i128(&mut self) -> Result<i128> {
        Ok(i128::from_le_bytes(self.read_exact()?))
    }

    fn read_bool(&mut self) -> Result<bool> {
        Ok(self.read_exact::<1>()?[0] != 0)
    }

    fn read_pubkey(&mut self) -> Result<String> {
        Ok(bs58::encode(self.read_exact::<32>()?).into_string())
    }

    fn read_string(&mut self) -> Result<String> {
        let len = self.read_u32()? as usize;
        let bytes = self.read_vec(len)?;
        String::from_utf8(bytes).context("decode borsh string")
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
    /// oracle binding (perpetuals, amm) keep their byte-identical
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
    pub(crate) confidence: Option<u64>,
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

        let program_id = resolve_generic_program_id(
            &config.program_so,
            config.adapter.program_id.as_deref(),
            idl.address.as_deref(),
        )?;
        svm.add_program(program_id, &program_bytes)
            .map_err(|error| anyhow!("failed to load generic program into LiteSVM: {error}"))?;

        let admin = Keypair::new();
        generic_airdrop(&mut svm, &admin.pubkey(), per_identity_lamports)?;

        let agents: Vec<Keypair> = (0..config.agent_count).map(|_| Keypair::new()).collect();
        for agent in &agents {
            generic_airdrop(&mut svm, &agent.pubkey(), per_identity_lamports)?;
        }

        let agent_pubkeys: Vec<Pubkey> = agents.iter().map(|agent| agent.pubkey()).collect();
        let (agent_accounts, shared_accounts, oracle_binding) = bootstrap_generic_accounts(
            &mut svm,
            &config.adapter,
            config.agent_count,
            &program_id,
            &admin.pubkey(),
            &agent_pubkeys,
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
    pub fn inspect_agent_account_pubkey(&self, name: &str, agent_idx: usize) -> Option<Pubkey> {
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
    /// `close_position` on `perpetuals`, which are intentionally not
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

    /// Adapter definition backing this generic harness. Harness setup
    /// code uses this for diagnostics and for validating that generated
    /// account helpers refer to declared adapter accounts.
    pub fn adapter(&self) -> &Adapter {
        &self.adapter
    }

    /// Bind or replace a shared adapter account pubkey. The account
    /// name must already exist under `[accounts]`; harnesses can move
    /// declared bindings to deterministic pubkeys, but cannot create
    /// untracked instruction aliases outside the adapter contract.
    pub fn bind_shared_account(&mut self, name: &str, pubkey: Pubkey) -> Result<()> {
        let definition = self.adapter.accounts.get(name).ok_or_else(|| {
            anyhow!(
                "cannot bind undeclared harness account `{name}`. Add `[accounts.{name}]` \
                 to the adapter before binding it in Rust setup."
            )
        })?;
        if !matches!(definition.kind, AccountKind::Shared) {
            bail!(
                "cannot bind `{name}` as a shared harness account because the adapter declares \
                 it as `kind = \"agent\"`; use bind_agent_accounts instead"
            );
        }
        self.shared_accounts.insert(name.to_string(), pubkey);
        Ok(())
    }

    /// Bind or replace every per-agent pubkey for an adapter account.
    /// The number of pubkeys must match the configured agent count so
    /// instruction dispatch never sees a partially-bound population.
    pub fn bind_agent_accounts(&mut self, name: &str, pubkeys: Vec<Pubkey>) -> Result<()> {
        let definition = self.adapter.accounts.get(name).ok_or_else(|| {
            anyhow!(
                "cannot bind undeclared harness account `{name}`. Add `[accounts.{name}]` \
                 to the adapter before binding it in Rust setup."
            )
        })?;
        if !matches!(definition.kind, AccountKind::Agent) {
            bail!(
                "cannot bind `{name}` as agent-scoped harness accounts because the adapter \
                 declares it as `kind = \"shared\"`; use bind_shared_account instead"
            );
        }
        if pubkeys.len() != self.agents.len() {
            bail!(
                "cannot bind agent account `{name}`: got {} pubkey(s), expected {} \
                 (one per simulated agent)",
                pubkeys.len(),
                self.agents.len()
            );
        }
        self.agent_accounts.insert(name.to_string(), pubkeys);
        Ok(())
    }

    /// Bind replay/bootstrap-imported accounts into the same name
    /// registry instruction dispatch uses. This lets a fixture pack
    /// provide `reserve`, `obligation`, `price_update_v2`, etc. at
    /// concrete pubkeys instead of forcing every imported account to
    /// have been generated by the generic bootstrap.
    pub fn bind_imported_account(&mut self, name: &str, pubkeys: Vec<Pubkey>) -> Result<()> {
        if pubkeys.is_empty() {
            bail!("cannot bind imported account `{name}`: no pubkeys supplied");
        }
        let definition = self.adapter.accounts.get(name).ok_or_else(|| {
            anyhow!(
                "cannot bind undeclared imported account `{name}` into generic dispatch. \
                 Replay/state-pack roles must name an adapter-declared `[accounts.{name}]` \
                 binding; imported accounts may hydrate declared bindings but may not create \
                 new dispatch aliases."
            )
        })?;
        match definition.kind {
            AccountKind::Agent => {
                if pubkeys.len() != self.agents.len() {
                    bail!(
                        "cannot bind imported agent account `{name}`: got {} account(s), \
                         expected {} (one per simulated agent)",
                        pubkeys.len(),
                        self.agents.len()
                    );
                }
                if let Some(existing) = self.agent_accounts.get(name) {
                    if existing != &pubkeys {
                        bail!(
                            "cannot override declared agent account binding `{name}` from \
                             replay import: adapter/bootstrap resolved {:?}, import supplied {:?}",
                            existing,
                            pubkeys
                        );
                    }
                } else {
                    self.agent_accounts.insert(name.to_string(), pubkeys);
                }
            }
            AccountKind::Shared => {
                if pubkeys.len() != 1 {
                    bail!(
                        "cannot bind imported shared account `{name}`: got {} accounts, \
                         expected exactly one",
                        pubkeys.len()
                    );
                }
                if is_well_known_readonly_account(definition.address.as_deref(), &pubkeys[0]) {
                    bail!(
                        "cannot import replay account `{name}` at well-known readonly address {}; \
                         program/sysvar accounts are resolved from adapter literals and may not be \
                         hydrated from fixture state",
                        pubkeys[0]
                    );
                }
                if let Some(existing) = self.shared_accounts.get(name) {
                    if *existing != pubkeys[0] {
                        bail!(
                            "cannot override declared shared account binding `{name}` from \
                             replay import: adapter/bootstrap resolved {}, import supplied {}",
                            existing,
                            pubkeys[0]
                        );
                    }
                } else {
                    self.shared_accounts.insert(name.to_string(), pubkeys[0]);
                }
            }
        }
        Ok(())
    }

    pub fn replay_account_name_for_role(&self, role: &str) -> Result<String> {
        let Some(semantics) = self.adapter.semantics.as_ref() else {
            return Ok(role.to_string());
        };
        let Some(role_def) = semantics.roles.get(role) else {
            return Ok(role.to_string());
        };
        match role_def.binding.as_ref() {
            Some(SemanticSourceBinding::Account(account)) => Ok(account.clone()),
            Some(SemanticSourceBinding::Instruction(instruction)) => bail!(
                "cannot import replay role `{role}` from instruction source `{instruction}`; \
                 replay state imports require `[semantics.roles.{role}].source = \"account.<name>\"`"
            ),
            None => Ok(role.to_string()),
        }
    }

    fn resolve_account_meta(
        &self,
        instruction_name: &str,
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
        } else if let Some(address) = account.address.as_deref() {
            literal_or_well_known_pubkey(address).with_context(|| {
                format!(
                    "generic instruction `{instruction_name}` account `{}` declares IDL \
                     address `{address}` but it could not be resolved",
                    account.name
                )
            })?
        } else if let Ok(pubkey) = well_known_pubkey(&account.name) {
            pubkey
        } else if account.signer && is_admin_authority_signer_name(&account.name) {
            self.admin.pubkey()
        } else if account.signer && is_agent_authority_signer_name(&account.name) {
            self.agents
                .get(agent_idx)
                .ok_or_else(|| anyhow!("generic agent signer index {agent_idx} out of range"))?
                .pubkey()
        } else {
            let mut known: Vec<String> = self
                .agent_accounts
                .keys()
                .chain(self.shared_accounts.keys())
                .cloned()
                .collect();
            known.push("admin".into());
            known.push("admin_authority".into());
            known.push("authority".into());
            known.push("agent".into());
            known.push("agent_authority".into());
            known.push("manager_authority".into());
            known.push("owner".into());
            known.push("payer".into());
            known.push("token_authority".into());
            known.push("trader".into());
            known.push("user".into());
            known.push("user_authority".into());
            known.sort();
            known.dedup();
            bail!(
                "MissingGenericAccountBinding(instruction={instruction_name}, account={}); \
                 IDL requires signer={} writable={}, but `{}` is not declared under \
                 `[accounts]`, not a recognized signer (`admin`, `authority`, `agent`, \
                 `admin_authority`, `agent_authority`, `manager_authority`, `owner`, \
                 `payer`, `token_authority`, `trader`, `user`, or `user_authority`), \
                 and not a well-known program/sysvar account. Known bindings/signers: {:?}.",
                account.name,
                account.signer,
                account.writable,
                account.name,
                known,
            );
        };

        Ok(if account.writable {
            AccountMeta::new(pubkey, account.signer)
        } else {
            AccountMeta::new_readonly(pubkey, account.signer)
        })
    }

    fn oracle_kind_for_pubkey(&self, pubkey: &Pubkey) -> Option<OracleKind> {
        self.adapter.oracles.iter().find_map(|oracle| {
            let account_name = oracle.account.as_deref()?;
            let bound = self.shared_accounts.get(account_name)?;
            (*bound == *pubkey).then_some(oracle.kind)
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
            .any(|account| account.signer && is_admin_authority_signer_name(&account.name))
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
        self.svm.expire_blockhash();
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
                other => Err(crate::primitive::PrimitiveError::Infra(format!(
                    "{other:?}"
                ))),
            },
        }
    }

    fn account_bytes(
        &self,
        pubkey: &Pubkey,
        account_name: &str,
    ) -> Result<Vec<u8>, crate::primitive::PrimitiveError> {
        let account = self.svm.get_account(pubkey).ok_or_else(|| {
            crate::primitive::PrimitiveError::Infra(format!(
                "generic account `{account_name}` ({pubkey}) not found"
            ))
        })?;
        Ok(account.data)
    }

    fn current_unix_timestamp(&self) -> i64 {
        i64::try_from(self.current_slot).unwrap_or(i64::MAX)
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
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.slot = self.current_slot;
        clock.unix_timestamp = self.current_unix_timestamp();
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
    }

    /// Write a new oracle value into the adapter-declared shared oracle
    /// account through the real layout dispatcher.
    ///
    /// - Adapters with no `[[oracles]]` block keep the trait's no-op
    ///   semantics (preserves the shipped `perpetuals.toml` /
    ///   `amm.toml` scratch-gate hashes).
    /// - Adapters that declared one oracle reach this path on every
    ///   tick: encode through `oracle_layout_for(kind)`, write into the
    ///   bound shared account via `svm.set_account`, then decode the
    ///   post-write bytes to verify the layout round-trips. Owner and
    ///   lamports are preserved so a sibling-program-owned oracle stays
    ///   readable by programs that enforce owner checks.
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
        let context = OracleEncodeContext::new(
            self.admin.pubkey().to_bytes(),
            self.current_slot,
            self.current_unix_timestamp(),
        )
        .with_confidence(binding.confidence);
        let encoded = layout
            .encode_with_context(&context, update)
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
            .map_err(|error| {
                crate::primitive::PrimitiveError::ProgramRejected(error.to_string())
            })?;
        let data = GenericInstructionBuilder::new(&self.idl, &self.adapter)
            .build_action_data(action, amount, persona_args)
            .map_err(|error| {
                crate::primitive::PrimitiveError::ProgramRejected(error.to_string())
            })?;
        let accounts = instruction
            .accounts
            .iter()
            .map(|account| self.resolve_account_meta(&instruction.name, agent_idx, account))
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

    fn action_event_params(
        &self,
        action: &str,
        amount: u64,
        persona_args: &BTreeMap<String, crate::adapter::ArgLiteral>,
    ) -> BTreeMap<String, serde_json::Value> {
        crate::primitive::lending::default_action_event_params(action, amount, persona_args)
    }

    fn on_scheduled_action(
        &mut self,
        _name: &str,
        instruction_name: &str,
        _accounts: &[String],
        args: &BTreeMap<String, serde_json::Value>,
    ) -> Result<(), crate::primitive::PrimitiveError> {
        let builder = GenericInstructionBuilder::new(&self.idl, &self.adapter);
        let instruction = self
            .idl
            .instructions
            .iter()
            .find(|instruction| instruction.name == instruction_name)
            .ok_or_else(|| {
                crate::primitive::PrimitiveError::ProgramRejected(format!(
                    "generic scheduled instruction `{instruction_name}` not found in IDL"
                ))
            })?;
        let data = builder
            .build_scheduled_data(instruction_name, args)
            .map_err(|error| {
                crate::primitive::PrimitiveError::ProgramRejected(error.to_string())
            })?;
        let accounts = instruction
            .accounts
            .iter()
            .map(|account| self.resolve_account_meta(&instruction.name, 0, account))
            .collect::<Result<Vec<_>>>()
            .map_err(|error| crate::primitive::PrimitiveError::Infra(error.to_string()))?;
        let payer = self
            .payer_for_instruction(0, instruction)
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
            .map_err(|error| {
                crate::primitive::PrimitiveError::ProgramRejected(error.to_string())
            })?;
        let data = builder.build_replay_data(action, args).map_err(|error| {
            crate::primitive::PrimitiveError::ProgramRejected(error.to_string())
        })?;
        let accounts = instruction
            .accounts
            .iter()
            .map(|account| self.resolve_account_meta(&instruction.name, agent_idx, account))
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
            if !adapter_account_has_observation_sources(&self.adapter, account_name) {
                continue;
            }
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
            if !adapter_account_has_observation_sources(&self.adapter, account_name) {
                continue;
            }
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

    fn semantic_oracle_account_owner(
        &self,
        account_pubkey: &str,
    ) -> Result<Option<String>, crate::primitive::PrimitiveError> {
        let pubkey = account_pubkey.parse::<Pubkey>().map_err(|error| {
            crate::primitive::PrimitiveError::Infra(format!(
                "semantic oracle account `{account_pubkey}` is not a valid pubkey: {error}"
            ))
        })?;
        Ok(self
            .svm
            .get_account(&pubkey)
            .map(|account| account.owner.to_string()))
    }

    fn semantic_oracle_observation(
        &self,
        account_pubkey: &str,
    ) -> Result<Option<crate::primitive::SemanticOracleObservation>, crate::primitive::PrimitiveError>
    {
        let pubkey = account_pubkey.parse::<Pubkey>().map_err(|error| {
            crate::primitive::PrimitiveError::Infra(format!(
                "semantic oracle account `{account_pubkey}` is not a valid pubkey: {error}"
            ))
        })?;
        let Some(account) = self.svm.get_account(&pubkey) else {
            return Ok(None);
        };
        let kind = self.oracle_kind_for_pubkey(&pubkey).ok_or_else(|| {
            crate::primitive::PrimitiveError::Infra(format!(
                "semantic oracle account `{account_pubkey}` exists but no generic `[[oracles]]` \
                 binding resolves to that pubkey. Declare a generic `[[oracles]]` entry whose \
                 `account` names the shared account for this semantic oracle."
            ))
        })?;
        let decoded =
            oracle_layout_for(kind)
                .decode_observation(&account.data)
                .map_err(|error| {
                    crate::primitive::PrimitiveError::Infra(format!(
                        "semantic oracle account `{account_pubkey}` failed to decode as {kind:?}: {error}"
                    ))
                })?;
        let price = f64_to_u128_generic(decoded.price).ok_or_else(|| {
            crate::primitive::PrimitiveError::Infra(format!(
                "semantic oracle account `{account_pubkey}` decoded non-finite price {}",
                decoded.price
            ))
        })?;
        let (confidence, staleness) = match kind {
            OracleKind::AdminMock => (0, 0),
        };
        Ok(Some(crate::primitive::SemanticOracleObservation {
            price,
            confidence,
            staleness,
            exponent: i128::from(decoded.exponent),
        }))
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
            per_agent.push(<Self as crate::primitive::Primitive>::observation_values(
                self, idx,
            )?);
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
                crate::adapter::ObservationType::Int | crate::adapter::ObservationType::UInt => {
                    let numeric: Vec<f64> = column.iter().filter_map(|v| v.as_f64()).collect();
                    if numeric.is_empty() {
                        continue;
                    }
                    let avg = numeric.iter().sum::<f64>() / (numeric.len() as f64);
                    let min = numeric.iter().copied().fold(f64::INFINITY, f64::min);
                    let max = numeric.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                    summary.insert(format!("{key}_avg"), json_f64_gen(avg));
                    summary.insert(format!("{key}_max"), json_f64_gen(max));
                    summary.insert(format!("{key}_min"), json_f64_gen(min));
                }
                crate::adapter::ObservationType::Bool => {
                    let true_count: u64 = column.iter().filter_map(|v| v.as_u64()).sum();
                    // Each tick's column value is the number of agents
                    // with `true`. `false_count` = agents*ticks - trues.
                    let total_cells =
                        (self.agents.len() as u64).saturating_mul(column.len() as u64);
                    let false_count = total_cells.saturating_sub(true_count);
                    summary.insert(format!("{key}_true_count"), serde_json::json!(true_count));
                    summary.insert(format!("{key}_false_count"), serde_json::json!(false_count));
                }
                crate::adapter::ObservationType::Pubkey => {
                    let max_unique: u64 =
                        column.iter().filter_map(|v| v.as_u64()).max().unwrap_or(0);
                    summary.insert(format!("{key}_unique_count"), serde_json::json!(max_unique));
                }
                crate::adapter::ObservationType::Map => {
                    let numeric: Vec<f64> = column.iter().filter_map(|v| v.as_f64()).collect();
                    if numeric.is_empty() {
                        continue;
                    }
                    let avg = numeric.iter().sum::<f64>() / (numeric.len() as f64);
                    let max = numeric.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                    summary.insert(format!("{key}_entry_count_avg"), json_f64_gen(avg));
                    summary.insert(format!("{key}_entry_count_max"), json_f64_gen(max));
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
fn adapter_account_has_observation_sources(adapter: &Adapter, account_name: &str) -> bool {
    let prefix = format!("{account_name}.");
    if adapter
        .state_mapping
        .keys()
        .any(|source| source.starts_with(&prefix))
    {
        return true;
    }
    adapter
        .semantics
        .as_ref()
        .map(|semantics| {
            semantics.roles.values().any(|role| {
                matches!(
                    role.binding.as_ref(),
                    Some(SemanticSourceBinding::Account(source)) if source == account_name
                )
            })
        })
        .unwrap_or(false)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn json_f64_gen(value: f64) -> serde_json::Value {
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn f64_to_u128_generic(value: f64) -> Option<u128> {
    if value.is_finite() && value >= 0.0 && value <= u128::MAX as f64 {
        Some(value.round() as u128)
    } else {
        None
    }
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
    agent_signers: &[Pubkey],
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
                confidence: oracle.confidence,
                update: OracleUpdate {
                    price: oracle.base_price,
                    exponent: oracle.exponent,
                },
            })
        }
        None => None,
    };

    let (agent_accounts, shared_accounts) =
        resolve_generic_account_pubkeys(adapter, agent_count, program_id, admin, agent_signers)?;

    for (account_name, definition) in &adapter.accounts {
        let lamports = svm.minimum_balance_for_rent_exemption(definition.space);
        match definition.kind {
            AccountKind::Agent => {
                let owner = resolve_shared_account_owner(account_name, definition, program_id)?;
                let pubkeys = agent_accounts.get(account_name).ok_or_else(|| {
                    anyhow!("bootstrap invariant: agent account `{account_name}` was not resolved")
                })?;
                for (idx, pubkey) in pubkeys.iter().enumerate() {
                    let signer = agent_signers.get(idx).copied();
                    let data = bootstrap_generic_account_data(
                        adapter,
                        account_name,
                        definition,
                        &owner,
                        admin,
                        signer.as_ref(),
                        &shared_accounts,
                    )?;
                    svm.set_account(
                        *pubkey,
                        Account {
                            lamports,
                            data,
                            owner,
                            ..Default::default()
                        },
                    )
                    .map_err(|error| {
                        anyhow!(
                            "create generic agent account `{account_name}` for {pubkey}: {error}"
                        )
                    })?;
                }
            }
            AccountKind::Shared => {
                let pubkey = *shared_accounts.get(account_name).ok_or_else(|| {
                    anyhow!("bootstrap invariant: shared account `{account_name}` was not resolved")
                })?;
                if is_well_known_readonly_account(definition.address.as_deref(), &pubkey) {
                    continue;
                }
                let is_oracle = oracle_binding
                    .as_ref()
                    .is_some_and(|binding| binding.account_name == *account_name);
                let owner = if is_oracle {
                    resolve_shared_account_owner(account_name, definition, program_id)?
                } else {
                    resolve_shared_account_owner(account_name, definition, program_id)?
                };
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
                    let context = OracleEncodeContext::new(admin.to_bytes(), 0, 0)
                        .with_confidence(binding.confidence);
                    let mut buf = binding
                        .layout
                        .encode_with_context(&context, &binding.update)
                        .with_context(|| {
                            format!(
                                "encode tick-0 oracle bytes for generic adapter oracle \
                                 account `{account_name}`"
                            )
                        })?;
                    buf.resize(definition.space, 0);
                    buf
                } else {
                    bootstrap_generic_account_data(
                        adapter,
                        account_name,
                        definition,
                        &owner,
                        admin,
                        None,
                        &shared_accounts,
                    )?
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
            }
        }
    }

    let runtime_binding = oracle_binding.map(|binding| RuntimeOracleBinding {
        account_name: binding.account_name,
        kind: binding.kind,
        confidence: binding.confidence,
    });
    Ok((agent_accounts, shared_accounts, runtime_binding))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn resolve_generic_account_pubkeys(
    adapter: &Adapter,
    agent_count: usize,
    program_id: &Pubkey,
    admin: &Pubkey,
    agent_signers: &[Pubkey],
) -> Result<(BTreeMap<String, Vec<Pubkey>>, BTreeMap<String, Pubkey>)> {
    if agent_signers.len() != agent_count {
        bail!(
            "generic account resolution expected {agent_count} agent signer pubkeys, got {}",
            agent_signers.len()
        );
    }
    let mut agent_accounts: BTreeMap<String, Vec<Pubkey>> = BTreeMap::new();
    let mut shared_accounts: BTreeMap<String, Pubkey> = BTreeMap::new();
    let mut pending: std::collections::BTreeSet<String> =
        adapter.accounts.keys().cloned().collect();

    while !pending.is_empty() {
        let mut progressed = false;
        let names: Vec<String> = pending.iter().cloned().collect();
        for account_name in names {
            let definition = adapter
                .accounts
                .get(&account_name)
                .expect("pending account came from adapter.accounts");
            match definition.kind {
                AccountKind::Shared => {
                    let Some(pubkey) = resolve_shared_account_pubkey(
                        &account_name,
                        definition,
                        program_id,
                        admin,
                        agent_signers,
                        &agent_accounts,
                        &shared_accounts,
                    )?
                    else {
                        continue;
                    };
                    shared_accounts.insert(account_name.clone(), pubkey);
                }
                AccountKind::Agent => {
                    let Some(pubkeys) = resolve_agent_account_pubkeys(
                        &account_name,
                        definition,
                        agent_count,
                        program_id,
                        admin,
                        agent_signers,
                        &agent_accounts,
                        &shared_accounts,
                    )?
                    else {
                        continue;
                    };
                    agent_accounts.insert(account_name.clone(), pubkeys);
                }
            }
            pending.remove(&account_name);
            progressed = true;
        }

        if !progressed {
            let unresolved: Vec<String> = pending.into_iter().collect();
            bail!(
                "generic account PDA bindings could not be resolved; unresolved accounts: \
                 {unresolved:?}. Check for cyclic `account:<name>` PDA seeds or references \
                 to accounts that are not declared before they are needed."
            );
        }
    }

    Ok((agent_accounts, shared_accounts))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn resolve_shared_account_pubkey(
    account_name: &str,
    definition: &AccountDefinition,
    program_id: &Pubkey,
    admin: &Pubkey,
    agent_signers: &[Pubkey],
    agent_accounts: &BTreeMap<String, Vec<Pubkey>>,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Option<Pubkey>> {
    if let Some(address) = definition.address.as_deref() {
        return literal_or_well_known_pubkey(address)
            .map(Some)
            .with_context(|| format!("resolve address for shared account `{account_name}`"));
    }
    if let Some(pda) = definition.pda.as_ref() {
        return resolve_pda_pubkey(
            account_name,
            pda,
            None,
            program_id,
            admin,
            agent_signers,
            agent_accounts,
            shared_accounts,
        );
    }
    Ok(Some(Pubkey::new_unique()))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn resolve_agent_account_pubkeys(
    account_name: &str,
    definition: &AccountDefinition,
    agent_count: usize,
    program_id: &Pubkey,
    admin: &Pubkey,
    agent_signers: &[Pubkey],
    agent_accounts: &BTreeMap<String, Vec<Pubkey>>,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Option<Vec<Pubkey>>> {
    if definition.address.is_some() {
        bail!(
            "agent account `{account_name}` declares a literal `address`; literal addresses \
             are shared by definition. Use `kind = \"shared\"` or declare a per-agent PDA."
        );
    }
    let Some(pda) = definition.pda.as_ref() else {
        return Ok(Some(
            (0..agent_count).map(|_| Pubkey::new_unique()).collect(),
        ));
    };
    let mut pubkeys = Vec::with_capacity(agent_count);
    for agent_idx in 0..agent_count {
        let Some(pubkey) = resolve_pda_pubkey(
            account_name,
            pda,
            Some(agent_idx),
            program_id,
            admin,
            agent_signers,
            agent_accounts,
            shared_accounts,
        )?
        else {
            return Ok(None);
        };
        pubkeys.push(pubkey);
    }
    Ok(Some(pubkeys))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn resolve_pda_pubkey(
    account_name: &str,
    pda: &crate::adapter::PdaDefinition,
    agent_idx: Option<usize>,
    program_id: &Pubkey,
    admin: &Pubkey,
    agent_signers: &[Pubkey],
    agent_accounts: &BTreeMap<String, Vec<Pubkey>>,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Option<Pubkey>> {
    let mut seeds: Vec<Vec<u8>> = Vec::with_capacity(pda.seeds.len());
    for seed in &pda.seeds {
        let Some(bytes) = resolve_pda_seed(
            account_name,
            seed,
            agent_idx,
            program_id,
            admin,
            agent_signers,
            agent_accounts,
            shared_accounts,
        )?
        else {
            return Ok(None);
        };
        if bytes.len() > 32 {
            bail!(
                "PDA seed `{seed}` for account `{account_name}` is {} bytes; Solana PDA \
                 seeds must be at most 32 bytes",
                bytes.len()
            );
        }
        seeds.push(bytes);
    }
    let program = match pda.program.as_deref() {
        Some(value) => resolve_pda_program(value, program_id)?,
        None => *program_id,
    };
    let seed_refs: Vec<&[u8]> = seeds.iter().map(Vec::as_slice).collect();
    let (pubkey, _) = Pubkey::find_program_address(&seed_refs, &program);
    Ok(Some(pubkey))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn resolve_pda_seed(
    account_name: &str,
    seed: &str,
    agent_idx: Option<usize>,
    program_id: &Pubkey,
    admin: &Pubkey,
    agent_signers: &[Pubkey],
    agent_accounts: &BTreeMap<String, Vec<Pubkey>>,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Option<Vec<u8>>> {
    let Some((kind, value)) = seed.split_once(':') else {
        bail!("PDA seed `{seed}` for account `{account_name}` is missing a prefix");
    };
    match kind {
        "literal" => Ok(Some(value.as_bytes().to_vec())),
        "pubkey" => Ok(Some(
            Pubkey::from_str(value)
                .with_context(|| {
                    format!("PDA seed `{seed}` for account `{account_name}` is not a pubkey")
                })?
                .to_bytes()
                .to_vec(),
        )),
        "program" => Ok(Some(
            resolve_pda_program(value, program_id)?.to_bytes().to_vec(),
        )),
        "signer" => match value {
            "admin" => Ok(Some(admin.to_bytes().to_vec())),
            "agent" => {
                let Some(idx) = agent_idx else {
                    bail!(
                        "PDA seed `signer:agent` cannot be used for shared account \
                         `{account_name}`; only agent-scoped accounts have an agent signer"
                    );
                };
                let signer = agent_signers.get(idx).ok_or_else(|| {
                    anyhow!(
                        "PDA seed `signer:agent` for account `{account_name}` references \
                         agent index {idx}, but only {} signer pubkeys exist",
                        agent_signers.len()
                    )
                })?;
                Ok(Some(signer.to_bytes().to_vec()))
            }
            _ => bail!("unsupported PDA signer seed `{seed}` for account `{account_name}`"),
        },
        "account" => {
            if let Some(pubkey) = literal_or_well_known_pubkey(value).ok() {
                return Ok(Some(pubkey.to_bytes().to_vec()));
            }
            if let Some(pubkey) = shared_accounts.get(value) {
                return Ok(Some(pubkey.to_bytes().to_vec()));
            }
            if let Some(pubkeys) = agent_accounts.get(value) {
                let Some(idx) = agent_idx else {
                    bail!(
                        "PDA seed `account:{value}` for shared account `{account_name}` \
                         references agent-scoped account `{value}`"
                    );
                };
                let pubkey = pubkeys.get(idx).ok_or_else(|| {
                    anyhow!(
                        "PDA seed `account:{value}` for account `{account_name}` references \
                         agent index {idx}, but `{value}` only has {} accounts",
                        pubkeys.len()
                    )
                })?;
                return Ok(Some(pubkey.to_bytes().to_vec()));
            }
            Ok(None)
        }
        _ => bail!("unsupported PDA seed `{seed}` for account `{account_name}`"),
    }
}

#[cfg(any(feature = "litesvm-backend", test))]
fn resolve_pda_program(value: &str, program_id: &Pubkey) -> Result<Pubkey> {
    if value == "self" {
        return Ok(*program_id);
    }
    literal_or_well_known_pubkey(value)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn bootstrap_generic_account_data(
    adapter: &Adapter,
    account_name: &str,
    definition: &AccountDefinition,
    owner: &Pubkey,
    admin: &Pubkey,
    agent_signer: Option<&Pubkey>,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Vec<u8>> {
    if is_lending_v1_adapter(adapter) && !is_spl_token_program(owner) {
        if let Some(data) = bootstrap_lending_v1_account_data(
            account_name,
            definition,
            owner,
            admin,
            agent_signer,
            shared_accounts,
        )? {
            return Ok(data);
        }
    }
    if !is_spl_token_program(owner) {
        return Ok(vec![0u8; definition.space]);
    }
    match definition.space {
        82 => {
            let mint_authority = if account_name == "receipt_mint" {
                shared_accounts.get("reserve").copied().unwrap_or(*admin)
            } else {
                *admin
            };
            Ok(spl_token_mint_data(mint_authority, 1_000_000_000_000, 6))
        }
        165 => {
            let mint = token_account_mint(account_name, shared_accounts).ok_or_else(|| {
                anyhow!(
                    "cannot bootstrap SPL token account `{account_name}`: no mint binding found"
                )
            })?;
            let authority = if account_name.contains("reserve") {
                shared_accounts.get("reserve").copied().ok_or_else(|| {
                    anyhow!(
                        "cannot bootstrap SPL token account `{account_name}`: missing reserve account"
                    )
                })?
            } else {
                agent_signer.copied().unwrap_or(*admin)
            };
            Ok(spl_token_account_data(mint, authority, 1_000_000_000_000))
        }
        _ => Ok(vec![0u8; definition.space]),
    }
}

#[cfg(any(feature = "litesvm-backend", test))]
fn is_lending_v1_adapter(adapter: &Adapter) -> bool {
    adapter.semantics.as_ref().is_some_and(|semantics| {
        semantics.class_ref == Some(SemanticClassRef::LendingV1)
            || semantics.class.as_deref() == Some("lending.v1")
    })
}

#[cfg(any(feature = "litesvm-backend", test))]
fn bootstrap_lending_v1_account_data(
    account_name: &str,
    definition: &AccountDefinition,
    program_id: &Pubkey,
    admin: &Pubkey,
    agent_signer: Option<&Pubkey>,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Option<Vec<u8>>> {
    match account_name {
        "market" => bootstrap_chiefwoods_market_data(definition, program_id, admin).map(Some),
        "reserve" => {
            bootstrap_chiefwoods_reserve_data(definition, program_id, shared_accounts).map(Some)
        }
        "obligation" => {
            let Some(agent_signer) = agent_signer else {
                return Ok(None);
            };
            bootstrap_chiefwoods_obligation_data(definition, agent_signer, shared_accounts)
                .map(Some)
        }
        _ => Ok(None),
    }
}

#[cfg(any(feature = "litesvm-backend", test))]
fn bootstrap_chiefwoods_market_data(
    definition: &AccountDefinition,
    program_id: &Pubkey,
    admin: &Pubkey,
) -> Result<Vec<u8>> {
    const MARKET_DISCRIMINATOR: [u8; 8] = [219, 190, 213, 55, 0, 227, 198, 154];
    const MARKET_NAME: &str = "riptide-smoke";

    let (_, market_bump) =
        Pubkey::find_program_address(&[b"market", MARKET_NAME.as_bytes()], program_id);
    let mut data = Vec::with_capacity(definition.space);
    data.extend_from_slice(&MARKET_DISCRIMINATOR);
    push_pubkey(&mut data, admin);
    push_u8(&mut data, market_bump);
    push_string(&mut data, MARKET_NAME);
    pad_account_data("market", data, definition.space)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn bootstrap_chiefwoods_reserve_data(
    definition: &AccountDefinition,
    program_id: &Pubkey,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Vec<u8>> {
    const RESERVE_DISCRIMINATOR: [u8; 8] = [43, 242, 204, 202, 26, 247, 59, 127];

    let market = required_shared_account(shared_accounts, "market")?;
    let reserve = required_shared_account(shared_accounts, "reserve")?;
    let liquidity_mint = required_shared_account(shared_accounts, "liquidity_mint")?;
    let price_update_v2 = required_shared_account(shared_accounts, "price_update_v2")?;

    let (expected_reserve, reserve_bump) = Pubkey::find_program_address(
        &[b"reserve", market.as_ref(), liquidity_mint.as_ref()],
        program_id,
    );
    if expected_reserve != reserve {
        bail!(
            "lending.v1 bootstrap for `reserve` expected PDA {expected_reserve}, \
             but adapter resolved {reserve}"
        );
    }
    let (_, receipt_mint_bump) =
        Pubkey::find_program_address(&[b"receipt_mint", reserve.as_ref()], program_id);

    let mut data = Vec::with_capacity(definition.space);
    data.extend_from_slice(&RESERVE_DISCRIMINATOR);
    push_pubkey(&mut data, &market);
    push_last_update(&mut data, false, 1);

    push_pubkey(&mut data, &liquidity_mint);
    push_pubkey(&mut data, &price_update_v2);
    push_u64(&mut data, 1_000_000);
    push_u64(&mut data, 0);
    push_i80f48_integer(&mut data, 1);
    push_u64(&mut data, 0);
    push_i80f48_integer(&mut data, 1);

    push_u16(&mut data, 7_500);
    push_u16(&mut data, 8_000);
    push_u16(&mut data, 200);
    push_u16(&mut data, 8_500);
    push_u16(&mut data, 1_000);
    push_u16(&mut data, 200);
    push_u16(&mut data, 2_000);
    push_u16(&mut data, 8_000);
    push_u16(&mut data, 500);
    push_u16(&mut data, 250);

    push_u8(&mut data, 6);
    push_u8(&mut data, reserve_bump);
    push_u8(&mut data, receipt_mint_bump);
    pad_account_data("reserve", data, definition.space)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn bootstrap_chiefwoods_obligation_data(
    definition: &AccountDefinition,
    agent_signer: &Pubkey,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Result<Vec<u8>> {
    const OBLIGATION_DISCRIMINATOR: [u8; 8] = [168, 206, 141, 106, 88, 76, 172, 167];

    let market = required_shared_account(shared_accounts, "market")?;
    let mut data = Vec::with_capacity(definition.space);
    data.extend_from_slice(&OBLIGATION_DISCRIMINATOR);
    push_last_update(&mut data, false, 1);
    push_pubkey(&mut data, &market);
    push_pubkey(&mut data, agent_signer);
    push_vec_len(&mut data, 0);
    push_vec_len(&mut data, 0);
    push_i80f48_integer(&mut data, 0);
    push_i80f48_integer(&mut data, 0);
    push_i80f48_integer(&mut data, 100);
    push_i80f48_integer(&mut data, 100);
    push_u8(&mut data, 0);
    pad_account_data("obligation", data, definition.space)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn required_shared_account(
    shared_accounts: &BTreeMap<String, Pubkey>,
    name: &str,
) -> Result<Pubkey> {
    shared_accounts
        .get(name)
        .copied()
        .ok_or_else(|| anyhow!("lending.v1 bootstrap requires shared account `{name}`"))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn pad_account_data(account_name: &str, mut data: Vec<u8>, space: usize) -> Result<Vec<u8>> {
    if data.len() > space {
        bail!(
            "lending.v1 bootstrap for `{account_name}` encoded {} bytes, \
             but adapter declares `space = {space}`",
            data.len()
        );
    }
    data.resize(space, 0);
    Ok(data)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_last_update(data: &mut Vec<u8>, is_stale: bool, slot: u64) {
    data.push(u8::from(is_stale));
    push_u64(data, slot);
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_pubkey(data: &mut Vec<u8>, pubkey: &Pubkey) {
    data.extend_from_slice(pubkey.as_ref());
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_string(data: &mut Vec<u8>, value: &str) {
    push_u32(data, value.len() as u32);
    data.extend_from_slice(value.as_bytes());
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_vec_len(data: &mut Vec<u8>, len: u32) {
    push_u32(data, len);
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_u8(data: &mut Vec<u8>, value: u8) {
    data.push(value);
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_u16(data: &mut Vec<u8>, value: u16) {
    data.extend_from_slice(&value.to_le_bytes());
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_u32(data: &mut Vec<u8>, value: u32) {
    data.extend_from_slice(&value.to_le_bytes());
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_u64(data: &mut Vec<u8>, value: u64) {
    data.extend_from_slice(&value.to_le_bytes());
}

#[cfg(any(feature = "litesvm-backend", test))]
fn push_i80f48_integer(data: &mut Vec<u8>, value: i64) {
    let raw = (i128::from(value) << 48).to_le_bytes();
    data.extend_from_slice(&raw);
}

#[cfg(any(feature = "litesvm-backend", test))]
fn is_spl_token_program(owner: &Pubkey) -> bool {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        .is_ok_and(|token_program| token_program == *owner)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn token_account_mint(
    account_name: &str,
    shared_accounts: &BTreeMap<String, Pubkey>,
) -> Option<Pubkey> {
    if account_name.contains("receipt") {
        return shared_accounts.get("receipt_mint").copied();
    }
    if account_name.contains("collateral") {
        return shared_accounts.get("collateral_mint").copied();
    }
    shared_accounts
        .get("liquidity_mint")
        .or_else(|| shared_accounts.get("collateral_mint"))
        .copied()
}

#[cfg(any(feature = "litesvm-backend", test))]
fn spl_token_mint_data(mint_authority: Pubkey, supply: u64, decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(mint_authority.as_ref());
    data[36..44].copy_from_slice(&supply.to_le_bytes());
    data[44] = decimals;
    data[45] = 1;
    data
}

#[cfg(any(feature = "litesvm-backend", test))]
fn spl_token_account_data(mint: Pubkey, authority: Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(authority.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    data
}

#[cfg(any(feature = "litesvm-backend", test))]
fn is_agent_authority_signer_name(value: &str) -> bool {
    matches!(
        normalize_idl_name(value).as_str(),
        "authority"
            | "agent"
            | "agentauthority"
            | "owner"
            | "tokenauthority"
            | "trader"
            | "user"
            | "userauthority"
    )
}

#[cfg(any(feature = "litesvm-backend", test))]
fn is_admin_authority_signer_name(value: &str) -> bool {
    matches!(
        normalize_idl_name(value).as_str(),
        "admin" | "adminauthority" | "managerauthority" | "payer"
    )
}

#[cfg(any(feature = "litesvm-backend", test))]
fn is_well_known_readonly_account(address: Option<&str>, pubkey: &Pubkey) -> bool {
    if address
        .and_then(|value| well_known_pubkey(value).ok())
        .is_some_and(|known| known == *pubkey)
    {
        return true;
    }

    well_known_readonly_pubkey_strings()
        .iter()
        .filter_map(|value| Pubkey::from_str(value).ok())
        .any(|known| known == *pubkey)
}

#[cfg(any(feature = "litesvm-backend", test))]
fn literal_or_well_known_pubkey(value: &str) -> Result<Pubkey> {
    if let Ok(pubkey) = well_known_pubkey(value) {
        return Ok(pubkey);
    }
    Pubkey::from_str(value).with_context(|| {
        format!("`{value}` is neither a well-known account alias nor a base58 pubkey")
    })
}

#[cfg(any(feature = "litesvm-backend", test))]
fn well_known_pubkey(value: &str) -> Result<Pubkey> {
    let pubkey = match value {
        "system" | "system_program" => well_known_readonly_pubkey_strings()[0],
        "spl_token" | "token" | "token_program" => well_known_readonly_pubkey_strings()[1],
        "spl_token_2022" | "token_2022" | "token_2022_program" => {
            well_known_readonly_pubkey_strings()[2]
        }
        "associated_token" | "associated_token_program" | "ata" => {
            well_known_readonly_pubkey_strings()[3]
        }
        "rent" | "rent_sysvar" | "sysvar_rent" => well_known_readonly_pubkey_strings()[4],
        "clock" | "clock_sysvar" | "sysvar_clock" => well_known_readonly_pubkey_strings()[5],
        "instructions_sysvar" | "sysvar_instructions" => well_known_readonly_pubkey_strings()[6],
        "slot_hashes" | "slot_hashes_sysvar" | "sysvar_slot_hashes" => {
            well_known_readonly_pubkey_strings()[7]
        }
        "stake_history" | "stake_history_sysvar" | "sysvar_stake_history" => {
            well_known_readonly_pubkey_strings()[8]
        }
        _ => bail!("unknown well-known account alias `{value}`"),
    };
    Pubkey::from_str(pubkey).with_context(|| format!("parse well-known pubkey `{value}`"))
}

#[cfg(any(feature = "litesvm-backend", test))]
fn well_known_readonly_pubkey_strings() -> [&'static str; 9] {
    [
        "11111111111111111111111111111111",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "TokenzQdBNbLqP5VEhdkAS6EPFNH4QFMM8erqD8J1x",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "SysvarRent111111111111111111111111111111111",
        "SysvarC1ock11111111111111111111111111111111",
        "Sysvar1nstructions1111111111111111111111111",
        "SysvarS1otHashes111111111111111111111111111",
        "SysvarStakeHistory1111111111111111111111111",
    ]
}

#[cfg(any(feature = "litesvm-backend", test))]
struct OracleBinding {
    account_name: String,
    kind: OracleKind,
    layout: Box<dyn crate::scenario::OracleLayout>,
    confidence: Option<u64>,
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

#[cfg(any(feature = "litesvm-backend", test))]
pub(crate) fn resolve_generic_program_id(
    program_so: &Path,
    adapter_program_id: Option<&str>,
    idl_program_id: Option<&str>,
) -> Result<Pubkey> {
    if let Some(program_id) = adapter_program_id.or(idl_program_id) {
        return Pubkey::from_str(program_id).map_err(|error| {
            anyhow!("generic program id `{program_id}` is not a valid base58 pubkey: {error}")
        });
    }
    let Some(keypair_path) = sibling_deploy_keypair_path(program_so) else {
        return Ok(Pubkey::new_unique());
    };
    if !keypair_path.exists() {
        return Ok(Pubkey::new_unique());
    }
    let keypair = read_keypair_file(&keypair_path).map_err(|error| {
        anyhow!(
            "failed to read generic program keypair {}: {error}",
            keypair_path.display()
        )
    })?;
    Ok(keypair.pubkey())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adapter::{
            loader::parse_adapter_str, SemanticClassRef, SemanticRole, SemanticSourceBinding,
            Semantics,
        },
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
    fn resolve_program_id_prefers_adapter_override() {
        let adapter_id = Pubkey::new_unique();
        let idl_id = Pubkey::new_unique();

        let resolved = resolve_generic_program_id(
            Path::new("target/deploy/example.so"),
            Some(&adapter_id.to_string()),
            Some(&idl_id.to_string()),
        )
        .expect("adapter program id resolves");

        assert_eq!(resolved, adapter_id);
    }

    #[test]
    fn resolve_program_id_uses_idl_address_before_keypair_fallback() {
        let idl_id = Pubkey::new_unique();

        let resolved = resolve_generic_program_id(
            Path::new("target/deploy/missing-keypair.so"),
            None,
            Some(&idl_id.to_string()),
        )
        .expect("IDL program id resolves");

        assert_eq!(resolved, idl_id);
    }

    fn anchor_binding_adapter() -> Adapter {
        parse_adapter_str(
            r#"
protocol = "generic"
program_so = "target/deploy/anchor_fixture.so"
idl_path = "target/idl/anchor_fixture.json"

[accounts.market]
kind = "shared"
space = 64
pda = { seeds = ["literal:market"] }

[accounts.reserve]
kind = "shared"
space = 128
pda = { seeds = ["literal:reserve", "account:market"] }

[accounts.obligation]
kind = "agent"
space = 128
pda = { seeds = ["literal:obligation", "signer:agent", "account:market"] }

[accounts.system_program]
kind = "shared"
space = 8
address = "11111111111111111111111111111111"

[accounts.token_program]
kind = "shared"
space = 8
address = "spl_token"

[accounts.associated_token_program]
kind = "shared"
space = 8
address = "associated_token_program"

[instructions]
anchor_style = { action = "noop" }

[state_mapping]
"market.bump" = "market.bump"

[actions.noop]
takes = []

[observations]
"market.bump" = "uint"

[personas.passive]
action_rate_multiplier = 0.0
action_weights = { noop = 0.0 }
triggers = []
"#,
            "anchor-binding.toml",
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
    fn parse_legacy_anchor_idl_synthesizes_discriminators() {
        let idl = parse_generic_idl_str(
            r#"
{
  "version": "0.1.0",
  "name": "legacy_anchor",
  "instructions": [
    {
      "name": "setValidatorScore",
      "accounts": [
        { "name": "managerAuthority", "isSigner": true, "isMut": false }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "State",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "totalScore", "type": "u32" }
        ]
      }
    }
  ]
}
"#,
        )
        .unwrap();

        assert_eq!(
            idl.instructions[0].discriminator,
            vec![101, 41, 206, 33, 216, 111, 25, 78]
        );
        assert_eq!(
            idl.accounts[0].discriminator.as_deref(),
            Some(&[216, 146, 107, 94, 104, 75, 182, 177][..])
        );
        assert_eq!(
            account_fields(&idl, &idl.accounts[0]).unwrap()[0].name,
            "totalScore"
        );
        assert!(idl.instructions[0].accounts[0].signer);
        assert!(!idl.instructions[0].accounts[0].writable);
    }

    #[test]
    fn parse_legacy_anchor_account_only_idl_synthesizes_discriminators() {
        let idl = parse_generic_idl_str(
            r#"
{
  "version": "0.1.0",
  "name": "legacy_anchor_accounts",
  "instructions": [],
  "accounts": [
    {
      "name": "State",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "totalScore", "type": "u32" }
        ]
      }
    }
  ]
}
"#,
        )
        .unwrap();

        assert_eq!(
            idl.accounts[0].discriminator.as_deref(),
            Some(&[216, 146, 107, 94, 104, 75, 182, 177][..])
        );
        assert_eq!(
            account_fields(&idl, &idl.accounts[0]).unwrap()[0].name,
            "totalScore"
        );
    }

    #[test]
    fn parse_versioned_fixture_idl_keeps_plain_borsh_accounts() {
        let idl = parse_generic_idl_str(
            r#"
{
  "version": "0.1.0",
  "name": "plain_fixture",
  "instructions": [
    {
      "name": "deposit",
      "discriminator": [1],
      "accounts": [
        { "name": "position", "signer": false, "writable": true }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "position",
      "fields": [
        { "name": "is_initialized", "type": "bool" },
        { "name": "collateral", "type": "u64" }
      ]
    }
  ]
}
"#,
        )
        .unwrap();
        let adapter = parse_adapter_str(
            r#"
protocol = "generic"
program_so = "target/deploy/plain_fixture.so"
idl_path = "target/idl/plain_fixture.json"

[accounts.position]
kind = "agent"
space = 9

[instructions]
deposit = { action = "deposit" }

[state_mapping]
"position.is_initialized" = "position.is_initialized"
"position.collateral" = "position.collateral"

[actions.deposit]
takes = []

[observations]
"position.is_initialized" = "bool"
"position.collateral" = "uint"

[personas.actor]
action_rate_multiplier = 1
action_weights = { deposit = 1 }
triggers = []
"#,
            "plain-fixture.toml",
        )
        .unwrap();

        assert_eq!(idl.instructions[0].discriminator, vec![1]);
        assert!(idl.accounts[0].discriminator.is_none());
        let observed = observe_account_state(&idl, &adapter, "position", &[0u8; 9]).unwrap();
        assert_eq!(
            observed.get("position.is_initialized"),
            Some(&ObservationValue::Bool(false))
        );
        assert_eq!(
            observed.get("position.collateral"),
            Some(&ObservationValue::UInt(0))
        );
    }

    #[test]
    fn action_dispatch_encodes_wide_integer_literals() {
        let idl = parse_generic_idl_str(
            r#"
{
  "instructions": [
    {
      "name": "swap",
      "discriminator": [115, 119, 97, 112, 0, 0, 0, 0],
      "accounts": [],
      "args": [
        { "name": "amount", "type": "u64" },
        { "name": "sqrt_price_limit", "type": "u128" },
        { "name": "tick_limit", "type": "i128" },
        { "name": "a_to_b", "type": "bool" }
      ]
    }
  ],
  "accounts": []
}
"#,
        )
        .unwrap();
        let adapter = parse_adapter_str(
            r#"
protocol = "generic"
program_so = "target/deploy/swap.so"
idl_path = "target/idl/swap.json"

[accounts.dummy]
kind = "shared"
space = 8

[accounts.dummy.decoder]
kind = "layout"

[accounts.dummy.decoder.fields.amount]
type = "u64"
offset = 0

[instructions]
swap = { action = "swap", amount = "amount", args = { sqrt_price_limit = 4295048016, tick_limit = -17, a_to_b = true } }

[state_mapping]
"dummy.amount" = "dummy.amount"

[actions.swap]
takes = ["amount"]

[observations]
"dummy.amount" = "uint"

[personas.swapper]
action_rate_multiplier = 1
action_weights = { swap = 1 }
triggers = []
"#,
            "wide-literals.toml",
        )
        .unwrap();
        let builder = GenericInstructionBuilder::new(&idl, &adapter);

        let bytes = builder.build_action_data_single_arg("swap", 7).unwrap();
        assert_eq!(&bytes[..8], &[115, 119, 97, 112, 0, 0, 0, 0]);
        assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 7);
        assert_eq!(
            u128::from_le_bytes(bytes[16..32].try_into().unwrap()),
            4_295_048_016
        );
        assert_eq!(i128::from_le_bytes(bytes[32..48].try_into().unwrap()), -17);
        assert_eq!(bytes[48], 1);
    }

    #[test]
    fn action_event_params_report_resolved_idl_args() {
        let idl = parse_generic_idl_str(
            r#"
{
  "instructions": [
    {
      "name": "add_collateral",
      "discriminator": [1, 2, 3, 4, 5, 6, 7, 8],
      "accounts": [],
      "args": [{ "name": "collateral", "type": "u64" }]
    }
  ],
  "accounts": []
}
"#,
        )
        .unwrap();
        let adapter = parse_adapter_str(
            r#"
protocol = "generic"
program_so = "target/deploy/perpetuals.so"
idl_path = "target/idl/perpetuals.json"

[accounts.dummy]
kind = "shared"
space = 8

[instructions.add_collateral]
action = "add_collateral"
args = { collateral = "@persona.collateral" }

[state_mapping]
"dummy.amount" = "dummy.amount"

[actions.add_collateral]
takes = ["collateral"]

[observations]
"dummy.amount" = "uint"

[personas.builder]
action_rate_multiplier = 1
action_weights = { add_collateral = 1 }
triggers = []
persona_args = { collateral = 5000 }
"#,
            "perps-event-params.toml",
        )
        .unwrap();
        let builder = GenericInstructionBuilder::new(&idl, &adapter);
        let mut persona_args = BTreeMap::new();
        persona_args.insert("collateral".to_string(), ArgLiteral::Int(5000));

        let params = builder
            .build_action_event_params("add_collateral", 1, &persona_args)
            .unwrap();

        assert_eq!(
            params.get("collateral"),
            Some(&serde_json::Value::from(5000))
        );
        assert!(!params.contains_key("amount"));
    }

    #[test]
    fn scheduled_dispatch_builds_refresh_reserve_instruction_data() {
        let idl = parse_generic_idl_str(
            r#"
{
  "instructions": [
    {
      "name": "refresh_reserve",
      "discriminator": [2, 218, 138, 235, 79, 201, 25, 102],
      "accounts": [
        { "name": "reserve", "writable": true },
        { "name": "price_update_v2" }
      ],
      "args": []
    }
  ],
  "accounts": [
    { "name": "reserve", "fields": [{ "name": "market_price", "type": "u64" }] }
  ]
}
"#,
        )
        .unwrap();
        let adapter = parse_adapter_str(
            r#"
protocol = "generic"
program_so = "target/deploy/lending.so"
idl_path = "target/idl/lending.json"

[accounts.reserve]
kind = "shared"
space = 192

[accounts.price_update_v2]
kind = "shared"
space = 50

[instructions]
refresh_reserve = { action = "refresh_reserve" }

[state_mapping]
"reserve.market_price" = "reserve.market_price"

[actions.refresh_reserve]
takes = []

[observations]
"reserve.market_price" = "uint"

[personas.passive]
action_rate_multiplier = 0
action_weights = { refresh_reserve = 0 }
triggers = []

[[oracles]]
name = "price_feed"
kind = "admin-mock"
account = "price_update_v2"
base_price = 1.0
exponent = -6
confidence = 100

[[scheduled_actions]]
name = "refresh_reserve"
instruction = "refresh_reserve"
interval_ticks = 1
accounts = ["reserve", "price_update_v2"]
"#,
            "lending-refresh.toml",
        )
        .unwrap();
        assert_eq!(adapter.oracles[0].kind, OracleKind::AdminMock);
        assert_eq!(adapter.accounts["price_update_v2"].space, 50);

        let builder = GenericInstructionBuilder::new(&idl, &adapter);
        let bytes = builder
            .build_scheduled_data("refresh_reserve", &BTreeMap::new())
            .unwrap();
        assert_eq!(&bytes[..], &[2, 218, 138, 235, 79, 201, 25, 102]);
    }

    #[test]
    fn scheduled_dispatch_requires_explicit_args_for_amount_bound_instruction() {
        let idl = parse_generic_idl_str(SYNTHETIC_IDL).unwrap();
        let adapter = sample_generic_adapter();
        let builder = GenericInstructionBuilder::new(&idl, &adapter);

        let err = builder
            .build_scheduled_data("mine", &BTreeMap::new())
            .unwrap_err()
            .to_string();
        assert!(err.contains("scheduled actions have no implicit runtime amount"));
        assert!(err.contains("[[scheduled_actions]].args.amount"));

        let mut args = BTreeMap::new();
        args.insert("amount".to_string(), serde_json::Value::from(9));
        let bytes = builder.build_scheduled_data("mine", &args).unwrap();
        assert_eq!(&bytes[..8], &[109, 105, 110, 101, 0, 0, 0, 0]);
        assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 9);
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

    fn decoder_adapter(decoder_block: &str, mapping: &str, observations: &str) -> Adapter {
        parse_adapter_str(
            &format!(
                r#"
protocol = "generic"
program_so = "target/deploy/decoder.so"
idl_path = "target/idl/decoder.json"

[accounts.decoded]
kind = "shared"
space = 165
{decoder_block}

[instructions]
noop = {{ action = "noop" }}

[state_mapping]
{mapping}

[actions.noop]
takes = []

[observations]
{observations}

[personas.passive]
action_rate_multiplier = 0
action_weights = {{ noop = 0 }}
triggers = []
"#
            ),
            "decoder.toml",
        )
        .unwrap()
    }

    #[test]
    fn layout_decoder_reads_u64_from_fixed_offset() {
        let idl = parse_generic_idl_str(r#"{"instructions":[],"accounts":[]}"#).unwrap();
        let adapter = decoder_adapter(
            r#"
[accounts.decoded.decoder]
kind = "layout"

[accounts.decoded.decoder.fields.amount]
type = "u64"
offset = 12
"#,
            r#""decoded.amount" = "decoded.amount""#,
            r#""decoded.amount" = "uint""#,
        );
        let mut bytes = vec![0u8; 32];
        bytes[12..20].copy_from_slice(&77u64.to_le_bytes());

        let observed = observe_account_state(&idl, &adapter, "decoded", &bytes).unwrap();
        assert_eq!(
            observed.get("decoded.amount"),
            Some(&ObservationValue::UInt(77))
        );
    }

    #[test]
    fn layout_decoder_reads_pubkey_from_fixed_offset() {
        let idl = parse_generic_idl_str(r#"{"instructions":[],"accounts":[]}"#).unwrap();
        let adapter = decoder_adapter(
            r#"
[accounts.decoded.decoder]
kind = "layout"

[accounts.decoded.decoder.fields.owner]
type = "pubkey"
offset = 4
"#,
            r#""decoded.owner" = "decoded.owner""#,
            r#""decoded.owner" = "pubkey""#,
        );
        let mut bytes = vec![0u8; 64];
        let owner = [9u8; 32];
        bytes[4..36].copy_from_slice(&owner);

        let observed = observe_account_state(&idl, &adapter, "decoded", &bytes).unwrap();
        assert_eq!(
            observed.get("decoded.owner"),
            Some(&ObservationValue::Pubkey(bs58::encode(owner).into_string()))
        );
    }

    #[test]
    fn spl_token_account_preset_reads_amount() {
        let idl = parse_generic_idl_str(r#"{"instructions":[],"accounts":[]}"#).unwrap();
        let adapter = decoder_adapter(
            r#"decoder = "spl_token_account""#,
            r#""decoded.amount" = "decoded.amount""#,
            r#""decoded.amount" = "uint""#,
        );
        let mut bytes = vec![0u8; 165];
        bytes[64..72].copy_from_slice(&1234u64.to_le_bytes());

        let observed = observe_account_state(&idl, &adapter, "decoded", &bytes).unwrap();
        assert_eq!(
            observed.get("decoded.amount"),
            Some(&ObservationValue::UInt(1234))
        );
    }

    #[test]
    fn spl_mint_preset_reads_supply_and_decimals() {
        let idl = parse_generic_idl_str(r#"{"instructions":[],"accounts":[]}"#).unwrap();
        let adapter = decoder_adapter(
            r#"decoder = "spl_mint""#,
            r#"
"decoded.supply" = "decoded.supply"
"decoded.decimals" = "decoded.decimals"
"#,
            r#"
"decoded.supply" = "uint"
"decoded.decimals" = "uint"
"#,
        );
        let mut bytes = vec![0u8; 165];
        bytes[36..44].copy_from_slice(&999u64.to_le_bytes());
        bytes[44] = 6;

        let observed = observe_account_state(&idl, &adapter, "decoded", &bytes).unwrap();
        assert_eq!(
            observed.get("decoded.supply"),
            Some(&ObservationValue::UInt(999))
        );
        assert_eq!(
            observed.get("decoded.decimals"),
            Some(&ObservationValue::UInt(6))
        );
    }

    #[test]
    fn wrapped_i80f48_struct_observes_as_integer() {
        let raw = (42_i128 << 48).to_le_bytes().to_vec();
        let value =
            GenericValue::Struct(BTreeMap::from([("value".into(), GenericValue::Bytes(raw))]));
        assert_eq!(
            value.to_observation(ObservationType::UInt).unwrap(),
            ObservationValue::UInt(42)
        );
    }

    #[test]
    fn generic_persona_trigger_boosts_matching_action_score() {
        let adapter = sample_generic_adapter();
        let policies = build_generic_policies(&adapter, |_| {}).unwrap();
        let policy = policies
            .iter()
            .find(|policy| policy.persona_id == "grinder")
            .unwrap();
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
        let policy = policies
            .iter()
            .find(|policy| policy.persona_id == "grinder")
            .unwrap();
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

    #[test]
    fn account_binding_resolves_well_known_programs_and_agent_pdas_for_dispatch() {
        let adapter = anchor_binding_adapter();
        let program_id = Pubkey::new_unique();
        let admin = Keypair::new();
        let agents = vec![Keypair::new(), Keypair::new()];
        let agent_pubkeys: Vec<Pubkey> = agents.iter().map(|agent| agent.pubkey()).collect();
        let (agent_accounts, shared_accounts) = resolve_generic_account_pubkeys(
            &adapter,
            agents.len(),
            &program_id,
            &admin.pubkey(),
            &agent_pubkeys,
        )
        .unwrap();

        let expected_market = Pubkey::find_program_address(&[b"market"], &program_id).0;
        let expected_reserve =
            Pubkey::find_program_address(&[b"reserve", expected_market.as_ref()], &program_id).0;
        assert_eq!(shared_accounts["market"], expected_market);
        assert_eq!(shared_accounts["reserve"], expected_reserve);
        assert_ne!(
            agent_accounts["obligation"][0],
            agent_accounts["obligation"][1]
        );

        let instruction = GenericInstruction {
            name: "anchor_style".into(),
            discriminator: vec![1, 2, 3, 4, 5, 6, 7, 8],
            accounts: vec![
                GenericInstructionAccount {
                    name: "authority".into(),
                    signer: true,
                    writable: true,
                    address: None,
                },
                GenericInstructionAccount {
                    name: "market".into(),
                    signer: false,
                    writable: false,
                    address: None,
                },
                GenericInstructionAccount {
                    name: "obligation".into(),
                    signer: false,
                    writable: true,
                    address: None,
                },
                GenericInstructionAccount {
                    name: "system_program".into(),
                    signer: false,
                    writable: false,
                    address: Some("11111111111111111111111111111111".into()),
                },
                GenericInstructionAccount {
                    name: "token_program".into(),
                    signer: false,
                    writable: false,
                    address: None,
                },
                GenericInstructionAccount {
                    name: "associated_token_program".into(),
                    signer: false,
                    writable: false,
                    address: Some("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".into()),
                },
            ],
            args: Vec::new(),
        };
        let harness = GenericHarness {
            svm: LiteSVM::new().with_builtins().with_sysvars(),
            program_id,
            admin,
            agents,
            adapter,
            idl: GenericIdl {
                address: None,
                instructions: vec![instruction.clone()],
                accounts: Vec::new(),
                types: Vec::new(),
            },
            agent_accounts,
            shared_accounts,
            oracle_binding: None,
            current_slot: 0,
        };
        let metas = instruction
            .accounts
            .iter()
            .map(|account| harness.resolve_account_meta("anchor_style", 0, account))
            .collect::<Result<Vec<_>>>()
            .unwrap();

        assert_eq!(metas[0].pubkey, harness.agents[0].pubkey());
        assert!(metas[0].is_signer);
        assert_eq!(metas[1].pubkey, expected_market);
        assert_eq!(metas[2].pubkey, harness.agent_accounts["obligation"][0]);
        assert_eq!(
            metas[3].pubkey,
            Pubkey::from_str("11111111111111111111111111111111").unwrap()
        );
        assert_eq!(
            metas[4].pubkey,
            Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
        );
        assert_eq!(
            metas[5].pubkey,
            Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap()
        );

        let trader_meta = harness
            .resolve_account_meta(
                "swap",
                1,
                &GenericInstructionAccount {
                    name: "trader".into(),
                    signer: true,
                    writable: false,
                    address: None,
                },
            )
            .unwrap();
        assert_eq!(trader_meta.pubkey, harness.agents[1].pubkey());
        assert!(trader_meta.is_signer);
        assert!(!trader_meta.is_writable);

        let token_authority_meta = harness
            .resolve_account_meta(
                "swap",
                1,
                &GenericInstructionAccount {
                    name: "token_authority".into(),
                    signer: true,
                    writable: false,
                    address: None,
                },
            )
            .unwrap();
        assert_eq!(token_authority_meta.pubkey, harness.agents[1].pubkey());
        assert!(token_authority_meta.is_signer);

        let user_authority_meta = harness
            .resolve_account_meta(
                "swap",
                0,
                &GenericInstructionAccount {
                    name: "user_authority".into(),
                    signer: true,
                    writable: false,
                    address: None,
                },
            )
            .unwrap();
        assert_eq!(user_authority_meta.pubkey, harness.agents[0].pubkey());
        assert!(user_authority_meta.is_signer);

        let user_meta = harness
            .resolve_account_meta(
                "swap",
                0,
                &GenericInstructionAccount {
                    name: "user".into(),
                    signer: true,
                    writable: true,
                    address: None,
                },
            )
            .unwrap();
        assert_eq!(user_meta.pubkey, harness.agents[0].pubkey());
        assert!(user_meta.is_signer);
        assert!(user_meta.is_writable);

        let manager_authority_meta = harness
            .resolve_account_meta(
                "set_validator_score",
                0,
                &GenericInstructionAccount {
                    name: "manager_authority".into(),
                    signer: true,
                    writable: false,
                    address: None,
                },
            )
            .unwrap();
        assert_eq!(manager_authority_meta.pubkey, harness.admin.pubkey());
        assert!(manager_authority_meta.is_signer);
        assert!(!manager_authority_meta.is_writable);

        let camel_manager_authority_meta = harness
            .resolve_account_meta(
                "setValidatorScore",
                0,
                &GenericInstructionAccount {
                    name: "managerAuthority".into(),
                    signer: true,
                    writable: false,
                    address: None,
                },
            )
            .unwrap();
        assert_eq!(camel_manager_authority_meta.pubkey, harness.admin.pubkey());
        assert!(camel_manager_authority_meta.is_signer);

        let payer = harness
            .payer_for_instruction(
                0,
                &GenericInstruction {
                    name: "set_validator_score".into(),
                    discriminator: Vec::new(),
                    accounts: vec![GenericInstructionAccount {
                        name: "managerAuthority".into(),
                        signer: true,
                        writable: false,
                        address: None,
                    }],
                    args: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(payer.pubkey(), harness.admin.pubkey());
    }

    #[test]
    fn imported_accounts_cannot_override_or_create_dispatch_bindings() {
        let adapter = anchor_binding_adapter();
        let program_id = Pubkey::new_unique();
        let admin = Keypair::new();
        let agents = vec![Keypair::new(), Keypair::new()];
        let agent_pubkeys: Vec<Pubkey> = agents.iter().map(|agent| agent.pubkey()).collect();
        let (agent_accounts, shared_accounts) = resolve_generic_account_pubkeys(
            &adapter,
            agents.len(),
            &program_id,
            &admin.pubkey(),
            &agent_pubkeys,
        )
        .unwrap();
        let expected_market = shared_accounts["market"];
        let expected_obligations = agent_accounts["obligation"].clone();
        let system_program = shared_accounts["system_program"];
        let mut harness = GenericHarness {
            svm: LiteSVM::new().with_builtins().with_sysvars(),
            program_id,
            admin,
            agents,
            adapter,
            idl: GenericIdl {
                address: None,
                instructions: Vec::new(),
                accounts: Vec::new(),
                types: Vec::new(),
            },
            agent_accounts,
            shared_accounts,
            oracle_binding: None,
            current_slot: 0,
        };

        let err = harness
            .bind_imported_account("undeclared_price", vec![Pubkey::new_unique()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("cannot bind undeclared imported account"));

        let err = harness
            .bind_imported_account("market", vec![Pubkey::new_unique()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("cannot override declared shared account binding"));
        assert_eq!(harness.shared_accounts["market"], expected_market);

        harness
            .bind_imported_account("market", vec![expected_market])
            .expect("fixture may hydrate the already-declared PDA binding");

        let mut wrong_obligations = expected_obligations.clone();
        wrong_obligations[0] = Pubkey::new_unique();
        let err = harness
            .bind_imported_account("obligation", wrong_obligations)
            .unwrap_err()
            .to_string();
        assert!(err.contains("cannot override declared agent account binding"));
        assert_eq!(harness.agent_accounts["obligation"], expected_obligations);

        let err = harness
            .bind_imported_account("system_program", vec![system_program])
            .unwrap_err()
            .to_string();
        assert!(err.contains("well-known readonly address"));
    }

    #[test]
    fn replay_roles_bind_through_semantic_account_sources() {
        let mut adapter = anchor_binding_adapter();
        adapter.semantics = Some(Semantics {
            class: Some("lending.v1".into()),
            roles: BTreeMap::from([(
                "position".into(),
                SemanticRole {
                    source: "account.obligation".into(),
                    fields: BTreeMap::new(),
                    binding: Some(SemanticSourceBinding::Account("obligation".into())),
                },
            )]),
            derived: BTreeMap::new(),
            invariants: Vec::new(),
            extensions: BTreeMap::new(),
            oracles: BTreeMap::new(),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: Some(SemanticClassRef::LendingV1),
            derived_order: Vec::new(),
        });
        let harness = GenericHarness {
            svm: LiteSVM::new().with_builtins().with_sysvars(),
            program_id: Pubkey::new_unique(),
            admin: Keypair::new(),
            agents: Vec::new(),
            adapter,
            idl: GenericIdl {
                address: None,
                instructions: Vec::new(),
                accounts: Vec::new(),
                types: Vec::new(),
            },
            agent_accounts: BTreeMap::new(),
            shared_accounts: BTreeMap::new(),
            oracle_binding: None,
            current_slot: 0,
        };

        assert_eq!(
            harness.replay_account_name_for_role("position").unwrap(),
            "obligation"
        );
        assert_eq!(
            harness.replay_account_name_for_role("unknown").unwrap(),
            "unknown"
        );
    }

    #[test]
    fn observation_sources_skip_unmapped_auxiliary_accounts() {
        let mut adapter = anchor_binding_adapter();
        assert!(adapter_account_has_observation_sources(&adapter, "market"));
        assert!(!adapter_account_has_observation_sources(
            &adapter,
            "token_program"
        ));

        adapter.semantics = Some(Semantics {
            class: Some("lending.v1".into()),
            roles: BTreeMap::from([(
                "position".into(),
                SemanticRole {
                    source: "account.obligation".into(),
                    fields: BTreeMap::new(),
                    binding: Some(SemanticSourceBinding::Account("obligation".into())),
                },
            )]),
            derived: BTreeMap::new(),
            invariants: Vec::new(),
            extensions: BTreeMap::new(),
            oracles: BTreeMap::new(),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: Some(SemanticClassRef::LendingV1),
            derived_order: Vec::new(),
        });
        assert!(adapter_account_has_observation_sources(
            &adapter,
            "obligation"
        ));
    }

    #[test]
    fn missing_anchor_account_binding_names_the_instruction_account() {
        let adapter = anchor_binding_adapter();
        let program_id = Pubkey::new_unique();
        let admin = Keypair::new();
        let agents = vec![Keypair::new()];
        let agent_pubkeys: Vec<Pubkey> = agents.iter().map(|agent| agent.pubkey()).collect();
        let (agent_accounts, shared_accounts) = resolve_generic_account_pubkeys(
            &adapter,
            agents.len(),
            &program_id,
            &admin.pubkey(),
            &agent_pubkeys,
        )
        .unwrap();
        let harness = GenericHarness {
            svm: LiteSVM::new().with_builtins().with_sysvars(),
            program_id,
            admin,
            agents,
            adapter,
            idl: GenericIdl {
                address: None,
                instructions: Vec::new(),
                accounts: Vec::new(),
                types: Vec::new(),
            },
            agent_accounts,
            shared_accounts,
            oracle_binding: None,
            current_slot: 0,
        };
        let missing = GenericInstructionAccount {
            name: "price_update_v2".into(),
            signer: false,
            writable: false,
            address: None,
        };
        let err = harness
            .resolve_account_meta("refresh_reserve", 0, &missing)
            .unwrap_err()
            .to_string();
        assert!(err.contains("MissingGenericAccountBinding"));
        assert!(err.contains("instruction=refresh_reserve"));
        assert!(err.contains("account=price_update_v2"));

        let missing_signer = GenericInstructionAccount {
            name: "market_authority".into(),
            signer: true,
            writable: true,
            address: None,
        };
        let err = harness
            .resolve_account_meta("initialize_reserve", 0, &missing_signer)
            .unwrap_err()
            .to_string();
        assert!(err.contains("MissingGenericAccountBinding"));
        assert!(err.contains("instruction=initialize_reserve"));
        assert!(err.contains("account=market_authority"));
        assert!(err.contains("signer=true"));
    }
}
