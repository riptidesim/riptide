import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Hex, type JsonValue } from "../state-pack/json.js";
import type {
  CampaignPathRef,
  CampaignSpec,
  JsonScalar,
  ParameterDistribution,
  PersonaFamily,
  ScenarioFamily,
  SeedPolicy
} from "./schema.js";

export interface CampaignIdentity {
  canonicalCampaign: JsonValue;
  canonicalCampaignJson: string;
  campaignDigest: string;
  campaignId: string;
}

export interface CampaignExpansionOptions {
  cwd?: string;
  outputRoot?: string;
  maxRuns?: number;
}

export interface PersonaRunSelection {
  family: string;
  source: string;
  countParameter: string;
  count: number;
  scaleDepositsBy: string;
  scaleDeposits: JsonScalar;
  scaleBorrowsBy: string;
  scaleBorrows: JsonScalar;
}

export interface CampaignRunPlan {
  runIndex: number;
  runId: string;
  runSeed: string;
  engineSeed: number;
  runConfigDigest: string;
  scenarioFamily: string;
  scenarioSource: string;
  sampledParameters: Record<string, JsonScalar>;
  personas: PersonaRunSelection[];
  runDir: string;
  runConfigPath: string;
  runConfig: JsonValue;
  runConfigJson: string;
}

export interface CampaignExpansionPlan extends CampaignIdentity {
  campaignRoot: string;
  runs: CampaignRunPlan[];
}

export function canonicalSeedPolicy(policy: SeedPolicy): JsonValue {
  if (policy.kind === "fixed") return { kind: "fixed", seed: policy.seed };
  if (policy.kind === "range") {
    return { kind: "range", end: policy.end, start: policy.start };
  }
  return { kind: "expanding" };
}

export function canonicalCampaign(spec: CampaignSpec): JsonValue {
  return {
    adapter: spec.adapter.digestPath,
    class: spec.semanticClass,
    name: spec.name,
    parameters: canonicalParameters(spec.parameters),
    personas: {
      base: spec.personas.base.digestPath,
      definitions: Object.fromEntries(
        Object.entries(spec.personas.definitions).map(([name, family]) => [
          name,
          canonicalPersonaFamily(family)
        ])
      ),
      families: spec.personas.families
    },
    replay_retention: spec.replayRetention,
    risk_objective: spec.riskObjective,
    run_budget: spec.runBudget,
    scenarios: {
      definitions: Object.fromEntries(
        Object.entries(spec.scenarios.definitions).map(([name, family]) => [
          name,
          canonicalScenarioFamily(family)
        ])
      ),
      families: spec.scenarios.families,
      selection: spec.scenarios.selection
    },
    schema_version: spec.schemaVersion,
    seed_policy: canonicalSeedPolicy(spec.seedPolicy)
  };
}

export function campaignIdentity(spec: CampaignSpec): CampaignIdentity {
  const canonical = canonicalCampaign(spec);
  const json = stableJson(canonical);
  const digest = sha256Hex(`riptide-campaign-v1\n${json}`);
  return {
    canonicalCampaign: canonical,
    canonicalCampaignJson: json,
    campaignDigest: digest,
    campaignId: `campaign_${digest.slice(0, 12)}`
  };
}

export async function buildCampaignExpansion(
  spec: CampaignSpec,
  options: CampaignExpansionOptions = {}
): Promise<CampaignExpansionPlan> {
  const identity = campaignIdentity(spec);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const campaignRoot = path.resolve(
    options.outputRoot ?? path.join(cwd, ".riptide", "campaigns"),
    identity.campaignId
  );
  const runCount = runCountFor(spec, options.maxRuns);
  const runs: CampaignRunPlan[] = [];

  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    runs.push(
      await buildRunPlan({
        spec,
        identity,
        cwd,
        campaignRoot,
        runIndex
      })
    );
  }

  return { ...identity, campaignRoot, runs };
}

