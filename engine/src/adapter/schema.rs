//! Serde types for the adapter TOML v0.
//!
//! Keep the schema boring. No dynamic eval, no templating, no variable
//! substitution. The generic blocks are load-bearing and add the minimum
//! extra metadata the engine needs to boot a non-lending program
//! honestly: program artifact path, IDL path, and account bindings.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::adapter::errors::ProgramErrorEntry;
pub use crate::semantics::types::{
    CollectionDef, CollectionFormula, OracleBinding, ReplayBlock, ReplayStateSource,
};
use crate::semantics::{error::Span, expr::Expr};

/// Backcompat runtime hint this adapter describes. `Generic` uses the
/// SBF/IDL runtime backed by `program_so` + `idl_path`; `Lending` uses
/// the bundled lending harness. Economic interpretation lives in
/// `[semantics].class`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    /// Lending primitive (deposit/borrow/repay/withdraw/liquidate +
    /// pool_state/health_factor). First concrete impl:
    /// `crate::primitive::lending::LiteSvmHarness`.
    Lending,
    /// Generic primitive driven entirely by inline adapter definitions.
    Generic,
}

/// Mapping of an on-chain instruction name to a logical action + its
/// argument bindings.
///
/// `action` is the canonical action label the engine dispatches on.
/// `amount` names the single IDL argument the runtime-computed amount
/// flows into (kept for backwards compat with single-arg adapters).
/// `args` declares literal constants for the remaining
/// IDL arguments of a multi-arg instruction; the encoder walks the IDL
/// args in order and resolves each by name from either `amount` (one
/// runtime-bound arg) or `args` (any number of literal-bound args).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstructionMapping {
    pub action: String,
    /// Optional because zero-arg instructions may omit it.
    #[serde(default)]
    pub amount: Option<String>,
    /// literal constants for non-runtime IDL args.
    /// Keys are IDL argument names (must match a `GenericArg.name`);
    /// values are Borsh-encodable literals. Empty by default so every
    /// single-arg and zero-arg adapter keeps parsing byte-for-byte.
    #[serde(default)]
    pub args: std::collections::BTreeMap<String, ArgLiteral>,
}

/// How a generic adapter account is instantiated at bootstrap time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountKind {
    /// One program-owned account per simulated agent.
    Agent,
    /// One shared program-owned account for the whole simulation.
    Shared,
}

/// Bootstrap metadata for a generic adapter account binding.
///
/// `kind` answers "how many accounts do we create" (cardinality).
/// `owner` answers "who owns those accounts on-chain" (ownership) and
/// is optional — adapters that leave it absent continue to be owned by
/// the simulated program, preserving byte-for-byte compatibility for
/// every existing shipped adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountDefinition {
    pub kind: AccountKind,
    pub space: usize,
    /// Optional deterministic address binding. Accepts either a
    /// well-known alias such as `system_program`, `spl_token`,
    /// `associated_token_program`, `clock_sysvar`, or a literal
    /// base58 pubkey. When present on a shared account, bootstrap
    /// binds this adapter name to that address instead of generating a
    /// fresh key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// Optional PDA binding. Seeds are explicit strings with a small
    /// prefix DSL:
    /// `literal:<bytes>`, `account:<name>`, `signer:agent`,
    /// `signer:admin`, `program:<alias-or-self>`, or
    /// `pubkey:<base58>`. `program` defaults to `self`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pda: Option<PdaDefinition>,
    /// Optional external-owner metadata. When set, the generic harness
    /// creates the account with this owner instead of the simulated
    /// program id. Only valid on `kind = "shared"` accounts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<AccountOwner>,
    /// Optional byte-layout decoder for accounts whose state is not
    /// described by the program IDL. Preset strings (for example
    /// `decoder = "spl_token_account"`) are sugar over the same fixed
    /// offset layout represented by the table form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decoder: Option<AccountDecoder>,
}

/// Minimal deterministic PDA declaration for generic account bindings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PdaDefinition {
    pub seeds: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
}

/// External-owner metadata for a generic adapter account. Exactly one
/// of `program_so` (sibling program on disk) or `pubkey` (literal
/// base58 key for real external programs) must be set;
/// declaring both or neither is rejected by the loader with a
/// key-level diagnostic.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountOwner {
    /// Path to a sibling program's compiled `.so` artifact. The
    /// loader derives the owner pubkey from the companion
    /// `target/deploy/<name>-keypair.json` file, matching the
    /// existing local-deploy convention used elsewhere in the repo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program_so: Option<String>,
    /// Literal base58-encoded 32-byte pubkey for real external
    /// programs that do not ship a local `.so` artifact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pubkey: Option<String>,
}

