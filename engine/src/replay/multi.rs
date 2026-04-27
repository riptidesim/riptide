//! Multi-component replay composition.
//!
//! Two shipping single-program replay bundles boot into the same
//! `LiteSVM` world, a declared bridge reads an upstream observation
//! and writes a derived downstream oracle update deterministically,
//! and qualified snapshot keys (`<component>.<field>`) flow through
//! the existing invariant surface unchanged.
//!
//! This module is replay-only composition. It does NOT implement a
//! general multi-program scenario engine, an arbitrary cross-program
//! transaction graph, or multi-oracle dispatch semantics. It is the
//! minimum honest plumbing for the Sprint 11 cross-protocol contagion
//! proof.
//!
//! ## Config shape
//!
//! Legacy single-component replay configs
//! (`{ adapter, trajectory_dir, output_path }`) keep working
//! unchanged. A multi-component config declares explicit named
//! components and optional declared bridges:
//!
//! ```json
//! {
//!   "components": [
//!     { "name": "liquid_staking",
//!       "adapter": "./liquid-staking/adapter.toml",
//!       "trajectory_dir": "./liquid-staking" },
//!     { "name": "lending",
//!       "adapter": "./lending/adapter.toml",
//!       "trajectory_dir": "./lending" }
//!   ],
//!   "bridges": [
//!     { "name": "lst_exchange_rate_to_lending_oracle",
//!       "source_component": "liquid_staking",
//!       "source_field": "pool.exchange_rate_bps",
//!       "target_component": "lending",
//!       "target_oracle": "collateral_price_feed",
//!       "transform": { "kind": "bps-ratio",
//!                      "base_price": 100.0, "denominator": 10000.0 } }
//!   ],
//!   "output_path": "riptide-output/replays/lst-lending-contagion-proof"
//! }
//! ```
//!
//! ## Determinism contract
//!
//! On every tick `t`:
//! 1. Each component advances one tick in declaration order.
//! 2. Each component's own oracle trajectory update (if any) and
//!    declared replay instructions are dispatched against the shared
//!    `LiteSVM`.
//! 3. After the upstream component's tick lands, every bridge sourced
//!    from it reads the post-tick qualified observation, applies the
//!    transform, and writes the derived value into the target
//!    component's bound oracle.
//! 4. The downstream component's tick then sees the mutated oracle.
//!
//! The ordering is explicit and stable: the component that appears
//! first in the config is upstream for every bridge evaluated at the
//! boundary, which keeps same-tick contagion reviewable instead of
//! folded into a nondeterministic global schedule.

#![cfg(any(feature = "litesvm-backend", test))]

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};
use litesvm::LiteSVM;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use solana_account::Account;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use solana_transaction::{Transaction, TransactionError};

use crate::{
    adapter::{load_adapter, Adapter, ArgLiteral, Invariant, OracleKind, Protocol},
    agent::state::Agent,
    harness::{
        lending::{LendingPoolConfig, LendingProgramClient},
        setup::{load_program_bytes, ORACLE_STATE_LEN, POOL_STATE_LEN, POSITION_STATE_LEN},
    },
    primitive::{
        generic::{
            bootstrap_generic_accounts, generic_airdrop, load_generic_idl,
            load_generic_program_bytes, observe_account_state, GenericIdl,
            GenericInstructionBuilder, RuntimeOracleBinding,
        },
        lending_pool::{airdrop as lending_airdrop, send_tx as lending_send_tx},
        PrimitiveError,
    },
    replay::run::{load_replay_bundle, ReplayBundle},
    scenario::{oracle_layout_for, OracleUpdate},
    sim::run::{build_invariants_summary, evaluate_invariants, SimulationAbort},
    types::{
        AgentStatus, InvariantViolation, ObservationValue, Policy, PositionSizing,
        PositionSizingStrategy, RunConfig, SimEvent, SimOutcome, SimulationResult, TickSnapshot,
        Trigger,
    },
};

// ---------------------------------------------------------------------------
// Config shapes
// ---------------------------------------------------------------------------

