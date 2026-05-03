import { readFile } from "node:fs/promises";
import path from "node:path";

import TOML from "toml";

import {
  isSupportedSemanticClass,
  type SemanticClass
} from "../schemas/adapter.js";

export const CAMPAIGN_SCHEMA_VERSION = "campaign.v1" as const;

export const BUILTIN_RISK_OBJECTIVES = [
  "launch-readiness",
  "oracle-stress",
  "liquidity-exit",
  "liquidation-safety"
] as const;

export const RETENTION_LABELS = [
  "first_failure",
  "worst_bad_debt",
  "worst_liquidity",
  "median",
  "surprising_outlier"
] as const;

export const DEFAULT_REPLAY_RETENTION = [...RETENTION_LABELS];

export const MATERIALIZED_SCENARIO_PARAMETERS = [
  "shock_profile",
  "oracle_lag_ticks",
  "whale_share_bps"
] as const;

export type RiskObjective =
  | (typeof BUILTIN_RISK_OBJECTIVES)[number]
  | `custom:${string}`;

export type RetentionLabel = (typeof RETENTION_LABELS)[number];

export type JsonScalar = string | number | boolean | null;

export type SeedPolicy =
  | { kind: "fixed"; seed: string }
  | { kind: "expanding" }
  | { kind: "range"; start: string; end: string };

export interface CampaignPathRef {
  input: string;
  resolved: string;
  digestPath: string;
  wasRelative: boolean;
}

export interface ScenarioFamily {
  source: CampaignPathRef;
  weight: number;
  parameters: string[];
}

export interface ScenarioSelection {
  selection: "weighted";
  families: string[];
  definitions: Record<string, ScenarioFamily>;
}

export interface PersonaFamily {
  source: CampaignPathRef;
  count: string;
  scaleDepositsBy: string;
  scaleBorrowsBy: string;
}

export interface PersonaSelection {
  base: CampaignPathRef;
  families: string[];
  definitions: Record<string, PersonaFamily>;
}

export type ParameterDistribution =
  | {
      distribution: "uniform";
      min: number;
      max: number;
      integer: boolean;
      unit?: string;
    }
  | {
      distribution: "log-uniform";
      min: number;
      max: number;
      integer: boolean;
      unit?: string;
    }
  | {
      distribution: "discrete";
      values: JsonScalar[];
      weights: number[];
      unit?: string;
    }
  | {
      distribution: "fixed";
      value: JsonScalar;
      unit?: string;
    };

export interface CampaignSpec {
  schemaVersion: typeof CAMPAIGN_SCHEMA_VERSION;
  filePath: string;
  campaignDir: string;
  name: string;
  adapter: CampaignPathRef;
  semanticClass: SemanticClass;
  riskObjective: RiskObjective;
  runBudget: number;
  seedPolicy: SeedPolicy;
  replayRetention: RetentionLabel[];
  scenarios: ScenarioSelection;
  personas: PersonaSelection;
  parameters: Record<string, ParameterDistribution>;
}

export interface CampaignDiagnostic {
  path: string;
  message: string;
}

export class CampaignValidationError extends Error {
  readonly diagnostics: CampaignDiagnostic[];
  readonly filePath: string;

  constructor(filePath: string, diagnostics: CampaignDiagnostic[]) {
    super(renderCampaignDiagnostics(filePath, diagnostics));
    this.name = "CampaignValidationError";
    this.filePath = filePath;
    this.diagnostics = diagnostics;
  }
}

export async function readCampaignTomlFile(filePath: string): Promise<CampaignSpec> {
  const absolutePath = path.resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (err) {
    throw new Error(`campaign TOML not found at ${absolutePath}: ${errMessage(err)}`);
  }
  return parseCampaignToml(raw, absolutePath);
}

export function parseCampaignToml(raw: string, filePath = "campaign.toml"): CampaignSpec {
  const absolutePath = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    throw new CampaignValidationError(absolutePath, [
      {
        path: "campaign",
        message: `TOML parse failed: ${errMessage(err)}`
      }
    ]);
  }
  return validateCampaignObject(parsed, absolutePath);
}