/// Built-in account decoder preset names accepted by the loader.
pub const ACCOUNT_DECODER_PRESETS: &[&str] = &["spl_token_account", "spl_mint"];

/// Account-level raw byte decoder declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AccountDecoder {
    /// Built-in preset alias such as `spl_token_account`.
    Preset(String),
    /// Explicit fixed-offset layout.
    Layout(LayoutDecoder),
}

impl AccountDecoder {
    pub fn preset_name(&self) -> Option<&str> {
        match self {
            Self::Preset(name) => Some(name),
            Self::Layout(_) => None,
        }
    }

    pub fn layout(&self) -> Option<BTreeMap<String, LayoutField>> {
        match self {
            Self::Preset(name) => account_decoder_preset_layout(name),
            Self::Layout(layout) if layout.kind == "layout" => Some(layout.fields.clone()),
            Self::Layout(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutDecoder {
    /// Kept as a string so the loader, not serde, owns the validation
    /// diagnostic for unknown decoder kinds.
    pub kind: String,
    #[serde(default)]
    pub fields: BTreeMap<String, LayoutField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutField {
    #[serde(rename = "type")]
    pub ty: LayoutFieldType,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutFieldType {
    U8,
    U64,
    U128,
    I64,
    I128,
    Bool,
    Pubkey,
    /// Stored so loader validation can reject unknown values with the
    /// same key-level `AdapterError::Validation` shape as other adapter
    /// schema mistakes.
    Unknown(String),
}

impl LayoutFieldType {
    pub fn parse(value: &str) -> Self {
        match value {
            "u8" => Self::U8,
            "u64" => Self::U64,
            "u128" => Self::U128,
            "i64" => Self::I64,
            "i128" => Self::I128,
            "bool" => Self::Bool,
            "pubkey" => Self::Pubkey,
            other => Self::Unknown(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::U8 => "u8",
            Self::U64 => "u64",
            Self::U128 => "u128",
            Self::I64 => "i64",
            Self::I128 => "i128",
            Self::Bool => "bool",
            Self::Pubkey => "pubkey",
            Self::Unknown(value) => value.as_str(),
        }
    }

    pub fn byte_width(&self) -> Option<usize> {
        match self {
            Self::U8 | Self::Bool => Some(1),
            Self::U64 | Self::I64 => Some(8),
            Self::U128 | Self::I128 => Some(16),
            Self::Pubkey => Some(32),
            Self::Unknown(_) => None,
        }
    }
}

impl fmt::Display for LayoutFieldType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for LayoutFieldType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for LayoutFieldType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(Self::parse(&value))
    }
}

fn layout_field(ty: LayoutFieldType, offset: usize) -> LayoutField {
    LayoutField { ty, offset }
}

pub fn account_decoder_preset_layout(name: &str) -> Option<BTreeMap<String, LayoutField>> {
    match name {
        "spl_token_account" => Some(BTreeMap::from([
            ("mint".into(), layout_field(LayoutFieldType::Pubkey, 0)),
            ("owner".into(), layout_field(LayoutFieldType::Pubkey, 32)),
            ("amount".into(), layout_field(LayoutFieldType::U64, 64)),
            ("state".into(), layout_field(LayoutFieldType::U8, 108)),
            (
                "delegated_amount".into(),
                layout_field(LayoutFieldType::U64, 121),
            ),
        ])),
        "spl_mint" => Some(BTreeMap::from([
            ("supply".into(), layout_field(LayoutFieldType::U64, 36)),
            ("decimals".into(), layout_field(LayoutFieldType::U8, 44)),
            (
                "is_initialized".into(),
                layout_field(LayoutFieldType::Bool, 45),
            ),
        ])),
        _ => None,
    }
}

/// Generic action definition.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ActionDefinition {
    /// Optional human-readable label for reports/debugging.
    #[serde(default)]
    pub label: Option<String>,
    /// Ordered list of IDL instruction args the adapter declares for
    /// this action. Each entry must bind to either the runtime-computed
    /// amount (via `[instructions].<ix>.amount`) or a literal constant
    /// (via `[instructions].<ix>.args.<entry>`). Multi-arg Borsh
    /// instructions (e.g. AMM `swap(amount_in, min_out, direction)`)
    /// declare all of their args here.
    #[serde(default)]
    pub takes: Vec<String>,
}

/// Borsh-encodable literal values for `[instructions].<ix>.args`.
///
/// The adapter-loader accepts natural TOML primitives (integers, bools,
/// quoted base58 strings) and the encoder coerces each literal into the
/// byte layout the matching IDL arg declares. Supported target IDL
/// types: `u64`/`i64`/`u32`/`u8`/`bool`/`pubkey`. Range overflow on
/// encode is surfaced as an adapter error so a typo in the TOML fails
/// loudly rather than silently wrapping.
///
/// Untagged so a TOML entry like `min_out = 0` naturally parses as
/// `Int(0)`, `direction = false` as `Bool(false)`, and
/// `recipient = "4NBcG..."` as `String("4NBcG...")` (which the encoder
/// decodes as base58 into a 32-byte pubkey).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArgLiteral {
    Bool(bool),
    Int(i64),
    String(String),
}

/// Supported observation types for the generic primitive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObservationType {
    Int,
    UInt,
    Bool,
    Pubkey,
    Map,
}

/// Detailed observation definition form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservationShape {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub kind: ObservationType,
}

/// Generic observation definition.
///
/// The compact TOML form is:
///
/// ```toml
/// [observations]
/// "player.wood" = "uint"
/// ```
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ObservationDefinition {
    Type(ObservationType),
    Detailed(ObservationShape),
}

impl ObservationDefinition {
    pub fn kind(&self) -> ObservationType {
        match self {
            Self::Type(kind) => *kind,
            Self::Detailed(shape) => shape.kind,
        }
    }
}

/// Smallest trigger DSL that works for the generic primitive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PersonaTriggerDefinition {
    #[serde(rename = "if")]
    pub condition: String,
    #[serde(rename = "then")]
    pub action: String,
    pub weight_boost: f64,
}

