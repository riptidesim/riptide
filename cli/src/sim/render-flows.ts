import type {
  Adapter,
  AccountDefinition,
  ArgLiteral,
  InstructionMapping
} from "../schemas/adapter.js";
import type { GenericIdl, GenericInstruction, GenericInstructionAccount, GenericTypeRef } from "./idl.js";

type PersonaDefinition = Adapter["personas"][string];

/**
 * Render `flows.rs`. When the adapter declares `[personas]` + `[[instructions]]`
 * the generated file drives the real program with the persona brain: it builds
 * a `Vec<Agent>` from the declared personas, emits a `GeneratedExecutor`
 * implementing `ActionExecutor` (one `RuntimeAction::Custom` per mapped action,
 * resolving each IDL instruction account to an `AccountMeta`), and a
 * `guided_flow` that drives them through `step_personas`.
 *
 * `init` stays a HAND-AUTHORED seam: codegen cannot synthesize a protocol's
 * tick-0 genesis state, so it emits a documented skeleton with `// TODO(setup):`
 * markers for every `[accounts]` entry. Until the seam is authored `sim.actors`
 * is empty and `guided_flow` is a clean no-op.
 *
 * Falls back to the historical no-op stub when the adapter declares no personas
 * or no instructions.
 */
export function renderFlows(adapter: Adapter, idl: GenericIdl): string {
  const personaNames = Object.keys(adapter.personas);
  const instructionNames = Object.keys(adapter.instructions);
  if (personaNames.length === 0 || instructionNames.length === 0) {
    return renderFlowsStub();
  }

  // Resolve every mapped instruction against the IDL. Skip mappings whose IDL
  // instruction is missing (defensive — the loader normally guarantees these).
  const mapped: MappedInstruction[] = [];
  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    const idlInstruction = findIdlInstruction(idl, ixName);
    if (!idlInstruction) continue;
    mapped.push({ ixName, mapping, idl: idlInstruction });
  }
  if (mapped.length === 0) {
    return renderFlowsStub();
  }

  const idlProgramId = adapter.program_id ?? idl.address;

  // Collect the captured executor fields across every instruction.
  const sharedFields = new Map<string, string>(); // rust ident -> adapter account name
  const agentFields = new Map<string, string>(); // rust ident -> adapter account name
  let usesPersonaArgs = false;

  const execFns: string[] = [];
  const actionArms = new Map<string, string>(); // action string -> exec fn name
  const actionOrder: string[] = [];

  for (const entry of mapped) {
    const resolution = resolveAccounts(entry, adapter, sharedFields, agentFields);
    if (resolution.usesPersonaArgs) usesPersonaArgs = true;
    const argResult = resolveArgs(entry, idlProgramId);
    if (argResult.usesPersonaArgs) usesPersonaArgs = true;

    const fnName = `exec_${rustIdent(entry.ixName)}`;
    execFns.push(renderExecFn(fnName, entry, resolution.fields, argResult.fields));
    if (!actionArms.has(entry.mapping.action)) {
      actionArms.set(entry.mapping.action, fnName);
      actionOrder.push(entry.mapping.action);
    }
  }

  const personas = personaNames
    .sort()
    .map((name) => ({ name, def: adapter.personas[name] }));

  return assemble({
    personas,
    sharedFields,
    agentFields,
    usesPersonaArgs,
    execFns,
    actionArms,
    actionOrder
  });
}

export function renderFlowsStub(): string {
  return `use crate::Simulation;

pub fn init(_sim: &mut Simulation) -> riptide_sim::anyhow::Result<()> {
    Ok(())
}

pub fn guided_flow(_sim: &mut Simulation) -> riptide_sim::anyhow::Result<()> {
    Ok(())
}
`;
}

interface MappedInstruction {
  ixName: string;
  mapping: InstructionMapping;
  idl: GenericInstruction;
}

interface AccountField {
  field: string; // rust ident for the IDL account name
  expr: string; // rust expression producing the AccountMeta
  todo?: string;
}