export async function materializeCampaignExpansion(
  spec: CampaignSpec,
  options: CampaignExpansionOptions = {}
): Promise<CampaignExpansionPlan> {
  const plan = await buildCampaignExpansion(spec, options);
  await mkdir(plan.campaignRoot, { recursive: true });
  await writeFile(
    path.join(plan.campaignRoot, "campaign-canonical.json"),
    `${plan.canonicalCampaignJson}\n`,
    "utf8"
  );

  for (const run of plan.runs) {
    await mkdir(run.runDir, { recursive: true });
    await writeFile(run.runConfigPath, run.runConfigJson, "utf8");
  }

  return plan;
}

export function deriveRunSeed(
  campaignDigest: string,
  runIndex: number,
  seedPolicy: SeedPolicy
): bigint {
  const seedPolicyJson = stableJson(canonicalSeedPolicy(seedPolicy));
  const hashed = firstU64(
    `riptide-campaign-run-seed-v1\n${campaignDigest}\n${runIndex}\n${seedPolicyJson}`
  );
  if (seedPolicy.kind !== "range") return hashed;
  const start = BigInt(seedPolicy.start);
  const end = BigInt(seedPolicy.end);
  return start + (hashed % (end - start + 1n));
}

export function generatedRunConfigDigest(runConfig: JsonValue): string {
  return sha256Hex(
    `riptide-run-config-v1\n${stableJson(redactRunConfigForDigest(runConfig))}`
  );
}

async function buildRunPlan(input: {
  spec: CampaignSpec;
  identity: CampaignIdentity;
  cwd: string;
  campaignRoot: string;
  runIndex: number;
}): Promise<CampaignRunPlan> {
  const { spec, identity, cwd, campaignRoot, runIndex } = input;
  const runSeed = deriveRunSeed(identity.campaignDigest, runIndex, spec.seedPolicy);
  const rng = new CampaignRng(runSeed.toString());
  const scenarioFamilyName = selectScenarioFamily(spec, rng);
  const scenarioFamily = spec.scenarios.definitions[scenarioFamilyName]!;
  const sampledParameters: Record<string, JsonScalar> = {};
  const sampleParameter = (name: string): JsonScalar => {
    if (Object.prototype.hasOwnProperty.call(sampledParameters, name)) {
      return sampledParameters[name]!;
    }
    const distribution = spec.parameters[name];
    if (!distribution) {
      throw new Error(`campaign expansion internal error: unknown parameter ${name}`);
    }
    const value = sampleDistribution(distribution, rng, `parameter:${name}`);
    sampledParameters[name] = value;
    return value;
  };

  for (const parameter of scenarioFamily.parameters) {
    sampleParameter(parameter);
  }

  const personaSelections = spec.personas.families.map((familyName) => {
    const family = spec.personas.definitions[familyName]!;
    const countValue = sampleParameter(family.count);
    return {
      family: familyName,
      source: family.source.digestPath,
      countParameter: family.count,
      count: jsonScalarToCount(countValue),
      scaleDepositsBy: family.scaleDepositsBy,
      scaleDeposits: 1,
      scaleBorrowsBy: family.scaleBorrowsBy,
      scaleBorrows: 1
    };
  });

  const baseRunConfig = await readBaseRunConfig(scenarioFamily.source);
  const engineSeed = engineSeedFromRunSeed(runSeed);
  const provisionalRunId = `run_${paddedRunIndex(runIndex)}_pending`;
  const provisionalRunDir = path.join(campaignRoot, "runs", provisionalRunId);
  const provisionalRunConfig = buildGeneratedRunConfig({
    spec,
    identity,
    runIndex,
    runSeed,
    engineSeed,
    runId: "__pending__",
    runConfigDigest: "__pending__",
    runDir: provisionalRunDir,
    cwd,
    baseRunConfig,
    scenarioFamilyName,
    scenarioFamily,
    sampledParameters,
    personaSelections
  });
  const runConfigDigest = generatedRunConfigDigest(provisionalRunConfig);
  const runId = `run_${paddedRunIndex(runIndex)}_${runConfigDigest.slice(0, 12)}`;
  const runDir = path.join(campaignRoot, "runs", runId);
  const runConfig = buildGeneratedRunConfig({
    spec,
    identity,
    runIndex,
    runSeed,
    engineSeed,
    runId,
    runConfigDigest,
    runDir,
    cwd,
    baseRunConfig,
    scenarioFamilyName,
    scenarioFamily,
    sampledParameters,
    personaSelections
  });

  return {
    runIndex,
    runId,
    runSeed: runSeed.toString(),
    engineSeed,
    runConfigDigest,
    scenarioFamily: scenarioFamilyName,
    scenarioSource: scenarioFamily.source.digestPath,
    sampledParameters,
    personas: personaSelections,
    runDir,
    runConfigPath: path.join(runDir, "run-config.json"),
    runConfig,
    runConfigJson: canonicalJson(runConfig)
  };
}