export function validateCampaignObject(raw: unknown, filePath = "campaign.toml"): CampaignSpec {
  const absolutePath = path.resolve(filePath);
  const campaignDir = path.dirname(absolutePath);
  const diagnostics: CampaignDiagnostic[] = [];

  const root = asRecord(raw);
  if (!root) {
    throw new CampaignValidationError(absolutePath, [
      { path: "campaign", message: "expected a TOML document with a [campaign] table" }
    ]);
  }
  checkKnownKeys(root, new Set(["campaign"]), "", diagnostics);

  const campaign = readRecord(root, "campaign", "campaign", diagnostics);
  if (!campaign) throw new CampaignValidationError(absolutePath, diagnostics);

  checkKnownKeys(
    campaign,
    new Set([
      "name",
      "adapter",
      "class",
      "risk_objective",
      "run_budget",
      "seed_policy",
      "replay_retention",
      "scenarios",
      "personas",
      "parameters"
    ]),
    "campaign",
    diagnostics
  );

  const name = readString(campaign, "name", "campaign.name", diagnostics);
  const adapterRaw = readString(campaign, "adapter", "campaign.adapter", diagnostics);
  const semanticClassRaw = readString(campaign, "class", "campaign.class", diagnostics);
  const objectiveRaw = readString(
    campaign,
    "risk_objective",
    "campaign.risk_objective",
    diagnostics
  );
  const runBudget = readPositiveInteger(
    campaign,
    "run_budget",
    "campaign.run_budget",
    diagnostics
  );
  const seedPolicyRaw = readString(
    campaign,
    "seed_policy",
    "campaign.seed_policy",
    diagnostics
  );
  const replayRetention = readReplayRetention(campaign, diagnostics);

  validateCampaignName(name, diagnostics);
  const semanticClass = validateSemanticClass(semanticClassRaw, diagnostics);
  const riskObjective = validateRiskObjective(objectiveRaw, diagnostics);
  const seedPolicy = validateSeedPolicy(seedPolicyRaw, diagnostics);
  const adapter = adapterRaw
    ? resolveCampaignPath(adapterRaw, campaignDir)
    : missingPathRef(campaignDir);

  const parameters = parseParameters(
    readRecord(campaign, "parameters", "campaign.parameters", diagnostics),
    diagnostics
  );
  if (!parameters.fixed_one) {
    parameters.fixed_one = { distribution: "fixed", value: 1 };
  }

  const scenarios = parseScenarios(
    readRecord(campaign, "scenarios", "campaign.scenarios", diagnostics),
    campaignDir,
    parameters,
    diagnostics
  );
  const personas = parsePersonas(
    readRecord(campaign, "personas", "campaign.personas", diagnostics),
    campaignDir,
    parameters,
    diagnostics
  );

  validateParameterUses(parameters, scenarios, personas, diagnostics);

  if (diagnostics.length > 0) {
    throw new CampaignValidationError(absolutePath, diagnostics);
  }

  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    filePath: absolutePath,
    campaignDir,
    name: name!,
    adapter,
    semanticClass: semanticClass!,
    riskObjective: riskObjective!,
    runBudget: runBudget!,
    seedPolicy: seedPolicy!,
    replayRetention,
    scenarios: scenarios!,
    personas: personas!,
    parameters
  };
}

export function renderCampaignDiagnostics(
  filePath: string,
  diagnostics: CampaignDiagnostic[]
): string {
  if (diagnostics.length === 0) return `campaign validation failed: ${filePath}`;
  const lines = [`campaign validation failed: ${filePath}`];
  for (const diagnostic of diagnostics) {
    lines.push(`  ${diagnostic.path}: ${diagnostic.message}`);
  }
  return lines.join("\n");
}