interface ArgField {
  field: string; // rust ident for the IDL arg name
  expr: string; // rust expression producing the typed value
}

function resolveAccounts(
  entry: MappedInstruction,
  adapter: Adapter,
  sharedFields: Map<string, string>,
  agentFields: Map<string, string>
): { fields: AccountField[]; usesPersonaArgs: boolean } {
  const fields: AccountField[] = [];
  let signerSeen = false;
  for (const account of entry.idl.accounts) {
    const field = rustIdent(account.name);
    const writable = account.writable === true;
    const resolved = resolveOneAccount(
      account,
      adapter,
      writable,
      signerSeen,
      sharedFields,
      agentFields
    );
    if (resolved.consumedSigner) signerSeen = true;
    fields.push({ field, expr: resolved.expr, todo: resolved.todo });
  }
  return { fields, usesPersonaArgs: false };
}

function resolveOneAccount(
  account: GenericInstructionAccount,
  adapter: Adapter,
  writable: boolean,
  signerSeen: boolean,
  sharedFields: Map<string, string>,
  agentFields: Map<string, string>
): { expr: string; consumedSigner: boolean; todo?: string } {
  // (1) the first signer account -> the on-chain actor (the persona's signer).
  if (account.signer && !signerSeen) {
    return { expr: `meta(*actor, true, ${rustBool(writable)})`, consumedSigner: true };
  }

  const definition: AccountDefinition | undefined = adapter.accounts[account.name];
  const ident = rustIdent(account.name);

  if (definition) {
    // (2) adapter account with a fixed address / well-known alias.
    if (definition.address) {
      return {
        expr: `meta(${pubkeyExpr(definition.address)}, false, ${rustBool(writable)})`,
        consumedSigner: false
      };
    }
    // (3) per-agent account -> the actor's keyed entry.
    if (definition.kind === "agent") {
      agentFields.set(ident, account.name);
      return {
        expr: `meta(*self.${ident}.get(actor).ok_or_else(|| anyhow!("GeneratedExecutor: agent account \`${account.name}\` missing for actor {actor}"))?, false, ${rustBool(
          writable
        )})`,
        consumedSigner: false
      };
    }
    // (4) shared account -> captured from sim.accounts.
    sharedFields.set(ident, account.name);
    return { expr: `meta(self.${ident}, false, ${rustBool(writable)})`, consumedSigner: false };
  }

  // (5) account with a fixed IDL address (program ids / sysvars).
  if (account.address) {
    return {
      expr: `meta(${pubkeyExpr(account.address)}, false, ${rustBool(writable)})`,
      consumedSigner: false
    };
  }

  // (6) well-known program / sysvar alias by account name.
  const wellKnown = wellKnownPubkey(account.name);
  if (wellKnown) {
    return {
      expr: `meta(${pubkeyLiteral(wellKnown)}, false, ${rustBool(writable)})`,
      consumedSigner: false
    };
  }

  // (7) unresolved — emit a default with a TODO so the crate still compiles.
  return {
    expr: `meta(Pubkey::default(), false, ${rustBool(writable)})`,
    consumedSigner: false,
    todo: `TODO(account): \`${account.name}\` is not declared under [accounts], not a recognized signer, and not a well-known program/sysvar — resolve it by hand.`
  };
}

function resolveArgs(
  entry: MappedInstruction,
  idlProgramId: string | undefined
): { fields: ArgField[]; usesPersonaArgs: boolean } {
  const fields: ArgField[] = [];
  let usesPersonaArgs = false;
  const args: Record<string, ArgLiteral> = entry.mapping.args ?? {};
  for (const arg of entry.idl.args) {
    const ty = argRustType(arg.type);
    const field = rustIdent(arg.name);
    if (entry.mapping.amount === arg.name) {
      // Persona-sized runtime amount.
      fields.push({ field, expr: `amount as ${ty}` });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(args, arg.name)) {
      const value = args[arg.name];
      const resolved = argLiteralExpr(value, ty);
      if (resolved.usesPersonaArgs) usesPersonaArgs = true;
      fields.push({ field, expr: resolved.expr });
      continue;
    }
    // Unbound IDL arg — emit a typed default so the data struct still builds.
    fields.push({ field, expr: defaultArgExpr(ty) });
  }
  // idlProgramId is unused in arg resolution but kept for future pubkey-literal
  // contexts that need program-relative defaults.
  void idlProgramId;
  return { fields, usesPersonaArgs };
}

