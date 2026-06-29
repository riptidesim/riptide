import type { ExecutionHonestyReport } from "../sim/honesty-gates.js";
import type { JsonValue } from "../state-pack/json.js";

import type { JsonScalar, RetentionLabel } from "./schema.js";

export interface CampaignSummaryJson {
  schema_version: "campaign-summary.v1";
  campaign: {
    campaign_id: string;
    campaign_digest: string;
    name: string;
    class: string;
    risk_objective: string;
    run_budget: number;
    requested_runs: number;
    seed_policy: string;
    replay_retention: RetentionLabel[];
    adapter: string;
    output_dir: string;
  };
  artifacts: {
    runs_jsonl: string;
    parameters_csv: string;
    retention_manifest: string;
    markdown_summary: string;
    risk_surface: string;
  };
  totals: {
    requested_runs: number;
    completed_runs: number;
    passed_runs: number;
    invariant_failed_runs: number;
    setup_errors: number;
    skipped_runs: number;
    invariant_failure_rate: number;
  };
  first_failure_ticks: {
    count: number;
    min: number | null;
    median: number | null;
    max: number | null;
    distribution: Record<string, number>;
  };
  scenario_families: Record<string, CampaignScenarioFamilySummary>;
  parameters: Record<string, CampaignParameterSummary>;
  lending: CampaignLendingSummary | null;
  retention: {
    selected: CampaignRetentionSelection[];
    warnings: string[];
  };
  warnings: string[];
  claim_boundary: string;
  /**
   * Additive, optional: the distinct protocol flows a guided-sim sweep
   * exercised (e.g. `open_swap`, `liquidate_position`). Set only by the
   * guided-sim → cartography producer; absent for real `riptide campaign run`
   * summaries, so it never affects existing campaign artifacts. Surfaced in the
   * assessment scope so the report names the real flows under test.
   */
  guided_sim_flows?: string[];
  /**
   * Additive, optional: the execution-honesty gate report for a guided-sim
   * sweep (positive control / lifecycle-executed / determinism). Set only by the
   * guided-sim → cartography producer; absent for real `riptide campaign run`
   * summaries, so it never affects existing campaign artifacts. `riptide assess`
   * re-verifies it and blocks emit on a failed gate (guided-sim only).
   */
  execution_honesty?: ExecutionHonestyReport;
}

export interface CampaignScenarioFamilySummary {
  planned_runs: number;
  completed_runs: number;
  passed_runs: number;
  invariant_failed_runs: number;
  setup_errors: number;
  skipped_runs: number;
  first_failure_tick_min: number | null;
  total_bad_debt_max: number | null;
  max_utilization_observed: number | null;
  min_tvl_observed: number | null;
}

export interface CampaignParameterSummary {
  distribution: string;
  unit?: string;
  sampled_count: number;
  min: number | null;
  median: number | null;
  max: number | null;
  values: JsonScalar[];
}

export interface CampaignLendingSummary {
  observations_used: string[];
  completed_runs_with_metrics: number;
  total_bad_debt: {
    min: number | null;
    median: number | null;
    max: number | null;
  };
  total_liquidations: {
    min: number | null;
    median: number | null;
    max: number | null;
  };
  liquidity_stress: {
    min_tvl_observed: number | null;
    max_utilization_observed: number | null;
    min_available_liquidity_observed: number | null;
  };
  liquidation_safety_failures: {
    failed_runs: number;
    invariant_names: string[];
  };
}

export interface CampaignRetentionManifest {
  schema_version: "campaign-retention-manifest.v1";
  campaign_id: string;
  campaign_digest: string;
  campaign_name: string;
  class: string;
  risk_objective: string;
  requested_labels: RetentionLabel[];
  artifacts: {
    risk_surface: string;
  };
  entries: CampaignRetentionEntry[];
  warnings: string[];
}

export type CampaignRetentionEntry =
  | CampaignRetentionSelection
  | CampaignRetentionWarning;

export interface CampaignRetentionSelection {
  label: RetentionLabel;
  status: "selected";
  run_id: string;
  run_index: number;
  scenario_family: string;
  sampled_parameters: Record<string, JsonScalar>;
  reason: string;
  score: number | null;
  tie_breaker: string | null;
  risk_signals: CampaignRetentionRiskSignals;
  rerun_command: string;
  case_digest?: string;
  paths: {
    run_dir: string;
    run_config: string;
    metadata: string;
    case_dir: string;
    case_manifest: string;
    rerun_sh: string;
    simulation_result?: string;
    report?: string;
  };
}

export interface CampaignRetentionRiskSignals {
  status: "pass" | "fail" | "error" | "skipped";
  first_failure_tick: number | null;
  invariant_names: string[];
  semantic_signal_names: string[];
  total_bad_debt: number | null;
  total_liquidations: number | null;
  max_utilization: number | null;
  min_tvl: number | null;
  min_available_liquidity: number | null;
  risk_score: number;
}

export function canonicalRetainedCaseDigestPayload(
  caseRecord: Record<string, JsonValue>
): Record<string, JsonValue> {
  const {
    case_digest: _caseDigest,
    rerun_command: _rerunCommand,
    review_command: _reviewCommand,
    ...canonical
  } = caseRecord;
  return canonical;
}

export interface CampaignRetentionWarning {
  label: RetentionLabel;
  status: "warning";
  warning: string;
}