/// A replay configuration on disk may be either the legacy
/// single-component shape or the new multi-component shape. The loader
/// keeps both paths alive so every shipping fixture in `fixtures/replays`
/// keeps booting through the existing single-component replay path
/// without migration.
#[derive(Debug, Clone)]
pub enum ReplayConfigShape {
    Legacy(LegacyReplayConfig),
    Multi(MultiReplayConfig),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LegacyReplayConfig {
    pub adapter: String,
    pub trajectory_dir: String,
    pub output_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MultiReplayConfig {
    pub components: Vec<ComponentEntry>,
    #[serde(default)]
    pub bridges: Vec<BridgeDef>,
    pub output_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentEntry {
    pub name: String,
    pub adapter: String,
    pub trajectory_dir: String,
}

/// Declared bridge that reads a qualified observation from an upstream
/// component and writes a derived value into a downstream component's
/// named oracle. Sprint 11 keeps this intentionally narrow: one scalar
/// observation → one scalar oracle update.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeDef {
    pub name: String,
    pub source_component: String,
    pub source_field: String,
    pub target_component: String,
    pub target_oracle: String,
    pub transform: BridgeTransform,
}

/// Bridge transforms supported in Sprint 11. `kind` is a serde tag so
/// adding further shapes later stays additive without breaking existing
/// bridge configs. `bps-ratio` is the shape the Sprint 11 LST → lending
/// contagion proof uses: an LST exchange rate expressed in basis points
/// is scaled into a target oracle price via
/// `base_price * (observation / denominator)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BridgeTransform {
    BpsRatio {
        base_price: f64,
        denominator: f64,
        #[serde(default)]
        exponent: Option<i8>,
    },
}

impl BridgeTransform {
    fn apply(&self, observation: f64) -> Result<OracleUpdate> {
        match self {
            BridgeTransform::BpsRatio {
                base_price,
                denominator,
                exponent,
            } => {
                if !denominator.is_finite() || *denominator == 0.0 {
                    bail!(
                        "bridge transform bps-ratio: denominator must be a non-zero finite \
                         number, got {denominator}"
                    );
                }
                if !base_price.is_finite() {
                    bail!(
                        "bridge transform bps-ratio: base_price must be finite, got {base_price}"
                    );
                }
                if !observation.is_finite() {
                    bail!("bridge transform bps-ratio: observed value is non-finite");
                }
                let price = base_price * (observation / denominator);
                if !price.is_finite() || price < 0.0 {
                    bail!(
                        "bridge transform bps-ratio: produced invalid price {price} \
                         (observation={observation})"
                    );
                }
                Ok(OracleUpdate {
                    price,
                    exponent: exponent.unwrap_or(0),
                })
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/// Maximum byte length for replay-config identifiers (component
/// names, bridge names, bridge target_oracle, bridge source_field).
/// Matches the adapter-identifier cap so reviewer-forwardable
/// diagnostics stay consistent in length across the CLI + pack
/// surfaces.
const MULTI_IDENT_MAX_LEN: usize = 128;

/// Restrict replay-config component / bridge / target_oracle names to
/// a safe identifier set: ASCII alphanumerics, `_`, and `-`. **No `.`**
/// (would create ambiguous `<component>.<field>` qualified keys, e.g.
/// component = "a.b" + field "c" colliding with component = "a" +
/// field "b.c"). No whitespace, no path separators, no control
/// characters. Non-ASCII is rejected entirely so a reviewer's terminal
/// cannot be handed hostile bytes through these names.
fn is_safe_multi_identifier(name: &str) -> bool {
    if name.is_empty() || name.len() > MULTI_IDENT_MAX_LEN {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Slightly looser validator for `bridges[*].source_field`. It points
/// into an existing qualified snapshot key, so `.` is legitimate
/// (`pool.exchange_rate_bps`). Still rejects whitespace / control
/// characters / path separators so nothing hostile lands in pack
/// trace rows.
fn is_safe_qualified_field(field: &str) -> bool {
    if field.is_empty() || field.len() > MULTI_IDENT_MAX_LEN {
        return false;
    }
    field
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Load any replay config file. Distinguishes legacy
/// (`{ adapter, trajectory_dir, output_path }`) and multi-component
/// (`{ components: [...], ... }`) shapes by presence of the `components`
/// key. Every shipping single-component fixture stays on the legacy
/// path untouched.
pub fn load_replay_config(path: &Path) -> Result<ReplayConfigShape> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read replay config {}", path.display()))?;
    parse_replay_config(&raw)
}

/// String-level parser so callers can feed snippet configs to tests
/// without touching disk.
pub fn parse_replay_config(raw: &str) -> Result<ReplayConfigShape> {
    let value: Value = serde_json::from_str(raw).context("parse replay config JSON")?;
    let obj = value
        .as_object()
        .ok_or_else(|| anyhow!("replay config must be a JSON object"))?;
    if obj.contains_key("components") {
        let cfg: MultiReplayConfig =
            serde_json::from_value(value).context("parse multi-component replay config")?;
        if cfg.components.len() < 2 {
            bail!(
                "multi-component replay config declares {} component(s); at least 2 are required — \
                 drop the `components` key to use the single-component shape instead",
                cfg.components.len()
            );
        }
        // Index components by declaration order; the runtime runs
        // components in this order each tick and fires bridges
        // sourced from a component immediately after it ticks
        // (see `run_multi_replay`). A bridge whose `source_component`
        // appears AFTER its `target_component` in the declaration
        // order would silently degrade into "target sees the update
        // next tick", not "same-tick propagation", which breaks the
        // Sprint 11 contagion-ordering contract (R2.2). Reject those
        // configs at parse time instead.
        let mut seen = BTreeSet::new();
        let mut order: BTreeMap<String, usize> = BTreeMap::new();
        for (idx, component) in cfg.components.iter().enumerate() {
            if component.name.trim().is_empty() {
                bail!("multi-component replay config has a component with an empty name");
            }
            if !is_safe_multi_identifier(&component.name) {
                bail!(
                    "multi-component replay config: `components[{idx}].name = {:?}` must match \
                     `[A-Za-z0-9_-]+` (1..={MULTI_IDENT_MAX_LEN} chars). The name flows into \
                     qualified snapshot keys like `<component>.<field>`, namespaced event ids, \
                     pack traces, and the CLI's default output directory — `.`, whitespace, \
                     path separators, and control characters are rejected so an author cannot \
                     create ambiguous qualified keys, inject ANSI sequences into operator \
                     output, or escape the default artifact subtree.",
                    component.name,
                );
            }
            if !seen.insert(component.name.clone()) {
                bail!(
                    "multi-component replay config declares duplicate component name `{}`",
                    component.name
                );
            }
            order.insert(component.name.clone(), idx);
        }
        for (idx, bridge) in cfg.bridges.iter().enumerate() {
            if bridge.name.trim().is_empty() {
                bail!("multi-component replay config has a bridge with an empty name");
            }
            if !is_safe_multi_identifier(&bridge.name) {
                bail!(
                    "multi-component replay config: `bridges[{idx}].name = {:?}` must match \
                     `[A-Za-z0-9_-]+` (1..={MULTI_IDENT_MAX_LEN} chars). Bridge names flow \
                     into event action ids like `bridge:<name>` and pack trace rows — \
                     control characters, whitespace, and path separators are rejected.",
                    bridge.name,
                );
            }
            if !is_safe_multi_identifier(&bridge.target_oracle) {
                bail!(
                    "multi-component replay config: `bridges[{idx}].target_oracle = {:?}` \
                     must match `[A-Za-z0-9_-]+` (1..={MULTI_IDENT_MAX_LEN} chars). The \
                     value flows into pack trace rows and event params verbatim — control \
                     characters, whitespace, and path separators are rejected.",
                    bridge.target_oracle,
                );
            }
            if !is_safe_qualified_field(&bridge.source_field) {
                bail!(
                    "multi-component replay config: `bridges[{idx}].source_field = {:?}` \
                     must match `[A-Za-z0-9_.-]+` (1..={MULTI_IDENT_MAX_LEN} chars) — it is \
                     a qualified `<account>.<field>` reference into the upstream snapshot, \
                     but control characters, whitespace, and path separators are rejected.",
                    bridge.source_field,
                );
            }
            // Cross-reference identifiers must pass the same
            // fail-closed contract as the declarations they point at.
            // Otherwise a hostile bridge with source_component =
            // "ghost\nline" that happens to not match any declared
            // component would inject newlines / ANSI escapes into
            // the unknown-component diagnostic below.
            if !is_safe_multi_identifier(&bridge.source_component) {
                bail!(
                    "multi-component replay config: `bridges[{idx}].source_component = {:?}` \
                     must match `[A-Za-z0-9_-]+` (1..={MULTI_IDENT_MAX_LEN} chars). The value \
                     must identify a declared component by name; control characters, \
                     whitespace, and path separators are rejected so a bad reference cannot \
                     inject hostile bytes into operator-visible parser diagnostics.",
                    bridge.source_component,
                );
            }
            if !is_safe_multi_identifier(&bridge.target_component) {
                bail!(
                    "multi-component replay config: `bridges[{idx}].target_component = {:?}` \
                     must match `[A-Za-z0-9_-]+` (1..={MULTI_IDENT_MAX_LEN} chars). The value \
                     must identify a declared component by name; control characters, \
                     whitespace, and path separators are rejected so a bad reference cannot \
                     inject hostile bytes into operator-visible parser diagnostics.",
                    bridge.target_component,
                );
            }
            // Defense in depth: even after the contract check above,
            // render the echoed names with `{:?}` so any future path
            // that reaches this arm still escapes control bytes in
            // the operator-visible message.
            let source_idx = *order.get(&bridge.source_component).ok_or_else(|| {
                anyhow!(
                    "bridge {:?} references unknown source component {:?}",
                    bridge.name,
                    bridge.source_component
                )
            })?;
            let target_idx = *order.get(&bridge.target_component).ok_or_else(|| {
                anyhow!(
                    "bridge {:?} references unknown target component {:?}",
                    bridge.name,
                    bridge.target_component
                )
            })?;
            if bridge.source_component == bridge.target_component {
                bail!(
                    "bridge {:?}: source and target components must differ; \
                     cross-component propagation is the point",
                    bridge.name
                );
            }
            if source_idx >= target_idx {
                bail!(
                    "bridge {:?} declares source {:?} (index {}) after target {:?} (index {}); \
                     the ordering contract is upstream-first, so the source component must \
                     appear BEFORE the target in `components`. Reorder `components` so that \
                     upstream declaration precedes downstream, or the same-tick propagation \
                     guarantee is silently violated.",
                    bridge.name,
                    bridge.source_component,
                    source_idx,
                    bridge.target_component,
                    target_idx,
                );
            }
        }
        Ok(ReplayConfigShape::Multi(cfg))
    } else {
        let cfg: LegacyReplayConfig =
            serde_json::from_value(value).context("parse legacy replay config")?;
        Ok(ReplayConfigShape::Legacy(cfg))
    }
}

// ---------------------------------------------------------------------------
// Component bootstrap
// ---------------------------------------------------------------------------

/// Per-component state bag. Identity lives at this level so the caller
/// can refer to `liquid_staking.pool.exchange_rate_bps` /
/// `lending.pool.bad_debt` unambiguously. Runtime variants carry the
/// primitive-specific handles needed to dispatch actions, push oracle
/// updates, and read observations against the shared `LiteSVM`.
pub struct ComponentSlot {
    pub name: String,
    pub adapter: Adapter,
    pub bundle: ReplayBundle,
    pub actor_ids: Vec<String>,
    pub total_ticks: u32,
    pub starting_price: f64,
    pub runtime: ComponentRuntime,
}

pub enum ComponentRuntime {
    Generic(GenericComponent),
    Lending(LendingComponent),
}

pub struct GenericComponent {
    program_id: Pubkey,
    admin: Keypair,
    agents: Vec<Keypair>,
    idl: GenericIdl,
    agent_accounts: BTreeMap<String, Vec<Pubkey>>,
    shared_accounts: BTreeMap<String, Pubkey>,
    oracle_binding: Option<RuntimeOracleBinding>,
}

pub struct LendingComponent {
    #[allow(dead_code)]
    program_id: Pubkey,
    client: LendingProgramClient,
    admin: Keypair,
    agents: Vec<Keypair>,
    pool: Pubkey,
    oracle: Pubkey,
    positions: Vec<Pubkey>,
    last_oracle_price: f64,
    oracle_kind: OracleKind,
}

/// Coordinator owning the shared `LiteSVM` and the per-component state.
/// One tick loop runs across both components; the declared bridges are
/// evaluated at the boundary each tick.
pub struct MultiComponentHarness {
    svm: LiteSVM,
    components: Vec<ComponentSlot>,
    current_slot: u64,
    pub bridges: Vec<BridgeDef>,
}

impl MultiComponentHarness {
    /// Bootstrap the shared `LiteSVM` with one program per component.
    /// `base_path` is the directory the config file lives in; relative
    /// `adapter` / `trajectory_dir` paths resolve from it.
    pub fn bootstrap(config: &MultiReplayConfig, base_path: &Path) -> Result<Self> {
        if config.components.len() < 2 {
            bail!(
                "multi-component replay requires at least 2 components; got {}",
                config.components.len()
            );
        }
        // Pre-load adapters and bundles so we know the total lamport
        // headroom before constructing the shared LiteSVM.
        let mut prepared: Vec<(ComponentEntry, Adapter, ReplayBundle)> =
            Vec::with_capacity(config.components.len());
        for entry in &config.components {
            let adapter_path = resolve_path(base_path, &entry.adapter);
            let trajectory_dir = resolve_path(base_path, &entry.trajectory_dir);
            let adapter = load_adapter(&adapter_path)
                .map_err(|e| anyhow!("component `{}`: load adapter: {e}", entry.name))?;
            let bundle = load_replay_bundle(&trajectory_dir, &adapter)
                .with_context(|| format!("component `{}`: load replay bundle", entry.name))?;
            prepared.push((entry.clone(), adapter, bundle));
        }

        let total_agents: usize = prepared.iter().map(|(_, _, b)| b.actor_ids.len()).sum();
        let identity_count = (total_agents as u64) + (prepared.len() as u64);
        let per_identity_lamports: u64 = 10_000_000_000;
        let base_lamports = identity_count
            .saturating_mul(per_identity_lamports)
            .saturating_mul(2);
        let mut svm = LiteSVM::new()
            .with_builtins()
            .with_sysvars()
            .with_lamports(base_lamports);

        let mut components: Vec<ComponentSlot> = Vec::with_capacity(prepared.len());
        for (entry, adapter, bundle) in prepared {
            let starting_price = bundle.starting_price;
            let total_ticks = bundle.total_ticks;
            let actor_ids = bundle.actor_ids.clone();
            let runtime = match adapter.protocol {
                Protocol::Generic => ComponentRuntime::Generic(bootstrap_generic_component(
                    &mut svm,
                    base_path,
                    &adapter,
                    bundle.actor_ids.len(),
                )?),
                Protocol::Lending => ComponentRuntime::Lending(bootstrap_lending_component(
                    &mut svm,
                    &adapter,
                    bundle.actor_ids.len(),
                    bundle.starting_price,
                    bundle.starting_exponent,
                )?),
            };
            components.push(ComponentSlot {
                name: entry.name,
                adapter,
                bundle,
                actor_ids,
                total_ticks,
                starting_price,
                runtime,
            });
        }

        Ok(Self {
            svm,
            components,
            current_slot: 0,
            bridges: config.bridges.clone(),
        })
    }

    /// Component handles exposed for tests that need to inspect the
    /// shared LiteSVM's view of an individual component.
    pub fn components(&self) -> &[ComponentSlot] {
        &self.components
    }

    pub fn svm(&self) -> &LiteSVM {
        &self.svm
    }

    fn component_index(&self, name: &str) -> Result<usize> {
        self.components
            .iter()
            .position(|c| c.name == name)
            .ok_or_else(|| anyhow!("component `{name}` not declared in replay config"))
    }

    // ---- Per-component primitive surface ----

    fn advance_tick_all(&mut self) {
        self.current_slot += 1;
        self.svm.warp_to_slot(self.current_slot);
        self.svm.expire_blockhash();
    }

    fn push_oracle_price(
        &mut self,
        component_idx: usize,
        update: &OracleUpdate,
    ) -> Result<(), PrimitiveError> {
        let component = &mut self.components[component_idx];
        match &mut component.runtime {
            ComponentRuntime::Generic(state) => {
                push_generic_oracle(&mut self.svm, state, update)
            }
            ComponentRuntime::Lending(state) => {
                push_lending_oracle(&mut self.svm, state, update)
            }
        }
    }

    fn execute_replay_action(
        &mut self,
        component_idx: usize,
        agent_idx: usize,
        action: &str,
        args: &BTreeMap<String, ArgLiteral>,
        target_idx: Option<usize>,
    ) -> Result<(), PrimitiveError> {
        let component = &self.components[component_idx];
        match &component.runtime {
            ComponentRuntime::Generic(_) => {
                let adapter = component.adapter.clone();
                let state_ptr = match &mut self.components[component_idx].runtime {
                    ComponentRuntime::Generic(s) => s,
                    _ => unreachable!(),
                };
                execute_generic_replay(
                    &mut self.svm,
                    state_ptr,
                    &adapter,
                    agent_idx,
                    action,
                    args,
                )
            }
            ComponentRuntime::Lending(_) => {
                let state_ptr = match &mut self.components[component_idx].runtime {
                    ComponentRuntime::Lending(s) => s,
                    _ => unreachable!(),
                };
                execute_lending_replay(
                    &mut self.svm,
                    state_ptr,
                    agent_idx,
                    action,
                    args,
                    target_idx,
                )
            }
        }
    }

    pub fn agent_count(&self, component_idx: usize) -> usize {
        let component = &self.components[component_idx];
        match &component.runtime {
            ComponentRuntime::Generic(s) => s.agents.len(),
            ComponentRuntime::Lending(s) => s.agents.len(),
        }
    }

    /// Read one component's per-agent observation set. Used by bridge
    /// evaluation and invariant snapshot construction.
    pub fn observation_values(
        &self,
        component_idx: usize,
        agent_idx: usize,
    ) -> Result<BTreeMap<String, ObservationValue>, PrimitiveError> {
        let component = &self.components[component_idx];
        match &component.runtime {
            ComponentRuntime::Generic(state) => {
                generic_observation_values(&self.svm, state, &component.adapter, agent_idx)
            }
            ComponentRuntime::Lending(state) => {
                lending_observation_values(&self.svm, state, agent_idx)
            }
        }
    }

    /// Build one component's per-tick metric column. Generic components
    /// aggregate adapter-declared observations; lending components emit
    /// the same `tvl`/`utilization`/`oracle_price`/`cumulative_bad_debt`
    /// keys the single-program lending replay already produces. The
    /// coordinator tags every key with `<component>.<key>` so the
    /// invariant surface can reference them unambiguously.
    pub fn snapshot_metrics(
        &self,
        component_idx: usize,
    ) -> Result<BTreeMap<String, Value>, PrimitiveError> {
        let component = &self.components[component_idx];
        match &component.runtime {
            ComponentRuntime::Generic(state) => {
                generic_snapshot_metrics(&self.svm, state, &component.adapter)
            }
            ComponentRuntime::Lending(state) => {
                lending_snapshot_metrics(&self.svm, state)
            }
        }
    }

    // ---- Bridge ----

    /// Evaluate every bridge sourced from `source_component`. Called
    /// after the upstream tick lands and before the downstream
    /// component's tick runs. Returns the list of (target_component,
    /// bridge_name, oracle_update) triples actually applied, for the
    /// event log.
    ///
    /// `pub(crate)` so tests in the replay module can exercise the
    /// bridge evaluator without running a full tick loop.
    pub(crate) fn evaluate_bridges_for_source(
        &mut self,
        source_component: &str,
    ) -> Result<Vec<BridgeFiring>, SimulationAbort> {
        let matching: Vec<BridgeDef> = self
            .bridges
            .iter()
            .filter(|b| b.source_component == source_component)
            .cloned()
            .collect();
        let mut firings = Vec::with_capacity(matching.len());
        for bridge in matching {
            let observation = read_qualified_observation(self, &bridge.source_component, &bridge.source_field)
                .map_err(|e| SimulationAbort::BadInput(format!(
                    "bridge `{}`: {e}",
                    bridge.name
                )))?;
            let update = bridge.transform.apply(observation).map_err(|e| {
                SimulationAbort::BadInput(format!("bridge `{}`: {e}", bridge.name))
            })?;
            let target_idx = self.component_index(&bridge.target_component).map_err(|e| {
                SimulationAbort::BadInput(format!("bridge `{}`: {e}", bridge.name))
            })?;
            // Validate target_oracle names the bound oracle on the
            // target component — the bridge should not write to an
            // oracle the target adapter does not expose. For lending
            // components the harness owns exactly one oracle account,
            // so the name is advisory; for generic components the
            // adapter's `[[oracles]][0].name` must match.
            validate_bridge_target_oracle(&self.components[target_idx], &bridge).map_err(
                |e| SimulationAbort::BadInput(format!("bridge `{}`: {e}", bridge.name)),
            )?;
            self.push_oracle_price(target_idx, &update).map_err(|e| match e {
                PrimitiveError::Infra(msg) => SimulationAbort::Infra(msg),
                PrimitiveError::ProgramRejected(msg) => {
                    SimulationAbort::Infra(format!("bridge oracle write rejected: {msg}"))
                }
            })?;
            firings.push(BridgeFiring {
                name: bridge.name.clone(),
                source_component: bridge.source_component.clone(),
                source_field: bridge.source_field.clone(),
                target_component: bridge.target_component.clone(),
                target_oracle: bridge.target_oracle.clone(),
                observation,
                update,
            });
        }
        Ok(firings)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct BridgeFiring {
    name: String,
    source_component: String,
    source_field: String,
    target_component: String,
    target_oracle: String,
    observation: f64,
    update: OracleUpdate,
}

fn validate_bridge_target_oracle(target: &ComponentSlot, bridge: &BridgeDef) -> Result<()> {
    match &target.runtime {
        ComponentRuntime::Generic(_) => {
            let matched = target
                .adapter
                .oracles
                .iter()
                .any(|o| o.name == bridge.target_oracle);
            if !matched {
                bail!(
                    "target component `{}` declares no `[[oracles]]` entry named `{}`; \
                     the bridge must target a declared oracle so the write is inspectable",
                    target.name,
                    bridge.target_oracle
                );
            }
        }
        ComponentRuntime::Lending(_) => {
            // Lending harness owns a single oracle account (Solend
            // fork). Accept any non-empty target oracle name as
            // advisory; still reject empty names so the artifact
            // stays inspectable.
            if bridge.target_oracle.trim().is_empty() {
                bail!(
                    "target component `{}` is a lending component; target_oracle must be \
                     a non-empty advisory name for the shared oracle account",
                    target.name
                );
            }
        }
    }
    Ok(())
}

fn read_qualified_observation(
    harness: &MultiComponentHarness,
    component_name: &str,
    field: &str,
) -> Result<f64> {
    let idx = harness
        .components
        .iter()
        .position(|c| c.name == component_name)
        .ok_or_else(|| anyhow!("unknown component `{component_name}`"))?;
    let metrics = harness
        .snapshot_metrics(idx)
        .map_err(|e| anyhow!("{e:?}"))?;
    let value = metrics
        .get(field)
        .ok_or_else(|| anyhow!(
            "source field `{field}` missing from component `{component_name}` snapshot; \
             available keys: {available:?}",
            available = metrics.keys().collect::<Vec<_>>()
        ))?;
    value_to_f64(value).ok_or_else(|| {
        anyhow!("source field `{field}` is non-numeric in component `{component_name}`")
    })
}

fn value_to_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|i| i as f64))
        .or_else(|| v.as_u64().map(|u| u as f64))
}

// ---------------------------------------------------------------------------
// Generic component plumbing
// ---------------------------------------------------------------------------

fn bootstrap_generic_component(
    svm: &mut LiteSVM,
    _base_path: &Path,
    adapter: &Adapter,
    agent_count: usize,
) -> Result<GenericComponent> {
    // `load_adapter` rewrites generic `program_so` / `idl_path` to be
    // relative to the adapter file's own parent (same contract the
    // single-component replay path relies on), so the adapter struct
    // already carries paths that resolve correctly against the current
    // working directory. Do NOT re-resolve them against the config's
    // base_path — that would double-prefix the adapter parent onto an
    // already-rewritten path when the config points at a sibling
    // adapter via a relative `../other/adapter.toml`.
    let program_so = PathBuf::from(
        adapter
            .program_so
            .as_deref()
            .ok_or_else(|| anyhow!("generic component adapter is missing `program_so`"))?,
    );
    let idl_path = PathBuf::from(
        adapter
            .idl_path
            .as_deref()
            .ok_or_else(|| anyhow!("generic component adapter is missing `idl_path`"))?,
    );

    let program_bytes = load_generic_program_bytes(&program_so)?;
    let idl = load_generic_idl(&idl_path)?;

    let program_id = Pubkey::new_unique();
    svm.add_program(program_id, &program_bytes).map_err(|e| {
        anyhow!("failed to load generic program into shared LiteSVM: {e}")
    })?;

    let per_identity_lamports: u64 = 10_000_000_000;
    let admin = Keypair::new();
    generic_airdrop(svm, &admin.pubkey(), per_identity_lamports)?;
    let agents: Vec<Keypair> = (0..agent_count).map(|_| Keypair::new()).collect();
    for agent in &agents {
        generic_airdrop(svm, &agent.pubkey(), per_identity_lamports)?;
    }

    let (agent_accounts, shared_accounts, oracle_binding) =
        bootstrap_generic_accounts(svm, adapter, agent_count, &program_id, &admin.pubkey())?;

    Ok(GenericComponent {
        program_id,
        admin,
        agents,
        idl,
        agent_accounts,
        shared_accounts,
        oracle_binding,
    })
}

fn push_generic_oracle(
    svm: &mut LiteSVM,
    state: &GenericComponent,
    update: &OracleUpdate,
) -> Result<(), PrimitiveError> {
    let Some(binding) = state.oracle_binding.clone() else {
        return Ok(());
    };
    let pubkey = state
        .shared_accounts
        .get(&binding.account_name)
        .copied()
        .ok_or_else(|| {
            PrimitiveError::Infra(format!(
                "generic component oracle binding targets `{}` but no such shared account \
                 exists on the component",
                binding.account_name
            ))
        })?;
    let existing = svm.get_account(&pubkey).ok_or_else(|| {
        PrimitiveError::Infra(format!(
            "generic component oracle account `{}` vanished between bootstrap and write",
            binding.account_name
        ))
    })?;
    let layout = oracle_layout_for(binding.kind);
    let encoded = layout
        .encode(state.admin.pubkey().to_bytes(), update)
        .map_err(|e| {
            PrimitiveError::Infra(format!(
                "oracle layout `{:?}` failed to encode update for `{}`: {e}",
                binding.kind, binding.account_name
            ))
        })?;
    if existing.data.len() < encoded.len() {
        return Err(PrimitiveError::Infra(format!(
            "generic component oracle `{}` has {} bytes of space but layout `{:?}` \
             needs at least {}",
            binding.account_name,
            existing.data.len(),
            binding.kind,
            encoded.len()
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
    svm.set_account(pubkey, new_account).map_err(|e| {
        PrimitiveError::Infra(format!(
            "failed to write oracle bytes into `{}`: {e:?}",
            binding.account_name
        ))
    })?;
    Ok(())
}

fn execute_generic_replay(
    svm: &mut LiteSVM,
    state: &mut GenericComponent,
    adapter: &Adapter,
    agent_idx: usize,
    action: &str,
    args: &BTreeMap<String, ArgLiteral>,
) -> Result<(), PrimitiveError> {
    let builder = GenericInstructionBuilder::new(&state.idl, adapter);
    let instruction = builder
        .resolve_instruction_for_replay(action)
        .map_err(|e| PrimitiveError::ProgramRejected(e.to_string()))?;
    let data = builder
        .build_replay_data(action, args)
        .map_err(|e| PrimitiveError::ProgramRejected(e.to_string()))?;
    let accounts_iter: Vec<AccountMeta> = instruction
        .accounts
        .iter()
        .map(|account| resolve_generic_account_meta(state, agent_idx, account))
        .collect::<Result<Vec<_>, PrimitiveError>>()?;
    let payer = if instruction
        .accounts
        .iter()
        .any(|a| a.signer && a.name.eq_ignore_ascii_case("admin"))
    {
        state.admin.insecure_clone()
    } else {
        state
            .agents
            .get(agent_idx)
            .ok_or_else(|| {
                PrimitiveError::Infra(format!(
                    "generic component agent signer idx {agent_idx} out of range"
                ))
            })?
            .insecure_clone()
    };
    let ix = Instruction {
        program_id: state.program_id,
        accounts: accounts_iter,
        data,
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[&payer],
        blockhash,
    );
    match svm.send_transaction(tx) {
        Ok(_) => Ok(()),
        Err(err) => match err.err {
            TransactionError::InstructionError(_, _) => {
                Err(PrimitiveError::ProgramRejected(format!("{:?}", err.err)))
            }
            other => Err(PrimitiveError::Infra(format!("{other:?}"))),
        },
    }
}

fn resolve_generic_account_meta(
    state: &GenericComponent,
    agent_idx: usize,
    account: &crate::primitive::generic::GenericInstructionAccount,
) -> Result<AccountMeta, PrimitiveError> {
    let pubkey = if let Some(pubkeys) = state.agent_accounts.get(&account.name) {
        *pubkeys.get(agent_idx).ok_or_else(|| {
            PrimitiveError::Infra(format!(
                "generic component agent account `{}` missing idx {agent_idx}",
                account.name
            ))
        })?
    } else if let Some(p) = state.shared_accounts.get(&account.name) {
        *p
    } else if account.signer {
        if account.name.eq_ignore_ascii_case("admin") {
            state.admin.pubkey()
        } else {
            state
                .agents
                .get(agent_idx)
                .ok_or_else(|| {
                    PrimitiveError::Infra(format!(
                        "generic component agent signer idx {agent_idx} out of range"
                    ))
                })?
                .pubkey()
        }
    } else {
        return Err(PrimitiveError::Infra(format!(
            "generic instruction account `{}` is not declared and not a recognized signer",
            account.name
        )));
    };
    Ok(if account.writable {
        AccountMeta::new(pubkey, account.signer)
    } else {
        AccountMeta::new_readonly(pubkey, account.signer)
    })
}

fn generic_observation_values(
    svm: &LiteSVM,
    state: &GenericComponent,
    adapter: &Adapter,
    agent_idx: usize,
) -> Result<BTreeMap<String, ObservationValue>, PrimitiveError> {
    let mut observed = BTreeMap::new();
    for (account_name, pubkeys) in &state.agent_accounts {
        let pubkey = pubkeys.get(agent_idx).ok_or_else(|| {
            PrimitiveError::Infra(format!(
                "generic component agent account `{account_name}` missing idx {agent_idx}"
            ))
        })?;
        let account = svm.get_account(pubkey).ok_or_else(|| {
            PrimitiveError::Infra(format!(
                "generic component account `{account_name}` ({pubkey}) not found"
            ))
        })?;
        let values = observe_account_state(&state.idl, adapter, account_name, &account.data)
            .map_err(|e| PrimitiveError::Infra(e.to_string()))?;
        observed.extend(values);
    }
    for (account_name, pubkey) in &state.shared_accounts {
        let is_bound_oracle = adapter
            .oracles
            .iter()
            .any(|o| o.account.as_deref() == Some(account_name.as_str()));
        if is_bound_oracle {
            continue;
        }
        let account = svm.get_account(pubkey).ok_or_else(|| {
            PrimitiveError::Infra(format!(
                "generic component account `{account_name}` ({pubkey}) not found"
            ))
        })?;
        let values = observe_account_state(&state.idl, adapter, account_name, &account.data)
            .map_err(|e| PrimitiveError::Infra(e.to_string()))?;
        observed.extend(values);
    }
    Ok(observed)
}

fn generic_snapshot_metrics(
    svm: &LiteSVM,
    state: &GenericComponent,
    adapter: &Adapter,
) -> Result<BTreeMap<String, Value>, PrimitiveError> {
    let mut per_agent: Vec<BTreeMap<String, ObservationValue>> =
        Vec::with_capacity(state.agents.len());
    for idx in 0..state.agents.len() {
        per_agent.push(generic_observation_values(svm, state, adapter, idx)?);
    }
    let mut metrics = BTreeMap::new();
    for key in adapter.observations.keys() {
        let values: Vec<&ObservationValue> =
            per_agent.iter().filter_map(|map| map.get(key)).collect();
        if values.is_empty() {
            continue;
        }
        metrics.insert(key.clone(), aggregate_observation_column(&values));
    }
    Ok(metrics)
}

fn aggregate_observation_column(values: &[&ObservationValue]) -> Value {
    match values.first() {
        None => Value::Null,
        Some(ObservationValue::Int(_)) | Some(ObservationValue::UInt(_)) => {
            let nums: Vec<f64> = values
                .iter()
                .map(|v| match v {
                    ObservationValue::Int(n) => *n as f64,
                    ObservationValue::UInt(n) => *n as f64,
                    _ => 0.0,
                })
                .collect();
            let mean = nums.iter().sum::<f64>() / (nums.len() as f64);
            serde_json::Number::from_f64(mean)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }
        Some(ObservationValue::Bool(_)) => {
            let trues = values
                .iter()
                .filter(|v| matches!(v, ObservationValue::Bool(true)))
                .count() as u64;
            Value::from(trues)
        }
        Some(ObservationValue::Pubkey(_)) => {
            let distinct: BTreeSet<&String> = values
                .iter()
                .filter_map(|v| match v {
                    ObservationValue::Pubkey(p) => Some(p),
                    _ => None,
                })
                .collect();
            Value::from(distinct.len() as u64)
        }
        Some(ObservationValue::Map(_)) => {
            let sizes: Vec<f64> = values
                .iter()
                .map(|v| match v {
                    ObservationValue::Map(m) => m.len() as f64,
                    _ => 0.0,
                })
                .collect();
            let mean = sizes.iter().sum::<f64>() / (sizes.len() as f64);
            serde_json::Number::from_f64(mean)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }
    }
}

// ---------------------------------------------------------------------------
// Lending component plumbing
// ---------------------------------------------------------------------------

fn bootstrap_lending_component(
    svm: &mut LiteSVM,
    _adapter: &Adapter,
    agent_count: usize,
    starting_price: f64,
    starting_exponent: i8,
) -> Result<LendingComponent> {
    let program_so = crate::harness::setup::default_program_so_path();
    if !program_so.exists() {
        bail!(
            "lending component program .so missing at {} (run \
             `cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml`)",
            program_so.display()
        );
    }
    let program_bytes = load_program_bytes(&program_so)?;
    let program_id = Pubkey::new_unique();
    svm.add_program(program_id, &program_bytes)
        .map_err(|e| anyhow!("failed to load lending program into shared LiteSVM: {e}"))?;
    let client = LendingProgramClient::new(program_id);

    let admin = Keypair::new();
    lending_airdrop(svm, &admin.pubkey(), 10_000_000_000)?;
    let agents: Vec<Keypair> = (0..agent_count).map(|_| Keypair::new()).collect();
    for agent in &agents {
        lending_airdrop(svm, &agent.pubkey(), 10_000_000_000)?;
    }

    let oracle_kp = Keypair::new();
    let pool_kp = Keypair::new();
    let rent_oracle = svm.minimum_balance_for_rent_exemption(ORACLE_STATE_LEN);
    let rent_pool = svm.minimum_balance_for_rent_exemption(POOL_STATE_LEN);

    let starting_price_u64 = OracleUpdate {
        price: starting_price,
        exponent: starting_exponent,
    }
    .as_u64();

    let pool_config = LendingPoolConfig {
        ltv_bps: 7_000,
        liquidation_threshold_bps: 8_000,
        liquidation_bonus_bps: 500,
        interest_bps: 250,
        deposit_limit: u64::MAX / 4,
        borrow_limit: u64::MAX / 4,
    };

    let create_and_init = vec![
        crate::harness::setup::create_program_account(
            &admin.pubkey(),
            &oracle_kp.pubkey(),
            &program_id,
            rent_oracle,
            ORACLE_STATE_LEN,
        ),
        crate::harness::setup::create_program_account(
            &admin.pubkey(),
            &pool_kp.pubkey(),
            &program_id,
            rent_pool,
            POOL_STATE_LEN,
        ),
        client.initialize_oracle(
            admin.pubkey(),
            oracle_kp.pubkey(),
            starting_price_u64,
            starting_exponent,
        ),
        client.initialize_pool(admin.pubkey(), pool_kp.pubkey(), oracle_kp.pubkey(), pool_config),
    ];
    lending_send_tx(svm, &admin, create_and_init, &[&admin, &oracle_kp, &pool_kp])
        .context("lending component oracle + pool init")?;

    let rent_position = svm.minimum_balance_for_rent_exemption(POSITION_STATE_LEN);
    let mut positions = Vec::with_capacity(agent_count);
    for _ in 0..agent_count {
        let pos_kp = Keypair::new();
        let ix = crate::harness::setup::create_program_account(
            &admin.pubkey(),
            &pos_kp.pubkey(),
            &program_id,
            rent_position,
            POSITION_STATE_LEN,
        );
        lending_send_tx(svm, &admin, vec![ix], &[&admin, &pos_kp])
            .context("lending component create position")?;
        positions.push(pos_kp.pubkey());
    }

    let last_oracle_price = if starting_exponent < 0 {
        starting_price
    } else {
        starting_price
    };

    Ok(LendingComponent {
        program_id,
        client,
        admin,
        agents,
        pool: pool_kp.pubkey(),
        oracle: oracle_kp.pubkey(),
        positions,
        last_oracle_price,
        oracle_kind: OracleKind::AdminMock,
    })
}

fn push_lending_oracle(
    svm: &mut LiteSVM,
    state: &mut LendingComponent,
    update: &OracleUpdate,
) -> Result<(), PrimitiveError> {
    let ix = state.client.set_oracle_price(
        state.admin.pubkey(),
        state.oracle,
        update.as_u64(),
        update.exponent,
    );
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&state.admin.pubkey()),
        &[&state.admin],
        blockhash,
    );
    match svm.send_transaction(tx) {
        Ok(_) => {}
        Err(err) => {
            return match err.err {
                TransactionError::InstructionError(_, _) => {
                    Err(PrimitiveError::ProgramRejected(format!("{:?}", err.err)))
                }
                other => Err(PrimitiveError::Infra(format!("{other:?}"))),
            };
        }
    }
    // Verify the layout round-trips against the oracle account bytes
    // just written — the same check the single-component lending path
    // performs, keeping the multi-component path honest.
    let layout = oracle_layout_for(state.oracle_kind);
    let account = svm
        .get_account(&state.oracle)
        .ok_or_else(|| PrimitiveError::Infra("lending component oracle missing".into()))?;
    let _ = layout.decode(&account.data).map_err(|e| {
        PrimitiveError::Infra(format!(
            "lending component oracle layout decode failed: {e}"
        ))
    })?;
    state.last_oracle_price = update.price;
    Ok(())
}

fn execute_lending_replay(
    svm: &mut LiteSVM,
    state: &mut LendingComponent,
    agent_idx: usize,
    action: &str,
    args: &BTreeMap<String, ArgLiteral>,
    target_idx: Option<usize>,
) -> Result<(), PrimitiveError> {
    let amount = match args.get("amount") {
        Some(ArgLiteral::Int(v)) if *v >= 0 => *v as u64,
        Some(ArgLiteral::Int(v)) => {
            return Err(PrimitiveError::ProgramRejected(format!(
                "lending replay action `{action}` expected non-negative amount, got {v}"
            )));
        }
        Some(other) => {
            return Err(PrimitiveError::ProgramRejected(format!(
                "lending replay action `{action}` expected integer amount, got `{other:?}`"
            )));
        }
        None => 0,
    };
    let agent = state.agents[agent_idx].insecure_clone();
    let ix = match action {
        "deposit" => state
            .client
            .deposit(agent.pubkey(), state.pool, state.positions[agent_idx], amount),
        "withdraw" => state.client.withdraw(
            agent.pubkey(),
            state.pool,
            state.positions[agent_idx],
            Some(state.oracle),
            amount,
        ),
        "borrow" => state.client.borrow(
            agent.pubkey(),
            state.pool,
            state.positions[agent_idx],
            state.oracle,
            amount,
        ),
        "repay" => state
            .client
            .repay(agent.pubkey(), state.pool, state.positions[agent_idx], amount),
        "liquidate" => {
            let target = target_idx.ok_or_else(|| {
                PrimitiveError::ProgramRejected(
                    "lending replay action `liquidate` requires target_idx".into(),
                )
            })?;
            state.client.liquidate(
                agent.pubkey(),
                state.pool,
                state.positions[target],
                state.positions[agent_idx],
                state.oracle,
                amount,
            )
        }
        other => {
            return Err(PrimitiveError::ProgramRejected(format!(
                "unknown lending replay action `{other}`"
            )));
        }
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&agent.pubkey()),
        &[&agent],
        blockhash,
    );
    match svm.send_transaction(tx) {
        Ok(_) => Ok(()),
        Err(err) => match err.err {
            TransactionError::InstructionError(_, _) => {
                Err(PrimitiveError::ProgramRejected(format!("{:?}", err.err)))
            }
            other => Err(PrimitiveError::Infra(format!("{other:?}"))),
        },
    }
}

fn lending_observation_values(
    _svm: &LiteSVM,
    _state: &LendingComponent,
    _agent_idx: usize,
) -> Result<BTreeMap<String, ObservationValue>, PrimitiveError> {
    // Lending observations are exposed via snapshot_metrics (pool-level
    // aggregates). Per-agent position observations are not required for
    // Sprint 11 bridge / invariant surface; the lending proof references
    // `lending.pool.bad_debt` / `lending.summary.total_bad_debt` which
    // the snapshot/summary paths already carry.
    Ok(BTreeMap::new())
}

fn lending_snapshot_metrics(
    svm: &LiteSVM,
    state: &LendingComponent,
) -> Result<BTreeMap<String, Value>, PrimitiveError> {
    use borsh::BorshDeserialize;
    let account = svm
        .get_account(&state.pool)
        .ok_or_else(|| PrimitiveError::Infra("lending pool account missing".into()))?;
    let pool_state = crate::harness::lending::LendingPoolState::try_from_slice(&account.data)
        .map_err(|e| PrimitiveError::Infra(format!("pool decode: {e}")))?;
    let mut metrics = BTreeMap::new();
    metrics.insert("tvl".into(), json_f64(pool_state.total_deposits as f64));
    metrics.insert(
        "utilization".into(),
        json_f64(if pool_state.total_deposits == 0 {
            0.0
        } else {
            (pool_state.total_borrows as f64) / (pool_state.total_deposits as f64)
        }),
    );
    metrics.insert("oracle_price".into(), json_f64(state.last_oracle_price));
    metrics.insert(
        "cumulative_bad_debt".into(),
        json_f64(pool_state.bad_debt as f64),
    );
    // Friendly qualified aliases so proofs can read
    // `lending.pool.bad_debt` / `lending.pool.total_deposits` directly.
    metrics.insert("pool.bad_debt".into(), json_f64(pool_state.bad_debt as f64));
    metrics.insert(
        "pool.total_deposits".into(),
        json_f64(pool_state.total_deposits as f64),
    );
    metrics.insert(
        "pool.total_borrows".into(),
        json_f64(pool_state.total_borrows as f64),
    );
    Ok(metrics)
}

/// Per-component summary rollup matching the shipped single-component
/// contract. Lending emits `final_tvl`/`final_utilization`/`total_bad_debt`
/// /`largest_single_tick_drawdown` (the same keys
/// `LiteSvmHarness::summarize_metrics` produces) so multi-component
/// proof summaries carry the same semantics downstream consumers
/// already rely on.
fn lending_summarize_metrics(
    svm: &LiteSVM,
    state: &LendingComponent,
    timeseries: &[TickSnapshot],
) -> Result<BTreeMap<String, Value>, PrimitiveError> {
    use borsh::BorshDeserialize;
    let account = svm
        .get_account(&state.pool)
        .ok_or_else(|| PrimitiveError::Infra("lending pool account missing".into()))?;
    let pool_state = crate::harness::lending::LendingPoolState::try_from_slice(&account.data)
        .map_err(|e| PrimitiveError::Infra(format!("pool decode: {e}")))?;
    let mut largest_drawdown: f64 = 0.0;
    for pair in timeseries.windows(2) {
        let prev = pair[0]
            .get("oracle_price")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let next = pair[1]
            .get("oracle_price")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        if prev > 0.0 {
            let drop = ((prev - next) / prev).max(0.0);
            if drop > largest_drawdown {
                largest_drawdown = drop;
            }
        }
    }
    let utilization = if pool_state.total_deposits == 0 {
        0.0
    } else {
        (pool_state.total_borrows as f64) / (pool_state.total_deposits as f64)
    };
    let mut summary = BTreeMap::new();
    summary.insert("final_tvl".into(), json_f64(pool_state.total_deposits as f64));
    summary.insert("final_utilization".into(), json_f64(utilization));
    summary.insert("total_bad_debt".into(), json_f64(pool_state.bad_debt as f64));
    summary.insert(
        "largest_single_tick_drawdown".into(),
        json_f64(largest_drawdown),
    );
    Ok(summary)
}

/// Per-component summary rollup matching the shipped generic contract.
/// For each adapter-declared observation, emits
/// `<key>_avg`/`_max`/`_min` for numeric columns,
/// `_true_count`/`_false_count` for bool columns,
/// `_unique_count` for pubkey columns, and
/// `_entry_count_avg`/`_max` for map columns — mirroring
/// `GenericHarness::summarize_metrics` byte-for-byte.
fn generic_summarize_metrics(
    adapter: &Adapter,
    agent_count: usize,
    timeseries: &[TickSnapshot],
) -> BTreeMap<String, Value> {
    let mut summary = BTreeMap::new();
    for (key, definition) in &adapter.observations {
        let column: Vec<&Value> = timeseries
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
                summary.insert(format!("{key}_avg"), json_f64(avg));
                summary.insert(format!("{key}_max"), json_f64(max));
                summary.insert(format!("{key}_min"), json_f64(min));
            }
            crate::adapter::ObservationType::Bool => {
                let true_count: u64 = column.iter().filter_map(|v| v.as_u64()).sum();
                let total_cells = (agent_count as u64).saturating_mul(column.len() as u64);
                let false_count = total_cells.saturating_sub(true_count);
                summary.insert(format!("{key}_true_count"), Value::from(true_count));
                summary.insert(format!("{key}_false_count"), Value::from(false_count));
            }
            crate::adapter::ObservationType::Pubkey => {
                let max_unique: u64 = column
                    .iter()
                    .filter_map(|v| v.as_u64())
                    .max()
                    .unwrap_or(0);
                summary.insert(format!("{key}_unique_count"), Value::from(max_unique));
            }
            crate::adapter::ObservationType::Map => {
                let numeric: Vec<f64> = column.iter().filter_map(|v| v.as_f64()).collect();
                if numeric.is_empty() {
                    continue;
                }
                let avg = numeric.iter().sum::<f64>() / (numeric.len() as f64);
                let max = numeric.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                summary.insert(format!("{key}_entry_count_avg"), json_f64(avg));
                summary.insert(format!("{key}_entry_count_max"), json_f64(max));
            }
        }
    }
    summary
}

/// Slice a qualified multi-component timeseries back into a
/// single-component view by stripping the `<component>.` prefix from
/// every matching key. The resulting timeseries is the shape
/// per-component `summarize_metrics` consumers expect, so existing
/// lending / generic summary contracts keep their semantics.
fn per_component_timeseries(
    qualified: &[TickSnapshot],
    component_name: &str,
) -> Vec<TickSnapshot> {
    let prefix = format!("{component_name}.");
    qualified
        .iter()
        .map(|snapshot| {
            let mut deprefixed: TickSnapshot = BTreeMap::new();
            // Carry `tick` through so cross-tick rollups (drawdown,
            // timeseries window math) still see the tick column.
            if let Some(v) = snapshot.get("tick") {
                deprefixed.insert("tick".into(), v.clone());
            }
            for (k, v) in snapshot {
                if let Some(stripped) = k.strip_prefix(&prefix) {
                    deprefixed.insert(stripped.to_string(), v.clone());
                }
            }
            deprefixed
        })
        .collect()
}

fn json_f64(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Coordinator: run a multi-component replay end-to-end.
// ---------------------------------------------------------------------------

/// Execute a multi-component replay against the bootstrapped shared
/// `LiteSVM`. Per-tick ordering:
///
/// 1. For each component in declaration order:
///    - advance tick (only once across all components)
///    - push the component's oracle-trajectory update for this tick
///      (if any)
///    - dispatch the component's declared replay instructions
///    - evaluate any bridges sourced from this component, writing
///      derived updates into downstream targets before they tick
/// 2. Build a qualified snapshot (`<component>.<field>`) and evaluate
///    every adapter's invariants against the prefixed keys.
///
/// Returns a single `SimulationResult` tagged as
/// `scenario = "replay:multi:<name>"` where `<name>` is the first
/// component's replay metadata name. Events carry a `component` key in
/// `params` so downstream consumers can split the stream per component.
pub fn run_multi_replay(
    harness: &mut MultiComponentHarness,
    output_path: String,
) -> Result<SimulationResult, SimulationAbort> {
    let total_ticks = harness
        .components
        .iter()
        .map(|c| c.total_ticks)
        .max()
        .unwrap_or(0);

    // Per-component engine-side agent bookkeeping. Mirrors the
    // single-component replay path: each actor gets a synthetic
    // replay policy, starting_balance = 0.0, and
    // `total_actions` is incremented on every successful replay
    // dispatch. `final_state(final_price)` at the end derives
    // `AgentFinalState` honestly — NOT a fabricated "Active/zero"
    // row per actor. This keeps the SimulationResult wire contract
    // (CLI schema lifecycle counters, agent status enum) consistent
    // with the legacy replay paths.
    let mut component_agents: Vec<Vec<Agent>> = harness
        .components
        .iter()
        .map(|component| {
            component
                .actor_ids
                .iter()
                .map(|actor| {
                    Agent::new(actor.clone(), synthetic_replay_policy(actor), 0.0)
                        .with_starting_price(component.starting_price)
                })
                .collect::<Vec<_>>()
        })
        .collect();

    // Apply each component's initial-state instructions BEFORE tick 0.
    // We do this per component in declaration order.
    for component_idx in 0..harness.components.len() {
        let initial_instructions: Vec<_> = harness.components[component_idx]
            .bundle
            .initial_state
            .instructions
            .clone();
        let actor_index = build_actor_index(&harness.components[component_idx].actor_ids);
        if let Some(update) = harness.components[component_idx]
            .bundle
            .oracle_update_for_tick(0)
            .cloned()
        {
            harness.push_oracle_price(component_idx, &update).map_err(|e| match e {
                PrimitiveError::Infra(msg) => SimulationAbort::Infra(msg),
                PrimitiveError::ProgramRejected(msg) => SimulationAbort::Infra(format!(
                    "initial oracle push rejected: {msg}"
                )),
            })?;
        }
        for instruction in &initial_instructions {
            let agent_idx = actor_index.get(&instruction.agent).copied().ok_or_else(|| {
                SimulationAbort::BadInput(format!(
                    "component `{}`: initial-state instruction `{}` references unknown agent `{}`",
                    harness.components[component_idx].name, instruction.name, instruction.agent
                ))
            })?;
            let (replay_args, target_idx) = split_target_for_replay(
                &harness.components[component_idx].adapter,
                instruction,
                &actor_index,
            )?;
            let outcome = harness.execute_replay_action(
                component_idx,
                agent_idx,
                &instruction.name,
                &replay_args,
                target_idx,
            );
            match outcome {
                Ok(()) => {
                    if let Some(agent) = component_agents[component_idx].get_mut(agent_idx) {
                        agent.total_actions += 1;
                    }
                }
                Err(PrimitiveError::Infra(msg)) => return Err(SimulationAbort::Infra(msg)),
                Err(PrimitiveError::ProgramRejected(msg)) => {
                    return Err(SimulationAbort::BadInput(format!(
                        "initial-state instruction rejected: {msg}"
                    )));
                }
            }
        }
    }

    let mut events: Vec<SimEvent> = Vec::new();
    let mut timeseries: Vec<TickSnapshot> = Vec::new();
    let mut invariant_violations: Vec<InvariantViolation> = Vec::new();

    // Build the combined invariant list up front: each component's
    // invariants are keyed into the qualified namespace. E.g. a
    // lending invariant `no_bad_debt` on field `bad_debt` is rewritten
    // to target `lending.pool.bad_debt` so the tick loop's declared
    // invariant vocabulary is unambiguous.
    let combined_invariants = build_qualified_invariants(&harness.components);

    // tick 0 snapshot (post bootstrap + initial state).
    let snapshot = build_qualified_snapshot(harness, 0, &component_agents)
        .map_err(SimulationAbort::Infra)?;
    evaluate_invariants(
        &combined_invariants,
        0,
        &snapshot,
        &mut invariant_violations,
        &mut events,
    );
    timeseries.push(snapshot);

    for tick in 1..=total_ticks {
        harness.advance_tick_all();

        // Per-component ordering: push oracle trajectory update,
        // dispatch instructions, then evaluate bridges sourced from
        // this component before the next component runs.
        for component_idx in 0..harness.components.len() {
            let instructions: Vec<_> = harness.components[component_idx]
                .bundle
                .instructions_for_tick(tick)
                .to_vec();
            let oracle_tick: Option<OracleUpdate> = harness.components[component_idx]
                .bundle
                .oracle_update_for_tick(tick)
                .cloned();
            let actor_index = build_actor_index(&harness.components[component_idx].actor_ids);
            let component_name = harness.components[component_idx].name.clone();

            if let Some(update) = oracle_tick {
                harness
                    .push_oracle_price(component_idx, &update)
                    .map_err(|e| match e {
                        PrimitiveError::Infra(msg) => SimulationAbort::Infra(msg),
                        PrimitiveError::ProgramRejected(msg) => SimulationAbort::Infra(format!(
                            "component `{component_name}`: tick-{tick} oracle push rejected: {msg}"
                        )),
                    })?;
            }
            for instruction in &instructions {
                let agent_idx = actor_index.get(&instruction.agent).copied().ok_or_else(|| {
                    SimulationAbort::BadInput(format!(
                        "component `{component_name}`: tick-{tick} instruction `{}` references unknown agent `{}`",
                        instruction.name, instruction.agent
                    ))
                })?;
                let (replay_args, target_idx) = split_target_for_replay(
                    &harness.components[component_idx].adapter,
                    instruction,
                    &actor_index,
                )?;
                let (outcome, detail) = match harness.execute_replay_action(
                    component_idx,
                    agent_idx,
                    &instruction.name,
                    &replay_args,
                    target_idx,
                ) {
                    Ok(()) => (SimOutcome::Success, None),
                    Err(PrimitiveError::ProgramRejected(msg)) => (SimOutcome::Failed, Some(msg)),
                    Err(PrimitiveError::Infra(msg)) => return Err(SimulationAbort::Infra(msg)),
                };
                if matches!(outcome, SimOutcome::Success) {
                    if let Some(agent) = component_agents[component_idx].get_mut(agent_idx) {
                        agent.total_actions += 1;
                    }
                }

                let mut params = replay_args_to_json(&instruction.args);
                params.insert("component".into(), Value::from(component_name.clone()));
                // Namespace persona_id / persona_label by component so
                // downstream report surfaces that group by persona
                // (dashboard tables, narrative rollups) never silently
                // merge colliding actor names across components
                // (e.g. two components both containing `admin-actor`).
                events.push(SimEvent {
                    tick,
                    agent_id: format!("{component_name}:{}", instruction.agent),
                    persona_id: format!("{component_name}:{}", instruction.agent),
                    persona_label: format!("{component_name}:{}", instruction.agent),
                    action: format!("{component_name}:{}", instruction.name),
                    params,
                    outcome,
                    outcome_detail: detail,
                    triggered_by: None,
                });
            }

            // Evaluate bridges sourced from this component, so the
            // downstream target(s) see the derived oracle update before
            // their own tick runs.
            let firings = harness.evaluate_bridges_for_source(&component_name)?;
            for firing in firings {
                let mut params = BTreeMap::new();
                params.insert("source_component".into(), Value::from(firing.source_component));
                params.insert("source_field".into(), Value::from(firing.source_field));
                params.insert("target_component".into(), Value::from(firing.target_component));
                params.insert("target_oracle".into(), Value::from(firing.target_oracle));
                params.insert(
                    "observation".into(),
                    serde_json::Number::from_f64(firing.observation)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                );
                params.insert(
                    "derived_price".into(),
                    serde_json::Number::from_f64(firing.update.price)
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                );
                params.insert(
                    "derived_exponent".into(),
                    Value::from(firing.update.exponent as i64),
                );
                events.push(SimEvent {
                    tick,
                    agent_id: "__bridge__".into(),
                    persona_id: "bridge".into(),
                    persona_label: "bridge".into(),
                    action: format!("bridge:{}", firing.name),
                    params,
                    outcome: SimOutcome::Success,
                    outcome_detail: None,
                    triggered_by: None,
                });
            }
        }

        let snapshot =
            build_qualified_snapshot(harness, tick, &component_agents)
                .map_err(SimulationAbort::Infra)?;
        evaluate_invariants(
            &combined_invariants,
            tick,
            &snapshot,
            &mut invariant_violations,
            &mut events,
        );
        timeseries.push(snapshot);
    }

    // Build the qualified summary: each component contributes its
    // protocol-specific SUMMARY rollup (not snapshot metrics) under
    // `<component>.summary.<key>`. Lending emits
    // `final_tvl`/`final_utilization`/`total_bad_debt`/
    // `largest_single_tick_drawdown` — the same keys the shipped
    // single-component lending path produces. Generic emits adapter-
    // declared observation aggregates (`<key>_avg`/`_max`/`_min`
    // etc.). Using snapshot metrics here would hand downstream
    // consumers the WRONG semantics — e.g. `total_bad_debt`
    // disappears, which is load-bearing for any lending proof.
    let mut summary: BTreeMap<String, Value> = BTreeMap::new();
    for component in &harness.components {
        let component_ts = per_component_timeseries(&timeseries, &component.name);
        let component_summary = match &component.runtime {
            ComponentRuntime::Generic(_) => generic_summarize_metrics(
                &component.adapter,
                component.actor_ids.len(),
                &component_ts,
            ),
            ComponentRuntime::Lending(state) => {
                lending_summarize_metrics(&harness.svm, state, &component_ts)
                    .map_err(|e| SimulationAbort::Infra(format!("{e:?}")))?
            }
        };
        for (k, v) in component_summary {
            summary.insert(format!("{}.summary.{}", component.name, k), v);
        }
    }
    if !combined_invariants.is_empty() {
        summary.insert(
            "invariants_fired".into(),
            build_invariants_summary(&combined_invariants, &invariant_violations),
        );
    }

    let scenario_name = harness
        .components
        .first()
        .map(|c| format!("replay:multi:{}", c.bundle.metadata.name))
        .unwrap_or_else(|| "replay:multi".into());

    // Final-price per component: generic components use the bundle's
    // starting_price (replay agents never carry real positions, so
    // equity is zero regardless). Lending components use the tracked
    // `last_oracle_price`. Neither affects the emitted agent status
    // because replay agents never open positions — they are always
    // `Active` with zero PnL, matching the single-component replay
    // path's contract. The `agent_id` namespace remains
    // `<component>:<actor>` so downstream consumers can split the
    // finals by component.
    let agent_finals: Vec<_> = harness
        .components
        .iter()
        .enumerate()
        .flat_map(|(component_idx, component)| {
            let final_price = match &component.runtime {
                ComponentRuntime::Generic(_) => component.starting_price,
                ComponentRuntime::Lending(state) => state.last_oracle_price,
            };
            let component_name = component.name.clone();
            component_agents[component_idx]
                .iter()
                .map(move |agent| {
                    // Namespace every identity field by component so
                    // the agent-finals surface cannot silently merge
                    // colliding actor names across components.
                    let mut final_state = agent.final_state(final_price);
                    final_state.agent_id =
                        format!("{}:{}", component_name, final_state.agent_id);
                    final_state.persona_id =
                        format!("{}:{}", component_name, final_state.persona_id);
                    final_state.persona_label =
                        format!("{}:{}", component_name, final_state.persona_label);
                    final_state
                })
                .collect::<Vec<_>>()
                .into_iter()
        })
        .collect();

    let agents_active = agent_finals
        .iter()
        .filter(|a| matches!(a.status, AgentStatus::Active))
        .count() as u32;
    let agents_liquidated = agent_finals
        .iter()
        .filter(|a| matches!(a.status, AgentStatus::Liquidated))
        .count() as u32;
    let agents_depleted = agent_finals
        .iter()
        .filter(|a| matches!(a.status, AgentStatus::Depleted))
        .count() as u32;
    summary.insert("agents_active".into(), Value::from(agents_active));
    summary.insert("agents_liquidated".into(), Value::from(agents_liquidated));
    summary.insert("agents_depleted".into(), Value::from(agents_depleted));
    let total_actor_count: u32 = agent_finals.len() as u32;

    Ok(SimulationResult {
        run_config: RunConfig {
            agents: total_actor_count,
            ticks: total_ticks,
            scenario: scenario_name,
            seed: 0,
            personas: Vec::new(),
            validator_url: "http://127.0.0.1:8899".into(),
            output_path,
        },
        seed: 0,
        total_ticks,
        timeseries,
        events,
        agents: agent_finals,
        summary,
        semantics: None,
        simulation_boundaries: vec![
            "Multi-component replay boots two declared components into one shared LiteSVM world."
                .into(),
            "Per-tick ordering: each component runs in declaration order; bridges sourced from a \
             component are applied to their downstream target before the next component ticks."
                .into(),
            "Bridges are scalar observation -> scalar oracle write with an explicit transform; \
             no arbitrary cross-program transaction graph."
                .into(),
            "Qualified snapshot keys `<component>.<field>` expose per-component state to \
             invariants without ambiguity."
                .into(),
        ],
    })
}

fn build_qualified_invariants(components: &[ComponentSlot]) -> Vec<Invariant> {
    let mut out = Vec::new();
    for component in components {
        for inv in &component.adapter.invariants {
            let qualified_field = qualify_field_name(&component.name, &inv.field);
            let qualified_name = inv
                .name
                .as_deref()
                .map(|n| format!("{}:{}", component.name, n));
            out.push(Invariant {
                name: qualified_name,
                field: qualified_field,
                op: inv.op,
                value: inv.value,
            });
        }
    }
    out
}

/// Map an adapter-declared invariant field to its qualified key in the
/// multi-component snapshot. Generic components emit their fields under
/// `[observations]` keys (e.g. `pool.exchange_rate_bps`); lending
/// components emit `bad_debt`/`tvl`/etc. aliased to
/// `pool.bad_debt`/`pool.total_deposits`/... . Invariants declared
/// against single-program keys therefore compose unchanged by prefixing
/// with `<component>.`.
fn qualify_field_name(component: &str, field: &str) -> String {
    // The lending adapter declares its invariants with short names like
    // `bad_debt`, which `lending_snapshot_metrics` maps to both
    // `cumulative_bad_debt` and the friendly alias `pool.bad_debt`.
    // Prefer the friendly alias to keep the qualified surface explicit.
    let remapped = match field {
        "bad_debt" => "pool.bad_debt".to_string(),
        other => other.to_string(),
    };
    format!("{component}.{remapped}")
}

fn build_qualified_snapshot(
    harness: &MultiComponentHarness,
    tick: u32,
    component_agents: &[Vec<Agent>],
) -> Result<TickSnapshot, String> {
    let mut snapshot: TickSnapshot = BTreeMap::new();
    snapshot.insert("tick".into(), Value::from(tick));
    // Engine-owned `active_agents` counter — required by the
    // shared `TickSnapshot` schema (see
    // `cli/src/compiler/schema.ts :: TickSnapshotSchema`). Counts
    // every component's still-active actor so multi-component
    // snapshots land on the same wire contract as the lending /
    // generic single-component paths.
    let active: u32 = component_agents
        .iter()
        .flat_map(|agents| agents.iter())
        .filter(|agent| agent.is_active())
        .count() as u32;
    snapshot.insert("active_agents".into(), Value::from(active));
    for component in harness.components.iter() {
        let metrics = match &component.runtime {
            ComponentRuntime::Generic(state) => {
                generic_snapshot_metrics(&harness.svm, state, &component.adapter)
                    .map_err(|e| format!("{e:?}"))?
            }
            ComponentRuntime::Lending(state) => {
                lending_snapshot_metrics(&harness.svm, state).map_err(|e| format!("{e:?}"))?
            }
        };
        for (k, v) in metrics {
            snapshot.insert(format!("{}.{}", component.name, k), v);
        }
    }
    Ok(snapshot)
}

/// Synthetic, zero-weight replay policy. Mirrors the helper
/// `crate::replay::run::synthetic_replay_policy` — replay agents never
/// execute persona-driven actions (every instruction is dispatched
/// from the trajectory bundle directly), but they still need a valid
/// Policy object to satisfy `Agent::new`.
fn synthetic_replay_policy(actor: &str) -> Policy {
    Policy {
        persona_id: actor.to_string(),
        persona_label: actor.to_string(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::new(),
        triggers: Vec::<Trigger>::new(),
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::from([("amount".into(), 0.0)]),
        },
        max_exposure: 1.0,
        persona_args: BTreeMap::new(),
    }
}

fn build_actor_index(actor_ids: &[String]) -> BTreeMap<String, usize> {
    actor_ids
        .iter()
        .cloned()
        .enumerate()
        .map(|(idx, actor)| (actor, idx))
        .collect()
}

fn split_target_for_replay(
    adapter: &Adapter,
    instruction: &crate::replay::trajectory::ReplayInstruction,
    actor_index: &BTreeMap<String, usize>,
) -> Result<(BTreeMap<String, ArgLiteral>, Option<usize>), SimulationAbort> {
    let target_is_reserved = adapter
        .actions
        .get(instruction.name.as_str())
        .map(|a| !a.takes.iter().any(|arg| arg == "target"))
        .unwrap_or(true);
    let target_idx = if target_is_reserved {
        match instruction.args.get("target") {
            Some(ArgLiteral::String(target)) => Some(
                actor_index
                    .get(target)
                    .copied()
                    .ok_or_else(|| {
                        SimulationAbort::BadInput(format!(
                            "replay instruction `{}` targets unknown agent `{target}`",
                            instruction.name
                        ))
                    })?,
            ),
            Some(other) => {
                return Err(SimulationAbort::BadInput(format!(
                    "replay instruction `{}` expected string target, got `{other:?}`",
                    instruction.name
                )));
            }
            None => None,
        }
    } else {
        None
    };
    let replay_args = if target_is_reserved {
        instruction
            .args
            .iter()
            .filter(|(k, _)| k.as_str() != "target")
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<BTreeMap<_, _>>()
    } else {
        instruction.args.clone()
    };
    Ok((replay_args, target_idx))
}

fn replay_args_to_json(args: &BTreeMap<String, ArgLiteral>) -> BTreeMap<String, Value> {
    args.iter()
        .map(|(k, v)| {
            let value = match v {
                ArgLiteral::Bool(b) => Value::Bool(*b),
                ArgLiteral::Int(n) => Value::from(*n),
                ArgLiteral::String(s) => Value::from(s.clone()),
            };
            (k.clone(), value)
        })
        .collect()
}

fn resolve_path(base: &Path, value: &str) -> PathBuf {
    let raw = PathBuf::from(value);
    if raw.is_absolute() {
        raw
    } else {
        base.join(raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_legacy_single_component_config_unchanged() {
        let raw = r#"{
            "adapter": "./adapter.toml",
            "trajectory_dir": ".",
            "output_path": "riptide-output/legacy"
        }"#;
        match parse_replay_config(raw).expect("parse legacy") {
            ReplayConfigShape::Legacy(cfg) => {
                assert_eq!(cfg.adapter, "./adapter.toml");
                assert_eq!(cfg.trajectory_dir, ".");
                assert_eq!(cfg.output_path, "riptide-output/legacy");
            }
            other => panic!("expected legacy, got {other:?}"),
        }
    }

    #[test]
    fn parse_multi_component_config_with_bridge() {
        let raw = r#"{
            "components": [
                { "name": "liquid_staking",
                  "adapter": "./lst/adapter.toml",
                  "trajectory_dir": "./lst" },
                { "name": "lending",
                  "adapter": "./lending/adapter.toml",
                  "trajectory_dir": "./lending" }
            ],
            "bridges": [
                { "name": "lst_to_lending",
                  "source_component": "liquid_staking",
                  "source_field": "pool.exchange_rate_bps",
                  "target_component": "lending",
                  "target_oracle": "collateral_price_feed",
                  "transform": { "kind": "bps-ratio",
                                 "base_price": 100.0, "denominator": 10000.0 } }
            ],
            "output_path": "riptide-output/contagion"
        }"#;
        match parse_replay_config(raw).expect("parse multi") {
            ReplayConfigShape::Multi(cfg) => {
                assert_eq!(cfg.components.len(), 2);
                assert_eq!(cfg.components[0].name, "liquid_staking");
                assert_eq!(cfg.bridges.len(), 1);
                assert_eq!(cfg.bridges[0].source_field, "pool.exchange_rate_bps");
                match &cfg.bridges[0].transform {
                    BridgeTransform::BpsRatio {
                        base_price,
                        denominator,
                        ..
                    } => {
                        assert_eq!(*base_price, 100.0);
                        assert_eq!(*denominator, 10000.0);
                    }
                }
            }
            other => panic!("expected multi, got {other:?}"),
        }
    }

    #[test]
    fn multi_config_rejects_single_entry() {
        let raw = r#"{
            "components": [
                { "name": "only", "adapter": "./a.toml", "trajectory_dir": "." }
            ],
            "output_path": "x"
        }"#;
        let err = parse_replay_config(raw).unwrap_err();
        assert!(
            err.to_string().contains("at least 2"),
            "got: {err}"
        );
    }

    #[test]
    fn multi_config_rejects_duplicate_component_names() {
        let raw = r#"{
            "components": [
                { "name": "dup", "adapter": "./a.toml", "trajectory_dir": "." },
                { "name": "dup", "adapter": "./b.toml", "trajectory_dir": "." }
            ],
            "output_path": "x"
        }"#;
        let err = parse_replay_config(raw).unwrap_err();
        assert!(
            err.to_string().contains("duplicate component"),
            "got: {err}"
        );
    }

    #[test]
    fn multi_config_rejects_bridge_with_unknown_source() {
        let raw = r#"{
            "components": [
                { "name": "a", "adapter": "./a.toml", "trajectory_dir": "." },
                { "name": "b", "adapter": "./b.toml", "trajectory_dir": "." }
            ],
            "bridges": [
                { "name": "bad", "source_component": "ghost",
                  "source_field": "f", "target_component": "b",
                  "target_oracle": "o",
                  "transform": { "kind": "bps-ratio",
                                 "base_price": 1.0, "denominator": 1.0 } }
            ],
            "output_path": "x"
        }"#;
        let err = parse_replay_config(raw).unwrap_err();
        assert!(err.to_string().contains("unknown source component"), "got: {err}");
    }

    #[test]
    fn multi_config_rejects_self_referential_bridge() {
        let raw = r#"{
            "components": [
                { "name": "a", "adapter": "./a.toml", "trajectory_dir": "." },
                { "name": "b", "adapter": "./b.toml", "trajectory_dir": "." }
            ],
            "bridges": [
                { "name": "loop", "source_component": "a",
                  "source_field": "f", "target_component": "a",
                  "target_oracle": "o",
                  "transform": { "kind": "bps-ratio",
                                 "base_price": 1.0, "denominator": 1.0 } }
            ],
            "output_path": "x"
        }"#;
        let err = parse_replay_config(raw).unwrap_err();
        assert!(err.to_string().contains("source and target components must differ"), "got: {err}");
    }

    #[test]
    fn multi_config_rejects_bridge_with_source_after_target_in_declaration_order() {
        // The ordering contract (R2.2) is upstream-first: the source
        // component must tick BEFORE the target so the bridge can
        // propagate within the same tick. If the config declares the
        // source AFTER the target, `run_multi_replay` would silently
        // degrade to "target sees the new oracle next tick", which is
        // wrong for a contagion proof. Reject at parse time.
        let raw = r#"{
            "components": [
                { "name": "lending", "adapter": "./lending.toml", "trajectory_dir": "./l" },
                { "name": "liquid_staking", "adapter": "./lst.toml", "trajectory_dir": "./s" }
            ],
            "bridges": [
                { "name": "reversed",
                  "source_component": "liquid_staking",
                  "source_field": "pool.exchange_rate_bps",
                  "target_component": "lending",
                  "target_oracle": "o",
                  "transform": { "kind": "bps-ratio",
                                 "base_price": 100.0, "denominator": 10000.0 } }
            ],
            "output_path": "x"
        }"#;
        let err = parse_replay_config(raw).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("upstream-first") || msg.contains("before"),
            "expected reversed-topology error, got: {msg}"
        );
    }

