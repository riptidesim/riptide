// Interactive prompts for `riptide init`.
//
// Eight questions, every one defaulted so Enter-through accepts the
// current state without ambiguity. The command layer handles the TTY
// gate and falls back to defaults under --yes / --quiet / non-TTY.

import { input, select, checkbox, Separator } from "@inquirer/prompts";

import {
  personaChoicesFor,
  PROTOCOL_CHOICES,
  protocolSpecificCount,
  type Protocol
} from "./personas-catalog.js";
import {
  scenarioChoicesFor,
  type InitScenarioConfig,
  type ScenarioCatalogEntry
} from "./scenarios-catalog.js";
import {
  invariantChoicesFor,
  invariantConfigFromCatalog,
  type InitInvariantConfig,
  type InvariantCatalogEntry
} from "./invariants-catalog.js";
import {
  DEFAULT_INIT_SEEDS,
  seedForSeedCount,
  type InitHarnessMode
} from "./options.js";

export interface WizardDefaults {
  programName: string;
  protocol: Protocol;
  agents: number;
  ticks: number;
  seeds?: number;
  harnessMode?: InitHarnessMode;
}

export interface WizardAnswers {
  programName: string;
  protocol: Protocol;
  harnessMode?: InitHarnessMode;
  seeds: number;
  personas: string[];
  scenarios: InitScenarioConfig[];
  invariants: InitInvariantConfig[];
  agents: number;
  ticks: number;
}

const PROGRAM_NAME_RE = /^[a-z][a-z0-9-]*$/;

export async function runWizard(defaults: WizardDefaults): Promise<WizardAnswers> {
  const programName = await input({
    message: "Program name (lowercase, dashes only):",
    default: defaults.programName,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Program name is required";
      if (!PROGRAM_NAME_RE.test(trimmed)) {
        return "Use lowercase letters, numbers, and dashes; must start with a letter";
      }
      return true;
    }
  });

  const protocol = (await select({
    message: "Adapter protocol:",
    default: defaults.protocol,
    choices: PROTOCOL_CHOICES.map((choice) => ({
      value: choice.value,
      name: choice.label
    }))
  })) as Protocol;

  const presets = personaChoicesFor(protocol);
  let personas: string[] = [];
  if (presets.length > 0) {
    const specificCount = protocolSpecificCount(protocol);
    // Insert a visual separator between the protocol-specific group
    // (curated for this protocol's action vocab) and the generic
    // archetypes (require editing action_weights to fit). No separator
    // when one group is empty, e.g. "custom" has only generics.
    const choices: Array<
      | { value: string; name: string; checked: boolean }
      | InstanceType<typeof Separator>
    > = [];
    presets.forEach((preset, index) => {
      if (index === 0 && specificCount > 0) {
        choices.push(new Separator(`── ${protocol} archetypes ──`));
      }
      if (index === specificCount && specificCount > 0 && specificCount < presets.length) {
        choices.push(new Separator("── Generic archetypes (edit action_weights to fit) ──"));
      }
      if (index === 0 && specificCount === 0) {
        choices.push(new Separator("── Generic archetypes ──"));
      }
      choices.push({
        value: preset.slug,
        name: preset.label,
        checked: index < specificCount || specificCount === 0
      });
    });
    // pageSize large enough to fit the full catalog without scrolling
    // on a typical terminal (terminal-height clamp inside inquirer).
    personas = (await checkbox({
      message: "Personas to include (space to toggle, enter to confirm):",
      choices,
      pageSize: 25,
      loop: false
    })) as string[];
  }

  const scenarioCatalog = scenarioChoicesFor(protocol);
  let selectedScenarioNames = new Set<string>();
  if (scenarioCatalog.length > 0) {
    const choices = scenarioCatalog.map((entry) => ({
      value: entry.name,
      name: scenarioChoiceLabel(entry),
      checked: entry.required || entry.recommended,
      disabled: entry.required ? "[locked]" : false
    }));
    const selected = (await checkbox({
      message: "Stress scenarios to scaffold (space to toggle, enter to confirm):",
      choices,
      pageSize: 12,
      loop: false
    })) as string[];
    selectedScenarioNames = new Set(selected);
  }
  for (const entry of scenarioCatalog) {
    if (entry.required) {
      selectedScenarioNames.add(entry.name);
    }
  }

  const invariantCatalog = invariantChoicesFor(protocol);
  let selectedInvariantNames = new Set<string>();
  if (invariantCatalog.length > 0) {
    const choices = invariantCatalog.map((entry) => ({
      value: entry.name,
      name: invariantChoiceLabel(entry),
      checked: entry.required || entry.recommended || entry.commented,
      disabled: entry.required ? "[locked]" : false
    }));
    const selected = (await checkbox({
      message: "Invariants to inline (space to toggle, enter to confirm):",
      choices,
      pageSize: 12,
      loop: false
    })) as string[];
    selectedInvariantNames = new Set(selected);
  }
  for (const entry of invariantCatalog) {
    if (entry.required) {
      selectedInvariantNames.add(entry.name);
    }
  }

  const agents = await input({
    message: "Agents per simulation (population axis):",
    default: String(defaults.agents),
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return "Enter a positive integer";
      }
      return true;
    }
  });

  const ticks = await input({
    message: "Ticks per simulation (1 tick ≈ 1 Solana slot ≈ 400ms simulated):",
    default: String(defaults.ticks),
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return "Enter a positive integer";
      }
      return true;
    }
  });

  const seeds = await input({
    message: "Seeds to run by default (1 = quick smoke, 50 = confidence sweep):",
    default: String(defaults.seeds ?? DEFAULT_INIT_SEEDS),
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return "Enter a positive integer";
      }
      return true;
    }
  });

  const resolvedAgents = Number(agents);
  const resolvedTicks = Number(ticks);
  const resolvedSeeds = Number(seeds);

  return {
    programName: programName.trim(),
    protocol,
    seeds: resolvedSeeds,
    personas,
    scenarios: scenarioCatalog
      .filter((entry) => selectedScenarioNames.has(entry.name))
      .map((entry) => resolveScenario(entry, {
        personas,
        agents: resolvedAgents,
        ticks: resolvedTicks,
        baselineUsesDefaults: true,
        seeds: resolvedSeeds,
        seed: seedForSeedCount(resolvedSeeds)
      })),
    invariants: invariantCatalog
      .filter((entry) => selectedInvariantNames.has(entry.name))
      .map((entry) => invariantConfigFromCatalog(entry)),
    agents: resolvedAgents,
    ticks: resolvedTicks
  };
}

