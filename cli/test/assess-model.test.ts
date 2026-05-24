import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  CampaignRetentionManifest,
  CampaignSummaryJson
} from "../src/campaign/aggregation.js";
import type { RiskSurfaceDocument } from "../src/campaign/surface.js";
import {
  AssessmentIngestError,
  ingestAssessment
} from "../src/assess/model.js";

const SURFACE_PATH = path.resolve(
  process.cwd(),
  "..",
  "fixtures",
  "campaigns",
  "lending",
  "whale-shock-cartography",
  "expected-risk-surface.json"
);

test("assess model ingestion reads a structurally valid campaign root", async () => {
  const { root } = await writeCampaignRoot();

  const model = await ingestAssessment({ campaignRoot: root });

  assert.equal(model.schema_version, "assessment.v1");
  assert.equal(model.verdict.value, "needs_campaign_tuning");
  assert.equal(model.surface_highlights.most_sensitive_axis, "whale_share_bps");
  assert.equal(model.reproduction.hashes.surface_sha256, "11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f");
});

test("assess model ingestion rejects malformed risk surfaces with AssessmentIngestError", async () => {
  const { root, surface } = await writeCampaignRoot({
    surfaceOverride: (valid) => {
      const { cells: _cells, ...withoutCells } = valid;
      return withoutCells;
    }
  });

  await assert.rejects(
    () => ingestAssessment({ campaignRoot: root }),
    (err) => {
      assert.ok(err instanceof AssessmentIngestError);
      assert.match(err.message, /risk-surface\.json is malformed: cells must be an array/);
      assert.match(err.hint ?? "", /Regenerate the campaign artifacts/);
      return true;
    }
  );
  assert.equal(surface.campaign.campaign_id, "campaign_40a5f239691a");
});

test("assess model ingestion rejects cross-artifact campaign digest mismatches", async () => {
  const { root } = await writeCampaignRoot({
    surfaceOverride: (valid) => ({
      ...valid,
      campaign: {
        ...valid.campaign,
        campaign_digest: "different-digest"
      }
    })
  });

  await assert.rejects(
    () => ingestAssessment({ campaignRoot: root }),
    (err) => {
      assert.ok(err instanceof AssessmentIngestError);
      assert.match(err.message, /risk-surface\.json campaign\.campaign_digest/);
      assert.match(err.message, /does not match campaign-summary\.json campaign\.campaign_digest/);
      assert.match(err.hint ?? "", /same campaign root/);
      return true;
    }
  );
});

test("assess model ingestion rejects risk surfaces whose embedded digest does not verify", async () => {
  const { root } = await writeCampaignRoot({
    surfaceOverride: (valid) => ({
      ...valid,
      warnings: ["tampered after surface_digest was computed"]
    })
  });

  await assert.rejects(
    () => ingestAssessment({ campaignRoot: root }),
    (err) => {
      assert.ok(err instanceof AssessmentIngestError);
      assert.match(err.message, /surface_digest/);
      assert.match(err.message, /does not match the document contents/);
      return true;
    }
  );
});

async function writeCampaignRoot(options: {
  surfaceOverride?: (surface: RiskSurfaceDocument) => unknown;
} = {}): Promise<{ root: string; surface: RiskSurfaceDocument }> {
  const surfaceRaw = await readFile(SURFACE_PATH, "utf8");
  const surface = JSON.parse(surfaceRaw) as RiskSurfaceDocument;
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-assess-model-"));
  await writeFile(path.join(root, "campaign-summary.json"), JSON.stringify(summaryFor(surface), null, 2) + "\n", "utf8");
  await writeFile(
    path.join(root, "risk-surface.json"),
    options.surfaceOverride ? JSON.stringify(options.surfaceOverride(surface), null, 2) + "\n" : surfaceRaw,
    "utf8"
  );
  await writeFile(path.join(root, "retention-manifest.json"), JSON.stringify(manifestFor(surface), null, 2) + "\n", "utf8");
  return { root, surface };
}

