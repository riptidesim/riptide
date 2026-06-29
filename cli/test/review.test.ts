import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalRetainedCaseDigestPayload } from "../src/campaign/aggregation.js";
import { canonicalJson, sha256Hex, type JsonValue } from "../src/state-pack/json.js";
import { runReview } from "../src/commands/review.js";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

test("review accepts a campaign root and maps retained cases to risk and rerun evidence", async () => {
  const campaignRoot = await buildCampaignReviewRoot();

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", campaignRoot, "--quiet"],
    { cwd: campaignRoot }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /# Campaign Review: campaign-review-fixture/);
  assert.match(stdout, /## Executive Summary/);
  assert.match(stdout, /## Risk Map/);
  assert.match(stdout, /## Invariant Explanation/);
  assert.match(stdout, /## Scenario Parameters/);
  assert.match(stdout, /## Relevant Events/);
  assert.match(stdout, /## Rerun Command/);
  assert.match(stdout, /## Technical Appendix/);
  assert.match(stdout, /no invariant failures observed, no setup errors/);
  assert.match(stdout, /worst_bad_debt/);
  assert.match(stdout, /bad_debt=2500/);
  assert.match(stdout, /warn_signals=collection_worst_health_factor/);
  assert.doesNotMatch(stdout, /invariants=collection_worst_health_factor/);
  assert.match(stdout, /rerun\.sh is present and sh -n parseable/);

  const otherCwd = await mkdtemp(path.join(os.tmpdir(), "riptide-review-other-cwd-"));
  const { stdout: otherStdout, stderr: otherStderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", campaignRoot, "--quiet"],
    { cwd: otherCwd }
  );

  assert.equal(otherStderr, "");
  assert.match(otherStdout, /# Campaign Review: campaign-review-fixture/);
  assert.match(otherStdout, /bad_debt=2500/);

  let colored = "";
  const colorExit = await runReview(campaignRoot, { quiet: true }, {
    cwd: campaignRoot,
    color: true,
    stdoutWrite: (chunk) => {
      colored += chunk;
    },
    stderrWrite: () => {}
  });
  assert.equal(colorExit, 0);
  assert.match(colored, /\x1b\[1m\x1b\[36m# Campaign Review: campaign-review-fixture\x1b\[0m\x1b\[0m/);
  assert.match(colored, /- \x1b\[32mpass\x1b\[0m: campaign-summary\.json exists and parses/);
  assert.match(colored, /\x1b\[36m`run_[A-Za-z0-9_]+`\x1b\[0m/);
});

test("review accepts guided sim artifacts with flow labels and rerun evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-review-guided-sim-"));
  const artifactDir = path.join(root, ".riptide", "sim", "artifacts", "run-001");
  await mkdir(artifactDir, { recursive: true });
  const retainedSeed = "aa".repeat(32);
  await writeFile(
    path.join(artifactDir, "guided-sim-run.json"),
    JSON.stringify(
      {
        schema_version: 1,
        status: "failed",
        iterations_requested: 2,
        flows_per_iteration: 2,
        base_seed: "de".repeat(32),
        retained_failing_seed: retainedSeed,
        totals: {
          iterations: 1,
          flows: 2,
          tx_success: 1,
          expected_errors: 0,
          unexpected_errors: 1,
          compute_units: 99,
          service_ticks: 2,
          errors: 1,
          panics: 0
        },
        iterations: [
          {
            iteration: 0,
            seed: retainedSeed,
            status: "failed",
            dispatched_flows: 2,
            flow_counts: {
              mutate_external_dependency: 1,
              borrow_against_dependency: 1
            },
            tx_outcomes: [
              {
                label: "external_dependency_tick",
                ok: false,
                expected_error: false,
                signature: "1111111111111111111111111111111111111111111111111111111111111111",
                error: "custom program error: 0x2a",
                logs: ["Program log: dependency stale"],
                compute_units_consumed: 99
              }
            ],
            service_ticks: 2,
            regression: {
              enabled: true,
              account_hashes: {
                "11111111111111111111111111111111": "0".repeat(64)
              },
              expected_state_hashes: []
            },
            error: "external dependency drift crossed invariant",
            panic: false
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(artifactDir, "rerun.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "riptide sim run .riptide/sim --iterations 2 --flows 2 --seed dededede --out .riptide/sim/artifacts/run-001",
      ""
    ].join("\n"),
    "utf8"
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", artifactDir, "--quiet"],
    { cwd: root }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /# Guided Simulation Review: run-001/);
  assert.match(stdout, new RegExp(`Retained failing seed: \`${retainedSeed}\``));
  assert.match(stdout, /mutate_external_dependency/);
  assert.match(stdout, /external_dependency_tick/);
  assert.match(stdout, /external dependency drift crossed invariant/);
  assert.match(stdout, /Rerun command: `riptide sim run \.riptide\/sim/);
  assert.match(stdout, /rerun\.sh is present and sh -n parseable/);
  assert.match(stdout, /does not claim adapter campaign coverage/);

  const { stdout: jsonStdout } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "review", artifactDir, "--json"],
    { cwd: root }
  );
  const payload = JSON.parse(jsonStdout) as Record<string, unknown>;
  assert.equal(payload.schema_version, "guided-sim-review.v1");
  assert.equal(payload.retained_failing_seed, retainedSeed);
  assert.equal((payload.flow_counts as Record<string, unknown>).mutate_external_dependency, 1);
  assert.equal((payload.trace_summary as Record<string, unknown>).available, false);
});

test("review summarizes trace-bearing passed guided sim artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-review-guided-trace-pass-"));
  const artifactDir = path.join(root, ".riptide", "sim", "artifacts", "run-001");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "guided-sim-run.json"),
    JSON.stringify(
      {
        schema_version: 1,
        trace_schema_version: 1,
        status: "passed",
        iterations_requested: 1,
        flows_per_iteration: 2,
        base_seed: "ab".repeat(32),
        retained_failing_seed: null,
        totals: {
          iterations: 1,
          flows: 2,
          tx_success: 2,
          expected_errors: 0,
          unexpected_errors: 0,
          compute_units: 12,
          service_ticks: 2,
          errors: 0,
          panics: 0
        },
        iterations: [
          {
            iteration: 0,
            seed: "ab".repeat(32),
            status: "passed",
            dispatched_flows: 2,
            flow_counts: {
              guided_flow: 1,
              settle: 1
            },
            flow_trace: [
              {
                step_index: 0,
                flow_index: 0,
                flow_name: "guided_flow",
                tx_log_start: 0,
                tx_log_end: 1,
                service_ticks_before: 0,
                service_ticks_after: 1,
                status: "passed",
                expected_errors: 0,
                unexpected_errors: 0,
                failure_message: null
              },
              {
                step_index: 1,
                flow_index: 1,
                flow_name: "settle",
                tx_log_start: 1,
                tx_log_end: 2,
                service_ticks_before: 1,
                service_ticks_after: 2,
                status: "passed",
                expected_errors: 0,
                unexpected_errors: 0,
                failure_message: null
              }
            ],
            first_failing_flow_step: null,
            first_failure: null,
            tx_outcomes: [
              {
                label: "guided_flow_tx",
                ok: true,
                expected_error: false,
                signature: "1".repeat(64),
                error: null,
                logs: [],
                compute_units_consumed: 5
              },
              {
                label: "settle_tx",
                ok: true,
                expected_error: false,
                signature: "2".repeat(64),
                error: null,
                logs: [],
                compute_units_consumed: 7
              }
            ],
            service_ticks: 2,
            regression: {
              enabled: false,
              account_hashes: {},
              expected_state_hashes: []
            },
            error: null,
            panic: false
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(artifactDir, "rerun.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "riptide sim run .riptide/sim --iterations 1 --flows 2 --seed abababab --out .riptide/sim/artifacts/run-001",
      ""
    ].join("\n"),
    "utf8"
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", artifactDir, "--quiet"],
    { cwd: root }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /## Flow Trace/);
  assert.match(stdout, /Trace schema: 1/);
  assert.match(stdout, /guided_flow -> settle/);
  assert.match(stdout, /First failing flow step: none/);
  assert.match(stdout, /First failure stage: none/);
  assert.match(stdout, /pass: trace_schema_version 1 with 2 flow steps/);

  const { stdout: jsonStdout } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "review", artifactDir, "--json"],
    { cwd: root }
  );
  const payload = JSON.parse(jsonStdout) as Record<string, unknown>;
  const traceSummary = payload.trace_summary as Record<string, unknown>;
  assert.equal(traceSummary.available, true);
  assert.equal(traceSummary.schema_version, 1);
  assert.equal(payload.first_failing_flow_step, null);
  const iterations = traceSummary.iterations as Array<Record<string, unknown>>;
  assert.equal(iterations[0]!.steps, 2);
  assert.deepEqual(iterations[0]!.flow_sequence_preview, ["guided_flow", "settle"]);
});

test("review reports the first failing guided trace flow step", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-review-guided-trace-fail-"));
  const artifactDir = path.join(root, ".riptide", "sim", "artifacts", "run-002");
  await mkdir(artifactDir, { recursive: true });
  const failureStep = {
    step_index: 1,
    flow_index: 1,
    flow_name: "borrow_against_dependency",
    tx_log_start: 1,
    tx_log_end: 2,
    service_ticks_before: 1,
    service_ticks_after: 1,
    status: "returned_error",
    expected_errors: 0,
    unexpected_errors: 1,
    failure_message: "external dependency drift crossed invariant"
  };
  await writeFile(
    path.join(artifactDir, "guided-sim-run.json"),
    JSON.stringify(
      {
        schema_version: 1,
        trace_schema_version: 1,
        status: "failed",
        iterations_requested: 1,
        flows_per_iteration: 2,
        base_seed: "de".repeat(32),
        retained_failing_seed: "ef".repeat(32),
        totals: {
          iterations: 1,
          flows: 2,
          tx_success: 1,
          expected_errors: 0,
          unexpected_errors: 1,
          compute_units: 99,
          service_ticks: 1,
          errors: 1,
          panics: 0
        },
        iterations: [
          {
            iteration: 0,
            seed: "ef".repeat(32),
            status: "failed",
            dispatched_flows: 2,
            flow_counts: {
              mutate_external_dependency: 1,
              borrow_against_dependency: 1
            },
            flow_trace: [
              {
                step_index: 0,
                flow_index: 0,
                flow_name: "mutate_external_dependency",
                tx_log_start: 0,
                tx_log_end: 1,
                service_ticks_before: 0,
                service_ticks_after: 1,
                status: "passed",
                expected_errors: 0,
                unexpected_errors: 0,
                failure_message: null
              },
              failureStep
            ],
            first_failing_flow_step: failureStep,
            first_failure: {
              stage: "flow",
              status: "returned_error",
              step_index: 1,
              flow_index: 1,
              flow_name: "borrow_against_dependency",
              tx_log_start: 1,
              tx_log_end: 2,
              service_ticks_before: 1,
              service_ticks_after: 1,
              failure_message: "external dependency drift crossed invariant"
            },
            tx_outcomes: [
              {
                label: "dependency_update",
                ok: true,
                expected_error: false,
                signature: "1".repeat(64),
                error: null,
                logs: [],
                compute_units_consumed: 9
              },
              {
                label: "external_dependency_tick",
                ok: false,
                expected_error: false,
                signature: "2".repeat(64),
                error: "custom program error: 0x2a",
                logs: ["Program log: dependency stale"],
                compute_units_consumed: 90
              }
            ],
            service_ticks: 1,
            regression: {
              enabled: false,
              account_hashes: {},
              expected_state_hashes: []
            },
            error: "external dependency drift crossed invariant",
            panic: false
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(artifactDir, "rerun.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "riptide sim run .riptide/sim --iterations 1 --flows 2 --seed dededede --out .riptide/sim/artifacts/run-002",
      ""
    ].join("\n"),
    "utf8"
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", artifactDir, "--quiet"],
    { cwd: root }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /First failing flow step: iteration 0, step 1, flow borrow_against_dependency \(#1\), status returned_error/);
  assert.match(stdout, /First failure stage: iteration 0, stage flow, status returned_error, step 1, flow borrow_against_dependency \(#1\)/);
  assert.match(stdout, /external dependency drift crossed invariant/);

  const { stdout: jsonStdout } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "review", artifactDir, "--json"],
    { cwd: root }
  );
  const payload = JSON.parse(jsonStdout) as Record<string, unknown>;
  assert.equal((payload.first_failing_flow_step as Record<string, unknown>).flow_name, "borrow_against_dependency");
  assert.equal((payload.first_failure as Record<string, unknown>).stage, "flow");
});

test("review rejects malformed guided trace fields with an actionable error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-review-guided-trace-malformed-"));
  const artifactDir = path.join(root, ".riptide", "sim", "artifacts", "run-003");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "guided-sim-run.json"),
    JSON.stringify(
      {
        schema_version: 1,
        trace_schema_version: 1,
        status: "passed",
        iterations_requested: 1,
        flows_per_iteration: 1,
        base_seed: "aa".repeat(32),
        retained_failing_seed: null,
        totals: {
          iterations: 1,
          flows: 1,
          tx_success: 0,
          expected_errors: 0,
          unexpected_errors: 0,
          compute_units: 0,
          service_ticks: 0,
          errors: 0,
          panics: 0
        },
        iterations: [
          {
            iteration: 0,
            status: "passed",
            flow_counts: {},
            flow_trace: {
              step_index: 0
            },
            tx_outcomes: [],
            service_ticks: 0,
            regression: {
              enabled: false,
              account_hashes: {},
              expected_state_hashes: []
            },
            error: null,
            panic: false
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(artifactDir, "rerun.sh"),
    ["#!/bin/sh", "set -eu", "riptide sim run .riptide/sim --out .riptide/sim/artifacts/run-003", ""].join("\n"),
    "utf8"
  );

  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [cliEntrypoint, "review", artifactDir, "--quiet"], {
        cwd: root
      }),
    (err: unknown) => {
      const error = err as { code?: number; stderr?: string };
      assert.equal(error.code, 2);
      assert.match(error.stderr ?? "", /malformed guided-sim trace metadata/);
      assert.match(error.stderr ?? "", /field: iterations\[0\]\.flow_trace/);
      assert.match(error.stderr ?? "", /regenerate guided-sim-run\.json with the current riptide sim run/);
      return true;
    }
  );
});

test("review rejects paths that are not a recognized review root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-review-unrecognized-"));

  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [cliEntrypoint, "review", root, "--quiet"], {
        cwd: root
      }),
    (err: unknown) => {
      const error = err as { code?: number; stderr?: string };
      assert.equal(error.code, 2);
      assert.match(error.stderr ?? "", /not a recognized Riptide review root/);
      assert.match(error.stderr ?? "", /campaign root, retained case directory, or guided-sim artifact/);
      return true;
    }
  );
});

async function buildCampaignReviewRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-review-campaign-"));
  const retainedDir = path.join(root, "retained", "worst_bad_debt");
  await mkdir(retainedDir, { recursive: true });

  const riskSignals: JsonValue = {
    total_bad_debt: 2500,
    total_liquidations: 3,
    max_utilization: 7.5,
    invariant_names: [],
    semantic_signal_names: ["collection_worst_health_factor"]
  };
  const casePaths: JsonValue = {
    case_manifest: "retained/worst_bad_debt/case.json",
    rerun_sh: "retained/worst_bad_debt/rerun.sh",
    report: "runs/run_000001_abcdef/report.md",
    simulation_result: "runs/run_000001_abcdef/simulation-result.json"
  };
  const rerunCommand = "riptide run runs/run_000001_abcdef/run-config.json";

  // Build the retained case manifest exactly as runCampaignReview reads it, then
  // pin a case_digest computed over the same canonical payload the reviewer verifies.
  const caseRecord: Record<string, JsonValue> = {
    schema_version: "campaign-retained-case.v1",
    label: "worst_bad_debt",
    run_id: "run_000001_abcdef",
    campaign_id: "campaign_test",
    campaign_digest: "deadbeef",
    reason: "highest observed bad debt across completed runs",
    sampled_parameters: { shock_profile: "price-shock" },
    risk_signals: riskSignals,
    paths: casePaths
  };
  const caseDigest = sha256Hex(
    `riptide-campaign-retained-case-v1\n${canonicalJson(canonicalRetainedCaseDigestPayload(caseRecord))}`
  );
  const caseJson = { ...caseRecord, case_digest: caseDigest, rerun_command: rerunCommand };
  await writeFile(
    path.join(retainedDir, "case.json"),
    JSON.stringify(caseJson, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(retainedDir, "rerun.sh"),
    ["#!/bin/sh", "set -eu", rerunCommand, ""].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(root, "campaign-summary.json"),
    JSON.stringify(
      {
        campaign: {
          name: "campaign-review-fixture",
          campaign_id: "campaign_test",
          campaign_digest: "deadbeef",
          risk_objective: "liquidation-safety",
          run_budget: 3
        },
        totals: {
          completed_runs: 3,
          requested_runs: 3,
          invariant_failed_runs: 0,
          setup_errors: 0
        },
        parameters: {}
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(root, "retention-manifest.json"),
    JSON.stringify(
      {
        warnings: [],
        entries: [
          {
            label: "worst_bad_debt",
            status: "selected",
            run_id: "run_000001_abcdef",
            sampled_parameters: { shock_profile: "price-shock" },
            risk_signals: riskSignals,
            rerun_command: rerunCommand,
            paths: casePaths
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return root;
}