function scenarioChoiceLabel(entry: ScenarioCatalogEntry): string {
  const suffixes: string[] = [];
  if (entry.required) suffixes.push("required");
  else if (entry.recommended) suffixes.push("recommended");
  return suffixes.length === 0 ? entry.label : `${entry.label} [${suffixes.join(", ")}]`;
}

function invariantChoiceLabel(entry: InvariantCatalogEntry): string {
  const suffixes: string[] = [];
  if (entry.commented) suffixes.push("template");
  else if (entry.recommended && !entry.required) suffixes.push("recommended");
  return suffixes.length === 0 ? entry.label : `${entry.label} [${suffixes.join(", ")}]`;
}

function resolveScenario(
  entry: ScenarioCatalogEntry,
  defaults: {
    personas: string[];
    agents: number;
    ticks: number;
    seeds?: number;
    baselineUsesDefaults: boolean;
    seed?: number;
  }
): InitScenarioConfig {
  const isBaseline = entry.name === "baseline" || entry.scenario === "baseline";
  const useDefaultSizing = isBaseline && defaults.baselineUsesDefaults;
  return {
    name: entry.name,
    scenario: entry.scenario,
    agents: useDefaultSizing ? defaults.agents : (entry.agents ?? defaults.agents),
    ticks: useDefaultSizing ? defaults.ticks : (entry.ticks ?? defaults.ticks),
    personas: entry.defaultPersonas ?? defaults.personas,
    seed: defaults.seed,
    seeds: defaults.seed === undefined ? defaults.seeds : undefined
  };
}