fn default_action_rate_multiplier() -> f64 {
    1.0
}

/// Generic persona definition block.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PersonaDefinition {
    #[serde(default)]
    pub label: Option<String>,
    /// Multiplies all non-noop action scores. Higher => acts more often.
    #[serde(default = "default_action_rate_multiplier")]
    pub action_rate_multiplier: f64,
    /// Per-action weights referenced by the agent runtime when the
    /// generic primitive is active.
    #[serde(default)]
    pub action_weights: BTreeMap<String, f64>,
    /// Trigger DSL. Parsed into runtime triggers by the generic primitive.
    #[serde(default)]
    pub triggers: Vec<PersonaTriggerDefinition>,
    /// per-persona named values the encoder substitutes
    /// into multi-runtime-arg instructions.
    ///
    /// An instruction's `args = { leverage = "@persona.leverage_bps",... }`
    /// reference resolves against this map at dispatch time, so every
    /// agent running under this persona supplies its own `leverage`
    /// value into `open_position(side, leverage, notional)` without
    /// forking the adapter into one action per leverage level.
    ///
    /// Empty by default — adapters that only use single-runtime-arg
    /// dispatch (lending, the shipping perps scratch) keep parsing
    /// byte-for-byte and serialize without the key. Type-checking
    /// happens at encode
    /// time against the target IDL arg's Borsh type (same coercion
    /// rules as literal-bound args).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub persona_args: BTreeMap<String, ArgLiteral>,
}