function buildGeneratedRunConfig(input: {
  spec: CampaignSpec;
  identity: CampaignIdentity;
  runIndex: number;
  runSeed: bigint;
  engineSeed: number;
  runId: string;
  runConfigDigest: string;
  runDir: string;
  cwd: string;
  baseRunConfig: Record<string, unknown>;
  scenarioFamilyName: string;
  scenarioFamily: ScenarioFamily;
  sampledParameters: Record<string, JsonScalar>;
  personaSelections: PersonaRunSelection[];
}): JsonValue {
  const personas = expandPersonaIds(input.personaSelections);
  const baseRunConfig = materializeSampledRunConfigFields(
    input.baseRunConfig,
    input.sampledParameters
  );
  const basePersonas = readStringArrayFromJson(baseRunConfig.personas);
  const selectedPersonas = personas.length > 0 ? personas : basePersonas;
  const agents = selectedPersonas.length > 0
    ? selectedPersonas.length
    : readPositiveIntegerFromJson(baseRunConfig.agents) ?? 1;
  const outputPath = normalizePath(path.relative(input.cwd, input.runDir));
  const adapterPath = normalizePath(path.relative(input.runDir, input.spec.adapter.resolved));
  const config: Record<string, JsonValue> = {
    adapter: adapterPath,
    agents,
    campaign: {
      adapter: input.spec.adapter.digestPath,
      campaign_digest: input.identity.campaignDigest,
      campaign_id: input.identity.campaignId,
      campaign_name: input.spec.name,
      class: input.spec.semanticClass,
      engine_seed: input.engineSeed,
      personas: input.personaSelections as unknown as JsonValue,
      replay_retention: input.spec.replayRetention,
      risk_objective: input.spec.riskObjective,
      run_config_digest: input.runConfigDigest,
      run_id: input.runId,
      run_index: input.runIndex,
      run_seed: input.runSeed.toString(),
      sampled_parameters: input.sampledParameters,
      scenario_family: input.scenarioFamilyName,
      scenario_source: input.scenarioFamily.source.digestPath,
      schema_version: "campaign-run.v1",
      seed_policy: canonicalSeedPolicy(input.spec.seedPolicy)
    },
    output_path: outputPath,
    personas: selectedPersonas,
    scenario: readStringFromJson(baseRunConfig.scenario) ?? slugify(input.scenarioFamilyName),
    seed: input.engineSeed,
    ticks: readPositiveIntegerFromJson(baseRunConfig.ticks) ?? 50,
    validator_url: readStringFromJson(baseRunConfig.validator_url) ?? "unused"
  };

  const statePack = readStringFromJson(baseRunConfig.state_pack);
  if (statePack) config.state_pack = statePack;
  return config;
}

function materializeSampledRunConfigFields(
  baseRunConfig: Record<string, unknown>,
  sampledParameters: Record<string, JsonScalar>
): Record<string, unknown> {
  const config = { ...baseRunConfig };

  const shockProfile = sampledParameters.shock_profile;
  if (typeof shockProfile === "string" && shockProfile.length > 0) {
    config.scenario = shockProfile;
  }

  const lagTicks = nonnegativeInteger(sampledParameters.oracle_lag_ticks);
  if (lagTicks !== undefined) {
    const baseTicks = readPositiveIntegerFromJson(config.ticks) ?? 50;
    config.ticks = baseTicks + lagTicks;
  }

  const whaleShareBps = nonnegativeInteger(sampledParameters.whale_share_bps);
  if (whaleShareBps !== undefined) {
    const basePersonas = readStringArrayFromJson(config.personas);
    const baseAgents =
      readPositiveIntegerFromJson(config.agents) ??
      (basePersonas.length > 0 ? basePersonas.length : 1);
    const personas = materializeWhaleShare(basePersonas, baseAgents, whaleShareBps);
    config.personas = personas;
    config.agents = personas.length;
  }

  return config;
}