function argLiteralExpr(value: ArgLiteral, ty: string): { expr: string; usesPersonaArgs: boolean } {
  if (typeof value === "string") {
    if (value.startsWith("@persona.")) {
      const key = value.slice("@persona.".length);
      return { expr: personaArgExpr(key, ty), usesPersonaArgs: true };
    }
    // A bare string literal is a base58 pubkey.
    return { expr: pubkeyExpr(value), usesPersonaArgs: false };
  }
  if (typeof value === "boolean") {
    if (ty === "bool") return { expr: value ? "true" : "false", usesPersonaArgs: false };
    return { expr: `(${value ? "true" : "false"} as ${ty})`, usesPersonaArgs: false };
  }
  // number
  if (ty === "bool") return { expr: `(${value} != 0)`, usesPersonaArgs: false };
  return { expr: `(${value} as ${ty})`, usesPersonaArgs: false };
}

function personaArgExpr(key: string, ty: string): string {
  const k = rustStr(key);
  if (ty === "bool") {
    return `match self.persona_arg(actor, ${k}) { Some(ArgLiteral::Bool(b)) => *b, Some(ArgLiteral::Int(v)) => *v != 0, _ => false }`;
  }
  if (ty === "Pubkey") {
    return `match self.persona_arg(actor, ${k}) { Some(ArgLiteral::String(s)) => Pubkey::from_str(s).unwrap_or_default(), _ => Pubkey::default() }`;
  }
  if (isNumericRustType(ty)) {
    return `match self.persona_arg(actor, ${k}) { Some(ArgLiteral::Int(v)) => *v as ${ty}, Some(ArgLiteral::Bool(b)) => *b as ${ty}, _ => 0 as ${ty} }`;
  }
  // Non-primitive target: best-effort default.
  return `Default::default()`;
}

function defaultArgExpr(ty: string): string {
  if (ty === "bool") return "false";
  if (ty === "Pubkey") return "Pubkey::default()";
  if (ty === "String") return "String::new()";
  if (ty.startsWith("Vec<")) return "Vec::new()";
  if (ty.startsWith("Option<")) return "None";
  if (isNumericRustType(ty)) return `0 as ${ty}`;
  return "Default::default()";
}

function renderExecFn(
  fnName: string,
  entry: MappedInstruction,
  accountFields: AccountField[],
  argFields: ArgField[]
): string {
  const pascal = pascalCase(entry.idl.name);
  const builderFn = rustIdent(entry.idl.name);
  const accountsLines = accountFields
    .map((f) => {
      const todo = f.todo ? `            // ${f.todo}\n` : "";
      return `${todo}            ${f.field}: ${f.expr},`;
    })
    .join("\n");
  const argsLines = argFields.map((f) => `            ${f.field}: ${f.expr},`).join("\n");
  const label = rustStr(entry.mapping.action);
  return `    fn ${fnName}(
        &mut self,
        world: &mut World,
        actor: &Pubkey,
        amount: f64,
    ) -> Result<TxOutcome> {
        let _ = amount;
        let instruction = crate::types::${builderFn}(self.program_id)
            .args(crate::types::${pascal}InstructionData {
${argsLines || "                // (this instruction declares no args)"}
            })
            .accounts(crate::types::${pascal}InstructionAccounts {
${accountsLines}
            })
            .instruction();
        world
            .transaction()
            .instruction(instruction)
            .signer(*actor)
            .label(${label})
            .record_outcome()
            .send()
    }`;
}