/// Parsed adapter TOML.
///
/// Field order matters for serde: it shapes what a stringified roundtrip
/// of the struct looks like. Keep parse-order documented in the fixture
/// file instead of relying on field declaration order here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Adapter {
    /// Optional backcompat runtime hint. This is deliberately separate
    /// from the economic semantic class declared in `[semantics].class`.
    /// When `program_so` + `idl_path` are present, the SBF/IDL runtime
    /// is inferred regardless of this hint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Protocol>,

    /// Optional path to the program artifact. Generic adapters use this to
    /// point the engine at a non-lending `.so` without extra CLI flags.
    #[serde(default)]
    pub program_so: Option<String>,

    /// Optional path to the IDL / instruction catalog JSON. Required by
    /// the generic primitive.
    #[serde(default)]
    pub idl_path: Option<String>,

    /// Generic account bootstrap bindings. Empty by convention for
    /// lending adapters.
    #[serde(default)]
    pub accounts: BTreeMap<String, AccountDefinition>,

    /// Map of on-chain instruction name → `{ action, amount }`. Required.
    pub instructions: BTreeMap<String, InstructionMapping>,

    /// Map of `"<account>.<field>"` dotted path → logical observation
    /// name. Required.
    pub state_mapping: BTreeMap<String, String>,

    /// Generic action definitions. Empty by convention for lending
    /// adapters.
    #[serde(default)]
    pub actions: BTreeMap<String, ActionDefinition>,

    /// Generic observation definitions. Empty by convention for lending
    /// adapters.
    #[serde(default)]
    pub observations: BTreeMap<String, ObservationDefinition>,

    /// Generic persona definitions. Empty by convention for lending
    /// adapters.
    #[serde(default)]
    pub personas: BTreeMap<String, PersonaDefinition>,

    /// Declarative invariant block. A flat list of
    /// `{ name?, field, op, value }` triples the tick loop checks against
    /// each tick's observation snapshot. Empty by default so every
    /// existing adapter continues to parse unchanged.
    #[serde(default)]
    pub invariants: Vec<Invariant>,

    /// Declarative oracle block. Each entry declares an
    /// oracle account layout the engine can target for shock injection.
    /// Adapters that leave this empty keep the legacy hardcoded Solend
    /// oracle path (harness-owned admin-mock layout). New protocol classes
    /// (perps, AMM, etc.) declare `[[oracles]]` so the engine can dispatch
    /// shocks through a typed layout without primitive-level changes.
    #[serde(default)]
    pub oracles: Vec<OracleDefinition>,

    /// Engine-triggered scheduled actions. Each entry
    /// declares an instruction the engine fires automatically between
    /// persona ticks at a fixed cadence. Empty by default so every
    /// existing adapter continues to parse unchanged.
    #[serde(default)]
    pub scheduled_actions: Vec<ScheduledAction>,

    /// Optional Economic Semantics block. Absent adapters stay in
    /// legacy mode. When present, the loader validates the class,
    /// role sources, and expression strings, then stores parsed ASTs
    /// in the skipped fields on `SemanticExpression`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantics: Option<Semantics>,

    /// Optional adapter-supplied program error registry. Entries map
    /// Solana `InstructionError(_, Custom(code))` values to stable,
    /// reviewer-readable labels and interpretations.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<ProgramErrorEntry>,

    /// Optional declarative lineage block. Reviewer-facing metadata
    /// describing the IDL the adapter was authored against, the
    /// generator (hand-authored vs. `riptide-adapt@<sha>`), any
    /// inferred assumptions the author baked in that are not literally
    /// in the IDL, and IDL fields the adapter deliberately does not
    /// model. Inspection-only in Sprint 12 — no IDL fetch, no
    /// validation. Absent by default so every pre-Sprint-12 adapter
    /// continues to parse byte-for-byte.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<AdapterLineage>,
}

impl Adapter {
    pub fn declares_sbf_idl_runtime(&self) -> bool {
        has_non_empty_runtime_path(self.program_so.as_deref())
            && has_non_empty_runtime_path(self.idl_path.as_deref())
    }

    pub fn inferred_runtime(&self) -> Option<Protocol> {
        if self.declares_sbf_idl_runtime() {
            Some(Protocol::Generic)
        } else {
            self.protocol
        }
    }

    pub fn runtime(&self) -> Protocol {
        self.inferred_runtime()
            .expect("adapter runtime selection should be validated before runtime dispatch")
    }
}

fn has_non_empty_runtime_path(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.trim().is_empty())
}

// ---------------------------------------------------------------------------
// Economic semantics v1 adapter block
// ---------------------------------------------------------------------------

/// Regex string mirrored exactly by `cli/src/schemas/adapter.ts`.
pub const SEMANTIC_CLASS_RE: &str = "^[a-z][a-z0-9-]*\\.v[0-9]+$";

pub const SUPPORTED_SEMANTIC_CLASSES: &[&str] = &["lending.v1"];