function summaryFor(surface: RiskSurfaceDocument): CampaignSummaryJson {
  return {
    schema_version: "campaign-summary.v1",
    campaign: {
      campaign_id: surface.campaign.campaign_id,
      campaign_digest: surface.campaign.campaign_digest,
      name: surface.campaign.name,
      class: surface.campaign.class,
      risk_objective: surface.campaign.risk_objective,
      run_budget: surface.campaign.run_budget,
      requested_runs: surface.campaign.requested_runs,
      seed_policy: surface.campaign.seed_policy,
      replay_retention: [],
      adapter: "fixtures/adapters/lending-cartography.toml",
      output_dir: surface.campaign.campaign_id
    },
    artifacts: {
      runs_jsonl: "runs.jsonl",
      parameters_csv: "parameters.csv",
      retention_manifest: "retention-manifest.json",
      markdown_summary: "campaign-summary.md",
      risk_surface: "risk-surface.json"
    },
    totals: {
      requested_runs: 80,
      completed_runs: 80,
      passed_runs: 47,
      invariant_failed_runs: 33,
      setup_errors: 0,
      skipped_runs: 0,
      invariant_failure_rate: 0.4125
    },
    first_failure_ticks: { count: 0, min: null, median: null, max: null, distribution: {} },
    scenario_families: {
      "bank-run": emptyFamily(22),
      "price-shock": {
        planned_runs: 58,
        completed_runs: 58,
        passed_runs: 25,
        invariant_failed_runs: 33,
        setup_errors: 0,
        skipped_runs: 0,
        first_failure_tick_min: 1,
        total_bad_debt_max: 4320,
        max_utilization_observed: 19.2,
        min_tvl_observed: 1183
      }
    },
    parameters: {
      shock_profile: {
        distribution: "discrete(price-shock|bank-run)",
        sampled_count: 80,
        min: null,
        median: null,
        max: null,
        values: ["price-shock", "bank-run"]
      },
      whale_share_bps: {
        distribution: "uniform(500..3000, integer)",
        unit: "bps",
        sampled_count: 80,
        min: 500,
        median: 1750,
        max: 3000,
        values: [500, 1125, 1750, 2375, 3000]
      }
    },
    lending: {
      observations_used: ["bad_debt", "utilization", "tvl"],
      completed_runs_with_metrics: 80,
      total_bad_debt: { min: 0, median: 1440, max: 4320 },
      total_liquidations: { min: 0, median: 0, max: 0 },
      liquidity_stress: {
        min_tvl_observed: 1183,
        max_utilization_observed: 19.2,
        min_available_liquidity_observed: null
      },
      liquidation_safety_failures: {
        failed_runs: 33,
        invariant_names: ["bad_debt_threshold"]
      }
    },
    retention: { selected: [], warnings: [] },
    warnings: [],
    claim_boundary: "Simulation evidence over the declared, fixed-seed parameter region."
  };
}

function manifestFor(surface: RiskSurfaceDocument): CampaignRetentionManifest {
  return {
    schema_version: "campaign-retention-manifest.v1",
    campaign_id: surface.campaign.campaign_id,
    campaign_digest: surface.campaign.campaign_digest,
    campaign_name: surface.campaign.name,
    class: surface.campaign.class,
    risk_objective: surface.campaign.risk_objective,
    requested_labels: [],
    artifacts: { risk_surface: "risk-surface.json" },
    entries: [],
    warnings: []
  };
}

function emptyFamily(completedRuns: number): CampaignSummaryJson["scenario_families"][string] {
  return {
    planned_runs: completedRuns,
    completed_runs: completedRuns,
    passed_runs: completedRuns,
    invariant_failed_runs: 0,
    setup_errors: 0,
    skipped_runs: 0,
    first_failure_tick_min: null,
    total_bad_debt_max: 0,
    max_utilization_observed: 8.8,
    min_tvl_observed: 2000
  };
}