function parseScenarios(
  raw: Record<string, unknown> | undefined,
  campaignDir: string,
  parameters: Record<string, ParameterDistribution>,
  diagnostics: CampaignDiagnostic[]
): ScenarioSelection | undefined {
  if (!raw) return undefined;
  const families = readStringArray(raw, "families", "campaign.scenarios.families", diagnostics);
  const selection = readString(raw, "selection", "campaign.scenarios.selection", diagnostics);

  if (selection !== undefined && selection !== "weighted") {
    diagnostics.push({
      path: "campaign.scenarios.selection",
      message: 'expected "weighted" for Campaign v1'
    });
  }
  validateUniqueStrings(families, "campaign.scenarios.families", diagnostics);

  const allowedKeys = new Set(["selection", "families", ...(families ?? [])]);
  checkKnownKeys(raw, allowedKeys, "campaign.scenarios", diagnostics);

  const definitions: Record<string, ScenarioFamily> = {};
  for (const family of families ?? []) {
    const familyPath = `campaign.scenarios.${family}`;
    const table = readRecord(raw, family, familyPath, diagnostics);
    if (!table) continue;
    checkKnownKeys(table, new Set(["source", "weight", "parameters"]), familyPath, diagnostics);
    const source = readString(table, "source", `${familyPath}.source`, diagnostics);
    const weight = readOptionalPositiveInteger(
      table,
      "weight",
      `${familyPath}.weight`,
      diagnostics,
      1
    );
    const familyParameters = readOptionalStringArray(
      table,
      "parameters",
      `${familyPath}.parameters`,
      diagnostics,
      []
    );
    for (const parameterName of familyParameters) {
      if (!parameters[parameterName]) {
        diagnostics.push({
          path: `${familyPath}.parameters`,
          message: `unknown parameter reference ${JSON.stringify(parameterName)}`
        });
      }
    }
    definitions[family] = {
      source: source
        ? resolveCampaignPath(source, campaignDir)
        : missingPathRef(campaignDir),
      weight,
      parameters: familyParameters
    };
  }

  return {
    selection: "weighted",
    families: families ?? [],
    definitions
  };
}

function parsePersonas(
  raw: Record<string, unknown> | undefined,
  campaignDir: string,
  parameters: Record<string, ParameterDistribution>,
  diagnostics: CampaignDiagnostic[]
): PersonaSelection | undefined {
  if (!raw) return undefined;
  const baseRaw = readString(raw, "base", "campaign.personas.base", diagnostics);
  const base = baseRaw ? resolveCampaignPath(baseRaw, campaignDir) : missingPathRef(campaignDir);
  const families = readStringArrayAllowEmpty(
    raw,
    "families",
    "campaign.personas.families",
    diagnostics
  );
  validateUniqueStrings(families, "campaign.personas.families", diagnostics);

  const allowedKeys = new Set(["base", "families", ...(families ?? [])]);
  checkKnownKeys(raw, allowedKeys, "campaign.personas", diagnostics);

  const definitions: Record<string, PersonaFamily> = {};
  for (const family of families ?? []) {
    const familyPath = `campaign.personas.${family}`;
    const table = readRecord(raw, family, familyPath, diagnostics);
    if (!table) continue;
    checkKnownKeys(
      table,
      new Set(["source", "count", "scale_deposits_by", "scale_borrows_by"]),
      familyPath,
      diagnostics
    );
    const sourceRaw = readString(table, "source", `${familyPath}.source`, diagnostics);
    const count = readString(table, "count", `${familyPath}.count`, diagnostics);
    const scaleDepositsBy = readOptionalString(
      table,
      "scale_deposits_by",
      `${familyPath}.scale_deposits_by`,
      diagnostics,
      "fixed_one"
    ) ?? "fixed_one";
    const scaleBorrowsBy = readOptionalString(
      table,
      "scale_borrows_by",
      `${familyPath}.scale_borrows_by`,
      diagnostics,
      "fixed_one"
    ) ?? "fixed_one";

    for (const [field, parameterName] of [
      ["count", count],
      ["scale_deposits_by", scaleDepositsBy],
      ["scale_borrows_by", scaleBorrowsBy]
    ] as const) {
      if (parameterName !== undefined && !parameters[parameterName]) {
        diagnostics.push({
          path: `${familyPath}.${field}`,
          message: `unknown parameter reference ${JSON.stringify(parameterName)}`
        });
      }
    }

    definitions[family] = {
      source: sourceRaw
        ? resolveNestedPath(sourceRaw, base)
        : missingPathRef(base.resolved),
      count: count ?? "",
      scaleDepositsBy,
      scaleBorrowsBy
    };
  }

  return { base, families: families ?? [], definitions };
}