function materializeWhaleShare(
  basePersonas: string[],
  baseAgents: number,
  whaleShareBps: number
): string[] {
  const agents = Math.max(1, baseAgents);
  const boundedBps = Math.max(0, Math.min(10_000, whaleShareBps));
  const whaleCount = Math.max(1, Math.min(agents, Math.round((agents * boundedBps) / 10_000)));
  const nonWhalePersona =
    basePersonas.find((persona) => persona !== "whale") ??
    "steady-lp";
  return [
    ...Array.from({ length: whaleCount }, () => "whale"),
    ...Array.from({ length: agents - whaleCount }, () => nonWhalePersona)
  ];
}

function nonnegativeInteger(value: JsonScalar | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function selectScenarioFamily(spec: CampaignSpec, rng: CampaignRng): string {
  const families = spec.scenarios.families;
  const totalWeight = families.reduce((sum, familyName) => {
    return sum + spec.scenarios.definitions[familyName]!.weight;
  }, 0);
  const draw = Number(rng.nextInt(BigInt(totalWeight), "scenario-family"));
  let cursor = 0;
  for (const familyName of families) {
    cursor += spec.scenarios.definitions[familyName]!.weight;
    if (draw < cursor) return familyName;
  }
  return families[families.length - 1]!;
}

function sampleDistribution(
  distribution: ParameterDistribution,
  rng: CampaignRng,
  label: string
): JsonScalar {
  if (distribution.distribution === "fixed") {
    return distribution.value;
  }
  if (distribution.distribution === "discrete") {
    const totalWeight = distribution.weights.reduce((sum, weight) => sum + weight, 0);
    const draw = Number(rng.nextInt(BigInt(totalWeight), label));
    let cursor = 0;
    for (let index = 0; index < distribution.values.length; index += 1) {
      cursor += distribution.weights[index]!;
      if (draw < cursor) return distribution.values[index]!;
    }
    return distribution.values[distribution.values.length - 1]!;
  }
  if (distribution.distribution === "uniform") {
    if (distribution.integer) {
      const span = BigInt(distribution.max - distribution.min + 1);
      return distribution.min + Number(rng.nextInt(span, label));
    }
    return distribution.min + (distribution.max - distribution.min) * rng.nextUnit(label);
  }

  const sampled = Math.exp(
    Math.log(distribution.min) +
      (Math.log(distribution.max) - Math.log(distribution.min)) * rng.nextUnit(label)
  );
  if (!distribution.integer) return sampled;
  return Math.min(distribution.max, Math.max(distribution.min, Math.round(sampled)));
}

async function readBaseRunConfig(source: CampaignPathRef): Promise<Record<string, unknown>> {
  const candidates = source.resolved.endsWith(".json")
    ? [source.resolved]
    : [path.join(source.resolved, "run-config.json")];
  const missingCandidates: string[] = [];
  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error("expected a JSON object");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        missingCandidates.push(candidate);
        continue;
      }
      throw new Error(`failed to read scenario template ${candidate}: ${errMessage(err)}`);
    }
  }
  throw new Error(
    `campaign scenario template not found for ${JSON.stringify(source.digestPath)}; ` +
      `expected a JSON object at ${missingCandidates.join(" or ")}`
  );
}

function canonicalScenarioFamily(family: ScenarioFamily): JsonValue {
  return {
    parameters: family.parameters,
    source: family.source.digestPath,
    weight: family.weight
  };
}