pub const LENDING_V1_REQUIRED_ROLES: &[&str] =
    &["position", "reserve", "oracle", "liquidation_config"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticClassRef {
    LendingV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Semantics {
    /// Raw class string from TOML. Optional at serde time so the
    /// loader can return a structured `MissingSemanticClass` error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub roles: BTreeMap<String, SemanticRole>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub derived: BTreeMap<String, SemanticExpression>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invariants: Vec<SemanticInvariant>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, toml::Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub oracles: BTreeMap<String, Vec<OracleBinding>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub collections: BTreeMap<String, CollectionDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<ReplayBlock>,
    #[serde(skip)]
    pub class_ref: Option<SemanticClassRef>,
    #[serde(skip)]
    pub derived_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticRole {
    pub source: String,
    pub fields: BTreeMap<String, SemanticFieldType>,
    #[serde(skip)]
    pub binding: Option<SemanticSourceBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SemanticSourceBinding {
    Instruction(String),
    Account(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SemanticFieldType {
    U64,
    U128,
    I64,
    I128,
    Bool,
    Pubkey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticExpression {
    pub source: String,
    pub ast: Option<Expr>,
    pub span: Option<Span>,
}

impl SemanticExpression {
    pub fn new(source: String) -> Self {
        Self {
            source,
            ast: None,
            span: None,
        }
    }
}

impl Serialize for SemanticExpression {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.source)
    }
}

impl<'de> Deserialize<'de> for SemanticExpression {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let source = String::deserialize(deserializer)?;
        Ok(Self::new(source))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticInvariant {
    pub name: String,
    pub expr: SemanticExpression,
    #[serde(default)]
    pub severity: SemanticInvariantSeverity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SemanticInvariantSeverity {
    Error,
    Warn,
}

impl Default for SemanticInvariantSeverity {
    fn default() -> Self {
        Self::Error
    }
}

impl SemanticInvariantSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
        }
    }
}

pub fn is_valid_semantic_class(value: &str) -> bool {
    let Some((class_name, version)) = value.split_once('.') else {
        return false;
    };
    if class_name.is_empty()
        || version.len() < 2
        || !version.starts_with('v')
        || !version[1..].chars().all(|c| c.is_ascii_digit())
    {
        return false;
    }
    let mut chars = class_name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl fmt::Display for SemanticFieldType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::U64 => write!(f, "u64"),
            Self::U128 => write!(f, "u128"),
            Self::I64 => write!(f, "i64"),
            Self::I128 => write!(f, "i128"),
            Self::Bool => write!(f, "bool"),
            Self::Pubkey => write!(f, "pubkey"),
        }
    }
}

/// Declarative lineage block for the optional `[lineage]` section of an
/// adapter TOML. Every field is optional on parse (absent fields serialize
/// omitted so round-trip through `toml::to_string` stays minimal).
/// Accuracy is load-bearing — a lying `inferred_assumptions` list is
/// worse than silence.
///
/// `#[serde(deny_unknown_fields)]` is load-bearing: a typoed key like
/// `unsupported_field = [...]` must fail the adapter load, not silently
/// render as "(none recorded)". Lineage is reviewer documentation, and
/// a silently-dropped typo hides exactly the kind of omission the
/// reviewer surface is supposed to catch.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterLineage {
    /// Repo-relative path (or URL) to the IDL the adapter was authored
    /// against. Reviewers follow this pointer to compare adapter
    /// coverage against the on-chain program surface themselves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idl_source: Option<String>,
    /// Generator identifier. Typically `hand-authored` or
    /// `riptide-adapt@<git-sha>`; free-form so downstream adopters can
    /// name their own tooling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
    /// Short human-readable strings naming each non-trivial assumption
    /// the adapter author (or generator) made that is not literally in
    /// the IDL. Examples: "lazy-init pool on first touch — no
    /// initialize_pool mapped", "oracle account bound but not read by
    /// the program". Empty by convention if the adapter is a
    /// straight IDL → TOML translation with no inferences.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inferred_assumptions: Vec<String>,
    /// IDL instruction / account / field names the adapter deliberately
    /// does not model. Empty by convention if every IDL surface is
    /// mapped. Used by Sprint 13's linter as the authoritative list of
    /// known gaps so the linter can distinguish "author chose to skip
    /// this" from "author forgot this".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unsupported_fields: Vec<String>,
}

/// Supported comparison operators for declarative invariants.
///
/// Deliberately flat — no AND/OR, no math, no user functions. The task
/// note lives in the sprint doc: "keep it DUMB — no mini-language".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InvariantOp {
    #[serde(rename = "==")]
    Eq,
    #[serde(rename = "!=")]
    NotEq,
    #[serde(rename = ">=")]
    Gte,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = "<")]
    Lt,
}