function parseParameters(
  raw: Record<string, unknown> | undefined,
  diagnostics: CampaignDiagnostic[]
): Record<string, ParameterDistribution> {
  const parameters: Record<string, ParameterDistribution> = {};
  if (!raw) return parameters;
  for (const [name, value] of Object.entries(raw)) {
    const pathPrefix = `campaign.parameters.${name}`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      diagnostics.push({
        path: pathPrefix,
        message: "parameter names must start with a letter or underscore and contain letters, numbers, or underscores"
      });
    }
    const table = asRecord(value);
    if (!table) {
      diagnostics.push({ path: pathPrefix, message: "expected a parameter table" });
      continue;
    }
    const distribution = readString(table, "distribution", `${pathPrefix}.distribution`, diagnostics);
    if (!distribution) continue;
    const parsed = parseParameterDistribution(distribution, table, pathPrefix, diagnostics);
    if (parsed) parameters[name] = parsed;
  }
  return parameters;
}

function parseParameterDistribution(
  distribution: string,
  table: Record<string, unknown>,
  pathPrefix: string,
  diagnostics: CampaignDiagnostic[]
): ParameterDistribution | undefined {
  if (distribution === "uniform" || distribution === "log-uniform") {
    checkKnownKeys(
      table,
      new Set(["distribution", "min", "max", "integer", "unit"]),
      pathPrefix,
      diagnostics
    );
    const min = readNumber(table, "min", `${pathPrefix}.min`, diagnostics);
    const max = readNumber(table, "max", `${pathPrefix}.max`, diagnostics);
    const integer = readOptionalBoolean(
      table,
      "integer",
      `${pathPrefix}.integer`,
      diagnostics,
      false
    );
    const unit = readOptionalString(table, "unit", `${pathPrefix}.unit`, diagnostics);
    if (min !== undefined && max !== undefined) {
      if (max < min) {
        diagnostics.push({ path: `${pathPrefix}.max`, message: "`max` must be greater than or equal to `min`" });
      }
      if (distribution === "log-uniform" && (min <= 0 || max <= 0)) {
        diagnostics.push({
          path: pathPrefix,
          message: "`log-uniform` requires `min` and `max` greater than zero"
        });
      }
      if (integer && (!Number.isSafeInteger(min) || !Number.isSafeInteger(max))) {
        diagnostics.push({
          path: pathPrefix,
          message: "`integer = true` requires safe integer `min` and `max` endpoints"
        });
      }
    }
    if (min === undefined || max === undefined) return undefined;
    const parsed = distribution === "uniform"
      ? { distribution: "uniform" as const, min, max, integer }
      : { distribution: "log-uniform" as const, min, max, integer };
    return withOptionalUnit(parsed, unit);
  }

  if (distribution === "discrete") {
    checkKnownKeys(
      table,
      new Set(["distribution", "values", "weights", "unit"]),
      pathPrefix,
      diagnostics
    );
    const values = readScalarArray(table, "values", `${pathPrefix}.values`, diagnostics);
    const weights = readOptionalWeights(table, "weights", `${pathPrefix}.weights`, values?.length, diagnostics);
    const unit = readOptionalString(table, "unit", `${pathPrefix}.unit`, diagnostics);
    if (!values) return undefined;
    return withOptionalUnit(
      { distribution: "discrete" as const, values, weights: weights ?? values.map(() => 1) },
      unit
    );
  }

  if (distribution === "fixed") {
    checkKnownKeys(table, new Set(["distribution", "value", "unit"]), pathPrefix, diagnostics);
    const value = readScalar(table, "value", `${pathPrefix}.value`, diagnostics);
    const unit = readOptionalString(table, "unit", `${pathPrefix}.unit`, diagnostics);
    if (value === undefined) return undefined;
    return withOptionalUnit({ distribution: "fixed" as const, value }, unit);
  }

  diagnostics.push({
    path: `${pathPrefix}.distribution`,
    message: 'expected one of "uniform", "log-uniform", "discrete", or "fixed"'
  });
  return undefined;
}