function canonicalPersonaFamily(family: PersonaFamily): JsonValue {
  return {
    count: family.count,
    scale_borrows_by: family.scaleBorrowsBy,
    scale_deposits_by: family.scaleDepositsBy,
    source: family.source.digestPath
  };
}

function canonicalParameters(
  parameters: Record<string, ParameterDistribution>
): JsonValue {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, distribution]) => [
      name,
      canonicalDistribution(distribution)
    ])
  );
}

function canonicalDistribution(distribution: ParameterDistribution): JsonValue {
  if (distribution.distribution === "fixed") {
    return withUnit(
      {
        distribution: "fixed",
        value: distribution.value
      },
      distribution.unit
    );
  }
  if (distribution.distribution === "discrete") {
    return withUnit(
      {
        distribution: "discrete",
        values: distribution.values,
        weights: distribution.weights
      },
      distribution.unit
    );
  }
  return withUnit(
    {
      distribution: distribution.distribution,
      integer: distribution.integer,
      max: distribution.max,
      min: distribution.min
    },
    distribution.unit
  );
}

function withUnit(value: Record<string, JsonValue>, unit: string | undefined): JsonValue {
  if (unit === undefined) return value;
  return { ...value, unit };
}

function redactRunConfigForDigest(value: JsonValue): JsonValue {
  const copy = cloneJson(value) as Record<string, JsonValue>;
  copy.output_path = "__campaign_run_output__";
  const campaign = copy.campaign;
  if (campaign !== null && typeof campaign === "object" && !Array.isArray(campaign)) {
    const campaignRecord = campaign as Record<string, JsonValue>;
    copy.adapter = typeof campaignRecord.adapter === "string"
      ? campaignRecord.adapter
      : "__campaign_run_adapter__";
    campaignRecord.run_id = "__campaign_run_id__";
    campaignRecord.run_config_digest = "__campaign_run_config_digest__";
  }
  return copy;
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function stableJson(value: JsonValue): string {
  return canonicalJson(value).trimEnd();
}

function firstU64(input: string): bigint {
  return crypto.createHash("sha256").update(input).digest().readBigUInt64BE(0);
}

class CampaignRng {
  private counter = 0;

  constructor(private readonly runSeed: string) {}

  nextInt(exclusiveMax: bigint, label: string): bigint {
    if (exclusiveMax <= 0n) {
      throw new Error("campaign expansion internal error: exclusive max must be positive");
    }
    return this.nextU64(label) % exclusiveMax;
  }

  nextUnit(label: string): number {
    const value = this.nextU64(label) >> 11n;
    return Number(value) / 2 ** 53;
  }

  private nextU64(label: string): bigint {
    const input =
      `riptide-campaign-sample-v1\n${this.runSeed}\n${this.counter}\n${label}`;
    this.counter += 1;
    return firstU64(input);
  }
}

function runCountFor(spec: CampaignSpec, maxRuns: number | undefined): number {
  if (maxRuns === undefined) return spec.runBudget;
  if (!Number.isSafeInteger(maxRuns) || maxRuns <= 0) {
    throw new Error(`maxRuns must be a positive safe integer, got ${maxRuns}`);
  }
  return Math.min(spec.runBudget, maxRuns);
}

function engineSeedFromRunSeed(runSeed: bigint): number {
  return Number(runSeed % 2_147_483_647n);
}

function jsonScalarToCount(value: JsonScalar): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function expandPersonaIds(selections: PersonaRunSelection[]): string[] {
  const personas: string[] = [];
  for (const selection of selections) {
    const personaId = personaIdFromSource(selection.source, selection.family);
    for (let index = 0; index < selection.count; index += 1) {
      personas.push(personaId);
    }
  }
  return personas;
}

function personaIdFromSource(source: string, fallback: string): string {
  const basename = path.posix.basename(source).replace(/\.toml$/i, "");
  const slug = slugify(basename || fallback);
  return slug || "campaign-persona";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function paddedRunIndex(runIndex: number): string {
  return runIndex.toString().padStart(6, "0");
}

function readStringFromJson(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveIntegerFromJson(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function readStringArrayFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
