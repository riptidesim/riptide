import type { SemanticClass } from "../schemas/adapter.js";

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