function validateParameterUses(
  parameters: Record<string, ParameterDistribution>,
  scenarios: ScenarioSelection | undefined,
  personas: PersonaSelection | undefined,
  diagnostics: CampaignDiagnostic[]
): void {
  if (!scenarios || !personas) return;

  const materializedScenarioParameters = new Set<string>(MATERIALIZED_SCENARIO_PARAMETERS);
  for (const [familyName, family] of Object.entries(scenarios.definitions)) {
    for (const parameterName of family.parameters) {
      const distribution = parameters[parameterName];
      if (distribution && !materializedScenarioParameters.has(parameterName)) {
        diagnostics.push({
          path: `campaign.scenarios.${familyName}.parameters`,
          message:
            `parameter ${JSON.stringify(parameterName)} is visible in campaign plan/run output ` +
            "but Campaign v1 does not materialize it into generated run configs; " +
            `use one of ${MATERIALIZED_SCENARIO_PARAMETERS.map((name) => JSON.stringify(name)).join(", ")} or remove it`
        });
      }
      if (!distribution) continue;
      if (parameterName === "shock_profile" && !distributionEmitsNonemptyString(distribution)) {
        diagnostics.push({
          path: `campaign.parameters.${parameterName}`,
          message: "shock_profile must always emit a non-empty string scenario name"
        });
      }
      if (
        parameterName === "oracle_lag_ticks" &&
        !distributionEmitsNonnegativeInteger(distribution)
      ) {
        diagnostics.push({
          path: `campaign.parameters.${parameterName}`,
          message: "oracle_lag_ticks must always emit a nonnegative integer tick count"
        });
      }
      if (
        parameterName === "whale_share_bps" &&
        !distributionEmitsIntegerInRange(distribution, 0, 10_000)
      ) {
        diagnostics.push({
          path: `campaign.parameters.${parameterName}`,
          message: "whale_share_bps must always emit an integer between 0 and 10000"
        });
      }
    }
  }

  for (const [familyName, family] of Object.entries(personas.definitions)) {
    const countDistribution = parameters[family.count];
    if (countDistribution && !distributionEmitsNonnegativeInteger(countDistribution)) {
      diagnostics.push({
        path: `campaign.personas.${familyName}.count`,
        message: `parameter ${JSON.stringify(family.count)} must always emit a nonnegative integer count`
      });
    }
    for (const [field, parameterName] of [
      ["scale_deposits_by", family.scaleDepositsBy],
      ["scale_borrows_by", family.scaleBorrowsBy]
    ] as const) {
      if (parameterName !== "fixed_one") {
        diagnostics.push({
          path: `campaign.personas.${familyName}.${field}`,
          message:
            `${field} is not materialized into generated run configs in Campaign v1; ` +
            "remove it or leave the default fixed_one"
        });
      }
      const distribution = parameters[parameterName];
      if (distribution && !distributionEmitsNonnegativeNumber(distribution)) {
        diagnostics.push({
          path: `campaign.personas.${familyName}.${field}`,
          message: `parameter ${JSON.stringify(parameterName)} must always emit a nonnegative numeric scale`
        });
      }
    }
  }
}