    #[test]
    fn multi_config_accepts_bridge_with_source_before_target_in_declaration_order() {
        let raw = r#"{
            "components": [
                { "name": "liquid_staking", "adapter": "./lst.toml", "trajectory_dir": "./s" },
                { "name": "lending", "adapter": "./lending.toml", "trajectory_dir": "./l" }
            ],
            "bridges": [
                { "name": "ok",
                  "source_component": "liquid_staking",
                  "source_field": "pool.exchange_rate_bps",
                  "target_component": "lending",
                  "target_oracle": "o",
                  "transform": { "kind": "bps-ratio",
                                 "base_price": 100.0, "denominator": 10000.0 } }
            ],
            "output_path": "x"
        }"#;
        let shape = parse_replay_config(raw).expect("source-before-target config must parse");
        match shape {
            ReplayConfigShape::Multi(cfg) => assert_eq!(cfg.bridges.len(), 1),
            _ => panic!("expected multi"),
        }
    }

    #[test]
    fn bps_ratio_transform_applies_linearly() {
        let t = BridgeTransform::BpsRatio {
            base_price: 100.0,
            denominator: 10_000.0,
            exponent: Some(-2),
        };
        let out = t.apply(9_500.0).expect("apply bps-ratio");
        assert!((out.price - 95.0).abs() < 1e-9);
        assert_eq!(out.exponent, -2);
    }

    #[test]
    fn bps_ratio_transform_rejects_zero_denominator() {
        let t = BridgeTransform::BpsRatio {
            base_price: 100.0,
            denominator: 0.0,
            exponent: None,
        };
        assert!(t.apply(1.0).is_err());
    }
}