impl InvariantOp {
    /// Round-trip string form used in summary emission and violation
    /// records so operator-visible output matches the adapter TOML.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Eq => "==",
            Self::NotEq => "!=",
            Self::Gte => ">=",
            Self::Lte => "<=",
            Self::Gt => ">",
            Self::Lt => "<",
        }
    }

    /// Apply the comparison with f64 coercion. Bool/string comparisons
    /// are out of scope for.
    pub fn apply(&self, observed: f64, expected: f64) -> bool {
        match self {
            Self::Eq => observed == expected,
            Self::NotEq => observed != expected,
            Self::Gte => observed >= expected,
            Self::Lte => observed <= expected,
            Self::Gt => observed > expected,
            Self::Lt => observed < expected,
        }
    }
}

/// Declarative invariant triple. Parsed verbatim from the adapter TOML's
/// `[[invariants]]` block. `name` is optional; the loader/runtime default
/// to `inv_<idx>` when absent. `value` is coerced to f64 for comparison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Invariant {
    #[serde(default)]
    pub name: Option<String>,
    pub field: String,
    pub op: InvariantOp,
    pub value: f64,
}

impl Invariant {
    /// Resolve a stable display name for this invariant, falling back
    /// to `inv_<idx>` when the adapter did not supply one.
    pub fn display_name(&self, idx: usize) -> String {
        self.name.clone().unwrap_or_else(|| format!("inv_{idx}"))
    }
}

// ---------------------------------------------------------------------------
// Generic oracle injection
// ---------------------------------------------------------------------------

/// Supported oracle account layouts. Selects which concrete
/// [`crate::scenario::oracle::OracleLayout`] implementation the engine
/// uses when it encodes a price shock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OracleKind {
    /// Admin-settable mock oracle. This is the layout 's
    /// Solend-fork hero grid drives through
    /// `programs/lending_pool`'s bundled oracle state, now ships as a
    /// standalone program at `programs/admin_mock_oracle/` so
    /// non-lending adapters can depend on it directly.
    AdminMock,
}

/// Declarative oracle entry from the adapter TOML's `[[oracles]]`
/// block. Each entry names a logical oracle and the account layout
/// kind the engine should target when shocking that oracle. Optional
/// fields carry layout-specific defaults the engine can consume at
/// bootstrap time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OracleDefinition {
    /// Stable logical identifier used by proposals and scenarios to
    /// reference this oracle. Must be a safe identifier.
    pub name: String,
    /// Which concrete account layout the engine encodes into when
    /// writing a shock.
    pub kind: OracleKind,
    /// Optional reference into `[accounts]` (generic path) naming the
    /// program-owned price account. Lending adapters typically leave
    /// this absent — the lending primitive already knows where its
    /// oracle state account lives.
    #[serde(default)]
    pub account: Option<String>,
    /// Starting price this oracle should report when the simulation
    /// boots. Defaults to `100.0` so a bare `{ name, kind }` entry is
    /// still bootable.
    #[serde(default = "default_oracle_base_price")]
    pub base_price: f64,
    /// Price exponent (e.g. `-2` for "report cents"). Defaults to `0`.
    #[serde(default)]
    pub exponent: i8,
    /// Optional confidence metadata. The built-in AdminMock layout
    /// ignores it; custom harnesses may use it outside the MVP engine
    /// oracle writer.
    #[serde(default)]
    pub confidence: Option<u64>,
}

fn default_oracle_base_price() -> f64 {
    100.0
}

/// Canonical set of oracle kinds, for error messages and documentation.
pub const ORACLE_KINDS: &[&str] = &["admin-mock"];

// ---------------------------------------------------------------------------
// Engine-triggered scheduled actions
// ---------------------------------------------------------------------------