function validateCampaignName(
  value: string | undefined,
  diagnostics: CampaignDiagnostic[]
): void {
  if (value === undefined) return;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    diagnostics.push({
      path: "campaign.name",
      message: "expected a stable lowercase identifier using letters, numbers, dots, underscores, or dashes"
    });
  }
}

function validateSemanticClass(
  value: string | undefined,
  diagnostics: CampaignDiagnostic[]
): SemanticClass | undefined {
  if (value === undefined) return undefined;
  if (!isSupportedSemanticClass(value)) {
    diagnostics.push({
      path: "campaign.class",
      message: `unsupported semantic class ${JSON.stringify(value)}`
    });
    return undefined;
  }
  return value;
}

function validateRiskObjective(
  value: string | undefined,
  diagnostics: CampaignDiagnostic[]
): RiskObjective | undefined {
  if (value === undefined) return undefined;
  if ((BUILTIN_RISK_OBJECTIVES as readonly string[]).includes(value)) {
    return value as RiskObjective;
  }
  if (/^custom:[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    return value as RiskObjective;
  }
  diagnostics.push({
    path: "campaign.risk_objective",
    message: 'expected a built-in objective or "custom:<name>"'
  });
  return undefined;
}

function validateSeedPolicy(
  value: string | undefined,
  diagnostics: CampaignDiagnostic[]
): SeedPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "expanding") return { kind: "expanding" };

  const fixed = /^fixed:(\d+)$/.exec(value);
  if (fixed) {
    if (!isU64Decimal(fixed[1]!)) {
      diagnostics.push({ path: "campaign.seed_policy", message: "`fixed` seed must fit u64" });
      return undefined;
    }
    return { kind: "fixed", seed: fixed[1]! };
  }

  const range = /^range:(\d+)\.\.(\d+)$/.exec(value);
  if (range) {
    const start = range[1]!;
    const end = range[2]!;
    if (!isU64Decimal(start) || !isU64Decimal(end)) {
      diagnostics.push({ path: "campaign.seed_policy", message: "`range` endpoints must fit u64" });
      return undefined;
    }
    if (BigInt(start) > BigInt(end)) {
      diagnostics.push({ path: "campaign.seed_policy", message: "`range` start must be <= end" });
      return undefined;
    }
    return { kind: "range", start, end };
  }

  diagnostics.push({
    path: "campaign.seed_policy",
    message: 'expected "fixed:<u64>", "expanding", or "range:<start>..<end>"'
  });
  return undefined;
}

function readReplayRetention(
  campaign: Record<string, unknown>,
  diagnostics: CampaignDiagnostic[]
): RetentionLabel[] {
  if (!hasKey(campaign, "replay_retention")) {
    return [...DEFAULT_REPLAY_RETENTION];
  }
  const values = readStringArray(
    campaign,
    "replay_retention",
    "campaign.replay_retention",
    diagnostics
  );
  if (!values) return [];
  const seen = new Set<string>();
  const labels: RetentionLabel[] = [];
  for (const [index, label] of values.entries()) {
    const itemPath = `campaign.replay_retention[${index}]`;
    if (!(RETENTION_LABELS as readonly string[]).includes(label)) {
      diagnostics.push({
        path: itemPath,
        message: `unsupported retention label ${JSON.stringify(label)}`
      });
      continue;
    }
    if (seen.has(label)) {
      diagnostics.push({
        path: itemPath,
        message: `duplicate retention label ${JSON.stringify(label)}`
      });
      continue;
    }
    seen.add(label);
    labels.push(label as RetentionLabel);
  }
  return labels;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): Record<string, unknown> | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required table" });
    return undefined;
  }
  const value = asRecord(record[key]);
  if (!value) {
    diagnostics.push({ path: keyPath, message: "expected a table" });
    return undefined;
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): string | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required string" });
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({ path: keyPath, message: "expected a non-empty string" });
    return undefined;
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[],
  defaultValue?: string
): string | undefined {
  if (!hasKey(record, key)) return defaultValue;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({ path: keyPath, message: "expected a non-empty string" });
    return defaultValue;
  }
  return value;
}

function readPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): number | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required positive integer" });
    return undefined;
  }
  return parsePositiveIntegerValue(record[key], keyPath, diagnostics);
}

function readOptionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[],
  defaultValue: number
): number {
  if (!hasKey(record, key)) return defaultValue;
  return parsePositiveIntegerValue(record[key], keyPath, diagnostics) ?? defaultValue;
}

function parsePositiveIntegerValue(
  value: unknown,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    diagnostics.push({ path: keyPath, message: "expected a positive safe integer" });
    return undefined;
  }
  return value;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): number | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required number" });
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    diagnostics.push({ path: keyPath, message: "expected a finite number" });
    return undefined;
  }
  return value;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[],
  defaultValue: boolean
): boolean {
  if (!hasKey(record, key)) return defaultValue;
  const value = record[key];
  if (typeof value !== "boolean") {
    diagnostics.push({ path: keyPath, message: "expected a boolean" });
    return defaultValue;
  }
  return value;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): string[] | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required string array" });
    return undefined;
  }
  return parseStringArray(record[key], keyPath, diagnostics);
}

function readStringArrayAllowEmpty(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): string[] | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required string array" });
    return undefined;
  }
  return parseStringArray(record[key], keyPath, diagnostics, true);
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[],
  defaultValue: string[]
): string[] {
  if (!hasKey(record, key)) return defaultValue;
  return parseStringArray(record[key], keyPath, diagnostics) ?? defaultValue;
}

function parseStringArray(
  value: unknown,
  keyPath: string,
  diagnostics: CampaignDiagnostic[],
  allowEmpty = false
): string[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push({ path: keyPath, message: "expected an array of strings" });
    return undefined;
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      diagnostics.push({
        path: `${keyPath}[${index}]`,
        message: "expected a non-empty string"
      });
      continue;
    }
    result.push(entry);
  }
  if (result.length === 0 && !allowEmpty) {
    diagnostics.push({ path: keyPath, message: "expected at least one entry" });
  }
  return result;
}

function readScalarArray(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): JsonScalar[] | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required scalar array" });
    return undefined;
  }
  const value = record[key];
  if (!Array.isArray(value)) {
    diagnostics.push({ path: keyPath, message: "expected an array of JSON scalar values" });
    return undefined;
  }
  const result: JsonScalar[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isJsonScalar(entry)) {
      diagnostics.push({ path: `${keyPath}[${index}]`, message: "expected a JSON scalar value" });
      continue;
    }
    result.push(entry);
  }
  if (result.length === 0) {
    diagnostics.push({ path: keyPath, message: "expected at least one value" });
  }
  return result;
}

function readScalar(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): JsonScalar | undefined {
  if (!hasKey(record, key)) {
    diagnostics.push({ path: keyPath, message: "missing required scalar value" });
    return undefined;
  }
  const value = record[key];
  if (!isJsonScalar(value)) {
    diagnostics.push({ path: keyPath, message: "expected a JSON scalar value" });
    return undefined;
  }
  return value;
}

function readOptionalWeights(
  record: Record<string, unknown>,
  key: string,
  keyPath: string,
  expectedLength: number | undefined,
  diagnostics: CampaignDiagnostic[]
): number[] | undefined {
  if (!hasKey(record, key)) return undefined;
  const value = record[key];
  if (!Array.isArray(value)) {
    diagnostics.push({ path: keyPath, message: "expected an array of positive integer weights" });
    return undefined;
  }
  const weights: number[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      diagnostics.push({
        path: `${keyPath}[${index}]`,
        message: "expected a positive safe integer weight"
      });
      continue;
    }
    weights.push(entry);
  }
  if (expectedLength !== undefined && weights.length !== expectedLength) {
    diagnostics.push({
      path: keyPath,
      message: "`weights` length must match `values` length"
    });
  }
  return weights;
}