interface AssembleInput {
  personas: { name: string; def: PersonaDefinition }[];
  sharedFields: Map<string, string>;
  agentFields: Map<string, string>;
  usesPersonaArgs: boolean;
  execFns: string[];
  actionArms: Map<string, string>;
  actionOrder: string[];
}

function assemble(input: AssembleInput): string {
  const structSharedFields = [...input.sharedFields.keys()]
    .map((ident) => `    ${ident}: Pubkey,`)
    .join("\n");
  const structAgentFields = [...input.agentFields.keys()]
    .map((ident) => `    ${ident}: BTreeMap<Pubkey, Pubkey>,`)
    .join("\n");

  const agentMapBuild = [...input.agentFields.keys()]
    .map(
      (ident) => `        let mut ${ident}: BTreeMap<Pubkey, Pubkey> = BTreeMap::new();
        for (idx, actor) in sim.actors.iter().enumerate() {
            ${ident}.insert(*actor, sim.accounts.${ident}.agent(idx));
        }`
    )
    .join("\n");

  const fromSimAssign = [
    "            program_id: sim.world.program_id(),",
    "            action_space: action_space(),",
    input.usesPersonaArgs ? "            persona_args," : null,
    ...[...input.sharedFields.entries()].map(
      ([ident, name]) => `            ${ident}: sim.accounts.${ident}.get(${rustStr(name)}),`
    ),
    ...[...input.agentFields.keys()].map((ident) => `            ${ident},`)
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const personaArgsBuild = input.usesPersonaArgs
    ? `        let mut persona_args: BTreeMap<Pubkey, BTreeMap<String, ArgLiteral>> = BTreeMap::new();
        for (idx, actor) in sim.actors.iter().enumerate() {
            if let Some(agent) = sim.agents.get(idx) {
                persona_args.insert(*actor, agent.policy.persona_args.clone());
            }
        }
`
    : "";

  const personaArgsField = input.usesPersonaArgs
    ? "    persona_args: BTreeMap<Pubkey, BTreeMap<String, ArgLiteral>>,\n"
    : "";
  const personaArgHelper = input.usesPersonaArgs
    ? `
    fn persona_arg(&self, actor: &Pubkey, key: &str) -> Option<&ArgLiteral> {
        self.persona_args.get(actor).and_then(|args| args.get(key))
    }
`
    : "";

  const actionSpace = input.actionOrder
    .map((action) => `        RuntimeAction::Custom(${rustStr(action)}.to_string()),`)
    .join("\n");

  const executeArms = [...input.actionArms.entries()]
    .map(([action, fn]) => `            ${rustStr(action)} => self.${fn}(world, actor, amount),`)
    .join("\n");

  const agentPushes = input.personas.map(renderAgentPush).join("\n");

  const accountTodos = renderAccountSetupTodos(input.sharedFields, input.agentFields);

  // `ArgLiteral` is only referenced when a persona declares `persona_args` (in
  // `build_agents`) or an instruction binds a `@persona.*` arg (in `execute`).
  const usesArgLiteral =
    input.usesPersonaArgs ||
    input.personas.some((p) => Object.keys(p.def.persona_args ?? {}).length > 0);
  const kernelTypesImport = usesArgLiteral
    ? "use riptide_sim::kernel::types::{ArgLiteral, Policy, PositionSizing, PositionSizingStrategy};"
    : "use riptide_sim::kernel::types::{Policy, PositionSizing, PositionSizingStrategy};";

  return `// @generated by riptide sim generate. Persona-driven flows.
//
// \`init\` is a HAND-AUTHORED seam (see the TODO(setup) markers): codegen cannot
// synthesize a protocol's tick-0 genesis state. Everything else here is
// regenerated, but this file is preserved by \`riptide sim refresh\` once it
// exists, so your hand-authored \`init\` survives.
#![allow(dead_code, clippy::too_many_lines)]

use std::collections::BTreeMap;
use std::str::FromStr;

use riptide_sim::anyhow::{anyhow, bail, Result};
use riptide_sim::kernel::persona::{Agent, AgentObservation, AgentRuntime, RuntimeAction};
${kernelTypesImport}
use riptide_sim::solana_sdk::instruction::AccountMeta;
use riptide_sim::solana_sdk::pubkey::Pubkey;
use riptide_sim::{step_personas, ActionExecutor, ObservationBuilder, TxOutcome, World};

use crate::Simulation;

/// Seed for the deterministic persona decision RNG.
const RUNTIME_SEED: u64 = 42;

fn meta(pubkey: Pubkey, is_signer: bool, is_writable: bool) -> AccountMeta {
    AccountMeta {
        pubkey,
        is_signer,
        is_writable,
    }
}

/// One [\`Agent\`] per declared persona, sized by its \`[personas.<name>].amount\`.
pub fn build_agents() -> Vec<Agent> {
    let mut agents: Vec<Agent> = Vec::new();
${agentPushes}
    agents
}

/// The deterministic persona decision runtime.
pub fn build_runtime() -> AgentRuntime {
    AgentRuntime::new(RUNTIME_SEED)
}

/// The action space personas choose among: one \`Custom\` per mapped
/// \`[[instructions]]\` action. The brain always also considers \`NoOp\`.
fn action_space() -> Vec<RuntimeAction> {
    vec![
${actionSpace}
    ]
}

fn observe(_world: &mut World, _agent: &Agent) -> AgentObservation {
    // Minimal observation: the declared personas drive no observation-compare
    // triggers. Author richer [semantics]-relevant observations here if a
    // persona trigger needs them.
    ObservationBuilder::new(1).build()
}

/// Generated action sink: turns a chosen [\`RuntimeAction\`] into a real
/// transaction against the program via the generated instruction builders.
struct GeneratedExecutor {
    program_id: Pubkey,
    action_space: Vec<RuntimeAction>,
${personaArgsField}${structSharedFields}
${structAgentFields}
}

impl GeneratedExecutor {
    fn from_sim(sim: &Simulation) -> Self {
${agentMapBuild}
${personaArgsBuild}        Self {
${fromSimAssign}
        }
    }
${personaArgHelper}
${input.execFns.join("\n\n")}
}

impl ActionExecutor for GeneratedExecutor {
    fn action_space(&self) -> &[RuntimeAction] {
        &self.action_space
    }

    fn execute(
        &mut self,
        world: &mut World,
        actor: &Pubkey,
        action: &RuntimeAction,
        amount: f64,
    ) -> Result<TxOutcome> {
        match action.as_str() {
${executeArms}
            other => bail!("GeneratedExecutor: unmapped action \`{other}\`"),
        }
    }
}

/// HAND-AUTHORED SEAM — the tick-0 on-chain state.
///
/// \`riptide sim generate\` cannot synthesize a protocol's genesis state, so this
/// function is the one place you author it by hand (mirror your
/// \`.riptide/harness\` setup). Until you do, \`sim.actors\` stays empty and
/// \`guided_flow\` is a clean no-op.
pub fn init(sim: &mut Simulation) -> Result<()> {
    sim.agents = build_agents();
    sim.runtime = build_runtime();

    // TODO(setup): create one on-chain actor (the signer) per persona agent and
    // its per-agent accounts, e.g.:
    //
    //     use riptide_sim::solana_sdk::signature::Keypair;
    //     for idx in 0..sim.agents.len() {
    //         let actor = sim.world.register_keypair(Keypair::new());
    //         sim.world.airdrop(&actor, 1_000_000_000)?;
    //         sim.actors.push(actor);
${renderAgentAccountTodos(input.agentFields)}    //     }
    //
${accountTodos}    let _ = sim;
    Ok(())
}

/// Drive the persona roster for one flow: observe -> decide -> execute.
pub fn guided_flow(sim: &mut Simulation) -> Result<()> {
    if sim.actors.is_empty() {
        // The init seam has not been authored yet — nothing to drive.
        return Ok(());
    }
    if sim.actors.len() != sim.agents.len() {
        bail!(
            "guided_flow: {} actors for {} agents; the init seam must create one actor per agent",
            sim.actors.len(),
            sim.agents.len()
        );
    }
    let mut executor = GeneratedExecutor::from_sim(sim);
    let actors = sim.actors.clone();
    step_personas(
        &mut sim.world,
        &mut sim.runtime,
        &mut sim.agents,
        &actors,
        observe,
        &mut executor,
    )?;
    Ok(())
}
`;
}

function renderAgentPush(persona: { name: string; def: PersonaDefinition }): string {
  const def = persona.def;
  const label = def.label ?? persona.name;
  const weights = Object.entries(def.action_weights);
  const weightsExpr =
    weights.length === 0
      ? "BTreeMap::new()"
      : `BTreeMap::from([${weights
          .map(([action, weight]) => `(${rustStr(action)}.to_string(), ${rustFloat(weight)})`)
          .join(", ")}])`;
  const personaArgs = Object.entries(def.persona_args ?? {});
  const personaArgsExpr =
    personaArgs.length === 0
      ? "BTreeMap::new()"
      : `BTreeMap::from([${personaArgs
          .map(([key, value]) => `(${rustStr(key)}.to_string(), ${argLiteralValue(value)})`)
          .join(", ")}])`;
  const triggers = def.triggers ?? [];
  const triggersComment =
    triggers.length > 0
      ? `\n        // TODO(triggers): ${triggers.length} declared persona trigger(s) are not\n        // auto-translated; author TriggerCondition entries here if needed.`
      : "";
  return `    // persona: ${persona.name}${triggersComment}
    agents.push(Agent::new(
        ${rustStr(persona.name)},
        Policy {
            persona_id: ${rustStr(persona.name)}.to_string(),
            persona_label: ${rustStr(label)}.to_string(),
            action_rate_multiplier: ${rustFloat(def.action_rate_multiplier)},
            risk_tolerance: 0.5,
            action_weights: ${weightsExpr},
            triggers: Vec::new(),
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".to_string(), ${rustFloat(def.amount)})]),
            },
            max_exposure: 1.0,
            persona_args: ${personaArgsExpr},
        },
        ${rustFloat(def.amount)},
    ));`;
}

function argLiteralValue(value: ArgLiteral): string {
  if (typeof value === "string") return `ArgLiteral::String(${rustStr(value)}.to_string())`;
  if (typeof value === "boolean") return `ArgLiteral::Bool(${value ? "true" : "false"})`;
  return `ArgLiteral::Int(${value})`;
}

function renderAccountSetupTodos(
  sharedFields: Map<string, string>,
  agentFields: Map<string, string>
): string {
  const lines: string[] = [
    "    // TODO(setup): create the [accounts] declared by the adapter so the",
    "    // executor and invariants can resolve them. Shared accounts are looked",
    "    // up by name; per-agent accounts are keyed via `.insert_agent(idx, pk)`.",
    "    //"
  ];
  for (const [ident, name] of sharedFields.entries()) {
    lines.push(`    //   shared: sim.accounts.${ident}.insert(${rustStr(name)}, <pubkey>);`);
  }
  for (const [ident, name] of agentFields.entries()) {
    lines.push(
      `    //   agent:  sim.accounts.${ident}.insert_agent(idx, <pubkey>); // ${name}`
    );
  }
  return lines.join("\n") + "\n";
}

function renderAgentAccountTodos(agentFields: Map<string, string>): string {
  if (agentFields.size === 0) return "";
  const lines = [...agentFields.entries()].map(
    ([ident, name]) =>
      `    //         // sim.accounts.${ident}.insert_agent(idx, <pubkey>); // ${name}`
  );
  return lines.join("\n") + "\n";
}

function findIdlInstruction(idl: GenericIdl, name: string): GenericInstruction | undefined {
  const target = normalizeIdlName(name);
  return idl.instructions.find((ix) => normalizeIdlName(ix.name) === target);
}

function normalizeIdlName(value: string): string {
  return value.replace(/-/g, "_").toLowerCase();
}

// Mirrors `engine/src/primitive/generic.rs::well_known_pubkey`.
const WELL_KNOWN_PUBKEYS: Record<string, string> = {
  system: "11111111111111111111111111111111",
  system_program: "11111111111111111111111111111111",
  spl_token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token_program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  spl_token_2022: "TokenzQdBNbLqP5VEhdkAS6EPFNH4QFMM8erqD8J1x",
  token_2022: "TokenzQdBNbLqP5VEhdkAS6EPFNH4QFMM8erqD8J1x",
  token_2022_program: "TokenzQdBNbLqP5VEhdkAS6EPFNH4QFMM8erqD8J1x",
  associated_token: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  associated_token_program: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  rent: "SysvarRent111111111111111111111111111111111",
  rent_sysvar: "SysvarRent111111111111111111111111111111111",
  sysvar_rent: "SysvarRent111111111111111111111111111111111",
  clock: "SysvarC1ock11111111111111111111111111111111",
  clock_sysvar: "SysvarC1ock11111111111111111111111111111111",
  sysvar_clock: "SysvarC1ock11111111111111111111111111111111",
  instructions_sysvar: "Sysvar1nstructions1111111111111111111111111",
  sysvar_instructions: "Sysvar1nstructions1111111111111111111111111",
  slot_hashes: "SysvarS1otHashes111111111111111111111111111",
  slot_hashes_sysvar: "SysvarS1otHashes111111111111111111111111111",
  sysvar_slot_hashes: "SysvarS1otHashes111111111111111111111111111",
  stake_history: "SysvarStakeHistory1111111111111111111111111",
  stake_history_sysvar: "SysvarStakeHistory1111111111111111111111111",
  sysvar_stake_history: "SysvarStakeHistory1111111111111111111111111"
};

function wellKnownPubkey(value: string): string | undefined {
  return WELL_KNOWN_PUBKEYS[value];
}

// Resolve an adapter/IDL `address` (well-known alias or base58 literal) to a
// rust `Pubkey` expression.
function pubkeyExpr(value: string): string {
  const known = wellKnownPubkey(value);
  return pubkeyLiteral(known ?? value);
}

function pubkeyLiteral(base58: string): string {
  return `Pubkey::from_str(${rustStr(base58)}).expect("generated pubkey literal is valid")`;
}

const NUMERIC_RUST_TYPES = new Set([
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128"
]);

function isNumericRustType(ty: string): boolean {
  return NUMERIC_RUST_TYPES.has(ty);
}

function argRustType(typeRef: GenericTypeRef): string {
  if (typeof typeRef === "string") {
    if (NUMERIC_RUST_TYPES.has(typeRef)) return typeRef;
    switch (typeRef) {
      case "bool":
        return "bool";
      case "string":
      case "String":
        return "String";
      case "bytes":
        return "Vec<u8>";
      case "pubkey":
      case "publicKey":
      case "Pubkey":
        return "Pubkey";
      default:
        return "u64";
    }
  }
  // Complex types are bound via persona_args/defaults; the value expression
  // falls back to Default::default().
  return "u64";
}

function rustBool(value: boolean): string {
  return value ? "true" : "false";
}

function rustFloat(value: number): string {
  return Number.isFinite(value) ? `${value}f64` : "0f64";
}

function rustStr(value: string): string {
  return JSON.stringify(value);
}

function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+|(?=[A-Z])/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function rustIdent(value: string): string {
  const ident = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const safe = ident.length > 0 ? ident : "field";
  return RUST_KEYWORDS.has(safe) ? `${safe}_` : safe;
}

const RUST_KEYWORDS = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn",
  "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
  "type", "unsafe", "use", "where", "while", "async", "await", "dyn"
]);