/// Declarative scheduled action entry from the adapter TOML's
/// `[[scheduled_actions]]` block. Each entry tells the engine to fire a
/// named instruction automatically between persona ticks at a fixed
/// cadence.
///
/// **Execution ordering per tick** (load-bearing — do not change
/// without also changing the documentation in `sim::run::run_simulation`
/// and `run_generic_simulation`):
///
/// 1. Scheduled actions fire FIRST — world state updates before
/// persona actions react.
/// 2. Persona actions fire SECOND.
/// 3. Invariants evaluate LAST on the post-persona snapshot.
///
/// Multiple scheduled actions due on the same tick fire in
/// **declaration order** from the adapter TOML (i.e. the index they
/// appear at in `Adapter.scheduled_actions`). This keeps the tie-break
/// deterministic across same-seed runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScheduledAction {
    /// Optional human-readable name. Defaults to `scheduled_<idx>` at
    /// display time if absent.
    #[serde(default)]
    pub name: Option<String>,
    /// The instruction the engine should fire. Must correspond to a
    /// key of the adapter's `[instructions]` block so the loader can
    /// cross-check the reference at parse time.
    pub instruction: String,
    /// Tick cadence. The engine fires on every tick where
    /// `tick % interval_ticks == 0`. Must be a positive integer; the
    /// loader rejects zero.
    pub interval_ticks: u32,
    /// Optional account references (names from `[accounts]` for the
    /// generic path). The engine passes these through to the primitive's
    /// scheduled-action hook; 's primitives treat them as
    /// observable metadata only.
    #[serde(default)]
    pub accounts: Vec<String>,
    /// Static instruction arguments. The engine passes these verbatim
    /// to the primitive's scheduled-action hook.
    #[serde(default)]
    pub args: BTreeMap<String, serde_json::Value>,
}

impl ScheduledAction {
    /// Resolve a stable display name, falling back to `scheduled_<idx>`
    /// when the adapter did not supply one.
    pub fn display_name(&self, idx: usize) -> String {
        self.name
            .clone()
            .unwrap_or_else(|| format!("scheduled_{idx}"))
    }
}

// ---------------------------------------------------------------------------
// Canonical name sets used by the loader for lending-protocol validation.
// ---------------------------------------------------------------------------

/// Canonical set of lending action labels the engine dispatches on.
pub const LENDING_ACTIONS: &[&str] = &["deposit", "borrow", "repay", "withdraw", "liquidate"];

/// Canonical set of logical observation names the lending tick loop
/// consumes from `state_mapping` values.
pub const LENDING_OBSERVATIONS: &[&str] = &["tvl", "debt", "bad_debt", "collateral", "liquidated"];

/// Super-set of `LENDING_ACTIONS` used for error-message guidance. The
/// generic-primitive path extends this at runtime with adapter-defined
/// custom actions.
pub const ACTION_NAMES: &[&str] = LENDING_ACTIONS;

/// Snapshot metric keys the lending primitive emits alongside the
/// logical observations declared in `state_mapping`. Used by the loader
/// when validating `[[invariants]]` so adapters can reference either
/// the engine-side metric names (e.g. `cumulative_bad_debt`) or the
/// canonical logical observations (e.g. `tvl`).
pub const LENDING_SNAPSHOT_METRICS: &[&str] = &[
    "tvl",
    "utilization",
    "oracle_price",
    "cumulative_bad_debt",
    "cumulative_liquidations",
    "active_agents",
    "tick",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Adapter {
        toml::from_str(s).expect("parse adapter")
    }

    #[test]
    fn parses_empty_invariants_block_when_absent() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"#,
        );
        assert!(adapter.invariants.is_empty());
    }

    #[test]
    fn parses_invariants_block_with_all_ops() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[invariants]]
name = "bad_debt_never_accrues"
field = "cumulative_bad_debt"
op = "=="
value = 0

[[invariants]]
field = "tvl"
op = ">="
value = 0

[[invariants]]
field = "utilization"
op = "<"
value = 1.5

[[invariants]]
field = "tvl"
op = "!="
value = -1

[[invariants]]
field = "tvl"
op = ">"
value = 0