function validateUniqueStrings(
  values: string[] | undefined,
  keyPath: string,
  diagnostics: CampaignDiagnostic[]
): void {
  if (!values) return;
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      diagnostics.push({
        path: `${keyPath}[${index}]`,
        message: `duplicate entry ${JSON.stringify(value)}`
      });
    }
    seen.add(value);
  }
}

function checkKnownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
  diagnostics: CampaignDiagnostic[]
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      diagnostics.push({
        path: prefix ? `${prefix}.${key}` : key,
        message: "unknown key"
      });
    }
  }
}

function resolveCampaignPath(raw: string, campaignDir: string): CampaignPathRef {
  const resolved = path.resolve(campaignDir, raw);
  const wasRelative = !path.isAbsolute(raw);
  return {
    input: raw,
    resolved,
    digestPath: wasRelative ? normalizePath(path.relative(campaignDir, resolved)) : normalizePath(resolved),
    wasRelative
  };
}

function resolveNestedPath(raw: string, base: CampaignPathRef): CampaignPathRef {
  const resolved = path.resolve(base.resolved, raw);
  const wasRelative = !path.isAbsolute(raw);
  let digestPath: string;
  if (wasRelative && base.wasRelative) {
    digestPath = normalizePath(path.posix.normalize(path.posix.join(base.digestPath, normalizePath(raw))));
  } else if (wasRelative) {
    digestPath = normalizePath(path.resolve(base.resolved, raw));
  } else {
    digestPath = normalizePath(resolved);
  }
  return { input: raw, resolved, digestPath, wasRelative };
}

function missingPathRef(baseDir: string): CampaignPathRef {
  return {
    input: "",
    resolved: baseDir,
    digestPath: "",
    wasRelative: true
  };
}

function normalizePath(value: string): string {
  const normalized = value.split(path.sep).join("/");
  return normalized === "" ? "." : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isU64Decimal(value: string): boolean {
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function distributionEmitsNonnegativeInteger(distribution: ParameterDistribution): boolean {
  if (distribution.distribution === "fixed") {
    return typeof distribution.value === "number" &&
      Number.isSafeInteger(distribution.value) &&
      distribution.value >= 0;
  }
  if (distribution.distribution === "discrete") {
    return distribution.values.every(
      (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
  }
  return (
    distribution.integer &&
    Number.isSafeInteger(distribution.min) &&
    Number.isSafeInteger(distribution.max) &&
    distribution.min >= 0
  );
}

function distributionEmitsNonnegativeNumber(distribution: ParameterDistribution): boolean {
  if (distribution.distribution === "fixed") {
    return typeof distribution.value === "number" && distribution.value >= 0;
  }
  if (distribution.distribution === "discrete") {
    return distribution.values.every((value) => typeof value === "number" && value >= 0);
  }
  return distribution.min >= 0;
}

function distributionEmitsNonemptyString(distribution: ParameterDistribution): boolean {
  if (distribution.distribution === "fixed") {
    return typeof distribution.value === "string" && distribution.value.length > 0;
  }
  if (distribution.distribution === "discrete") {
    return distribution.values.every((value) => typeof value === "string" && value.length > 0);
  }
  return false;
}

function distributionEmitsIntegerInRange(
  distribution: ParameterDistribution,
  min: number,
  max: number
): boolean {
  if (distribution.distribution === "fixed") {
    return typeof distribution.value === "number" &&
      Number.isSafeInteger(distribution.value) &&
      distribution.value >= min &&
      distribution.value <= max;
  }
  if (distribution.distribution === "discrete") {
    return distribution.values.every(
      (value) =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= min &&
        value <= max
    );
  }
  return (
    distribution.integer &&
    Number.isSafeInteger(distribution.min) &&
    Number.isSafeInteger(distribution.max) &&
    distribution.min >= min &&
    distribution.max <= max
  );
}

function withOptionalUnit<T extends ParameterDistribution>(
  value: T,
  unit: string | undefined
): T {
  if (unit === undefined) return value;
  return { ...value, unit };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