[[invariants]]
field = "tvl"
op = "<="
value = 9999999
"#,
        );
        assert_eq!(adapter.invariants.len(), 6);
        assert_eq!(
            adapter.invariants[0].name.as_deref(),
            Some("bad_debt_never_accrues")
        );
        assert_eq!(adapter.invariants[0].op, InvariantOp::Eq);
        assert_eq!(adapter.invariants[0].value, 0.0);
        assert!(adapter.invariants[1].name.is_none());
        assert_eq!(adapter.invariants[1].op, InvariantOp::Gte);
        assert_eq!(adapter.invariants[2].op, InvariantOp::Lt);
        assert_eq!(adapter.invariants[3].op, InvariantOp::NotEq);
        assert_eq!(adapter.invariants[4].op, InvariantOp::Gt);
        assert_eq!(adapter.invariants[5].op, InvariantOp::Lte);
    }

    #[test]
    fn invariant_op_apply_matches_semantics() {
        assert!(InvariantOp::Eq.apply(1.0, 1.0));
        assert!(!InvariantOp::Eq.apply(1.0, 2.0));
        assert!(InvariantOp::NotEq.apply(1.0, 2.0));
        assert!(InvariantOp::Gte.apply(2.0, 2.0));
        assert!(InvariantOp::Gt.apply(3.0, 2.0));
        assert!(!InvariantOp::Gt.apply(2.0, 2.0));
        assert!(InvariantOp::Lte.apply(2.0, 2.0));
        assert!(InvariantOp::Lt.apply(1.0, 2.0));
    }

    #[test]
    fn invariant_display_name_falls_back_to_index() {
        let inv = Invariant {
            name: None,
            field: "tvl".into(),
            op: InvariantOp::Gte,
            value: 0.0,
        };
        assert_eq!(inv.display_name(3), "inv_3");
    }

    #[test]
    fn invariant_value_accepts_integer_and_float_literals() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[invariants]]
field = "tvl"
op = "=="
value = 42

[[invariants]]
field = "tvl"
op = "=="
value = 42.5
"#,
        );
        assert_eq!(adapter.invariants[0].value, 42.0);
        assert_eq!(adapter.invariants[1].value, 42.5);
    }

    #[test]
    fn invariant_op_roundtrips_through_json() {
        for op in [
            InvariantOp::Eq,
            InvariantOp::NotEq,
            InvariantOp::Gte,
            InvariantOp::Lte,
            InvariantOp::Gt,
            InvariantOp::Lt,
        ] {
            let s = serde_json::to_string(&op).unwrap();
            let back: InvariantOp = serde_json::from_str(&s).unwrap();
            assert_eq!(op, back);
            assert_eq!(s.trim_matches('"'), op.as_str());
        }
    }

    #[test]
    fn adapter_without_lineage_block_parses_as_none() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"#,
        );
        assert!(adapter.lineage.is_none());
    }

    #[test]
    fn adapter_with_lineage_block_parses_all_fields() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[lineage]
idl_source = "programs/lending_pool/src/state.rs"
generator = "hand-authored"
inferred_assumptions = [
    "Lending primitive supplies the dispatch table — no [actions] block needed",
    "Lazy-init pool on first touch",
]
unsupported_fields = [
    "InitializeOracle",
    "SetOraclePrice",
]
"#,
        );
        let lineage = adapter.lineage.expect("lineage present");
        assert_eq!(
            lineage.idl_source.as_deref(),
            Some("programs/lending_pool/src/state.rs"),
        );
        assert_eq!(lineage.generator.as_deref(), Some("hand-authored"));
        assert_eq!(lineage.inferred_assumptions.len(), 2);
        assert_eq!(
            lineage.unsupported_fields,
            vec!["InitializeOracle", "SetOraclePrice"]
        );
    }

    #[test]
    fn adapter_with_empty_lineage_block_keeps_field_defaults() {
        let adapter = parse(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[lineage]
"#,
        );
        let lineage = adapter.lineage.expect("lineage present even when empty");
        assert!(lineage.idl_source.is_none());
        assert!(lineage.generator.is_none());
        assert!(lineage.inferred_assumptions.is_empty());
        assert!(lineage.unsupported_fields.is_empty());
    }

    #[test]
    fn adapter_with_typoed_lineage_key_fails_to_parse() {
        // A typo like `unsupported_field` (singular — not
        // `unsupported_fields`) must fail the adapter load, not
        // silently render as "(none recorded)" in `riptide lineage`.
        // `#[serde(deny_unknown_fields)]` on AdapterLineage enforces
        // this.
        let err: Result<Adapter, _> = toml::from_str(
            r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[lineage]
unsupported_field = ["typoed singular, not plural"]
"#,
        );
        let msg = err.expect_err("typoed lineage key must reject").to_string();
        assert!(
            msg.contains("unsupported_field"),
            "error must name the offending typoed key: {msg}",
        );
    }
}
