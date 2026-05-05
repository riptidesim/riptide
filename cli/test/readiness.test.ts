import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runReadiness } from "../src/commands/readiness.js";
import {
  READINESS_INSPECTION_SCHEMA_VERSION,
  createReadinessReport,
  inspectAndAnalyzeReadiness,
  type AnalyzeReadinessGapsOptions,
  type InspectAndAnalyzeReadinessResult,
  type ReadinessArtifact,
  type ReadinessInspection,
} from "../src/readiness/index.js";

test("readiness case-studies emits deterministic corpus rows with required schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-readiness-corpus-"));
  await mkdir(path.join(root, "zeta", ".riptide"), { recursive: true });
  await mkdir(path.join(root, "alpha", ".riptide"), { recursive: true });
  await mkdir(path.join(root, "no-workspace"), { recursive: true });

  let stdout = "";
  let stderr = "";
  const code = await runReadiness(
    undefined,
    { caseStudies: root, json: true },
    {
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      stderrWrite: (chunk) => {
        stderr += chunk;
      },
      inspectAndAnalyzeImpl: fakeInspectAndAnalyze,
    }
  );

  assert.equal(code, 0);
  assert.equal(stderr, "");

  const parsed = JSON.parse(stdout) as {
    schema_version: string;
    generated_at: string;
    case_studies_root: string;
    rows: Array<{
      slug: string;
      path: string;
      observed_surfaces: {
        adapters: string[];
        scenarios: string[];
        guided_sim_manifests: string[];
        campaigns: string[];
        run_collections: string[];
        last_run: string | null;
      };
      command_results: Array<{
        gate: string;
        executed: boolean;
        verdict: string;
        exit_code: number | null;
        artifacts: string[];
        blocker: string | null;
        next_action: string;
      }>;
      verdict: string;
      claim_level: string;
      artifacts: string[];
      blocker: string | null;
      next_action: string;
    }>;
  };

  assert.equal(parsed.schema_version, "case-study-readiness.v1");
  assert.equal(parsed.generated_at, "1970-01-01T00:00:00.000Z");
  assert.equal(parsed.case_studies_root, root);
  assert.deepEqual(
    parsed.rows.map((row) => row.slug),
    ["alpha", "zeta"]
  );

  const alpha = parsed.rows[0]!;
  assert.equal(alpha.path, path.join(root, "alpha"));
  assert.deepEqual(alpha.observed_surfaces.adapters, [".riptide/adapters/alpha.toml"]);
  assert.deepEqual(alpha.observed_surfaces.scenarios, [
    ".riptide/scenarios/baseline/run-config.json",
  ]);
  assert.deepEqual(alpha.observed_surfaces.guided_sim_manifests, [
    ".riptide/sim/Riptide.toml",
  ]);
  assert.deepEqual(alpha.observed_surfaces.campaigns, [
    ".riptide/campaigns/alpha.campaign.toml",
  ]);
  assert.deepEqual(alpha.observed_surfaces.run_collections, [
    ".riptide/run-collection.json",
  ]);
  assert.equal(alpha.observed_surfaces.last_run, ".riptide/last-run.json");
  assert.equal(alpha.verdict, "pass");
  assert.equal(alpha.claim_level, "readiness-only");
  assert.equal(alpha.blocker, null);
  assert.equal(alpha.next_action, "Record alpha readiness evidence.");
  assert.ok(alpha.artifacts.includes(".riptide/run-collection.json"));

  const gates = alpha.command_results.map((entry) => entry.gate);
  assert.deepEqual(gates, [
    "inventory-only",
    "static-health",
    "adapter-lint",
    "direct-baseline-run",
    "guided-sim-run-review",
    "campaign-validate-plan-run",
    "fresh-clone-eligibility",
  ]);
  assert.equal(alpha.command_results[0]?.executed, true);
  assert.equal(alpha.command_results[0]?.verdict, "pass");
  assert.equal(alpha.command_results[1]?.executed, true);
  assert.equal(alpha.command_results[1]?.exit_code, 0);
  assert.equal(alpha.command_results[2]?.executed, false);
  assert.equal(alpha.command_results[2]?.verdict, "skipped");
});

test("readiness case-studies writes deterministic markdown and JSON outputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-readiness-out-"));
  const out = await mkdtemp(path.join(os.tmpdir(), "riptide-readiness-report-"));
  await mkdir(path.join(root, "bravo", ".riptide"), { recursive: true });

  let stdout = "";
  const code = await runReadiness(
    undefined,
    { caseStudies: root, json: true, out },
    {
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      inspectAndAnalyzeImpl: fakeInspectAndAnalyze,
    }
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(stdout) as {
    rows: Array<{ slug: string; command_results: Array<{ gate: string }> }>;
  };
  const jsonOut = JSON.parse(await readFile(path.join(out, "readiness.json"), "utf8")) as {
    rows: Array<{ slug: string }>;
  };
  const markdownOut = await readFile(path.join(out, "readiness.md"), "utf8");

  assert.deepEqual(parsed.rows.map((row) => row.slug), ["bravo"]);
  assert.deepEqual(jsonOut.rows.map((row) => row.slug), ["bravo"]);
  assert.match(markdownOut, /# Riptide Case-Study Corpus Readiness/);
  assert.match(markdownOut, /Gate Contract/);
  assert.deepEqual(parsed.rows[0]?.command_results.map((entry) => entry.gate), [
    "inventory-only",
    "static-health",
    "adapter-lint",
    "direct-baseline-run",
    "guided-sim-run-review",
    "campaign-validate-plan-run",
    "fresh-clone-eligibility",
  ]);
});

test("readiness case-studies does not include target build artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-readiness-no-target-"));
  const repo = path.join(root, "alpha");
  await mkdir(path.join(repo, ".riptide", "adapters"), { recursive: true });
  await mkdir(path.join(repo, "target", "idl"), { recursive: true });
  await mkdir(path.join(repo, "target", "deploy"), { recursive: true });
  await writeFile(path.join(repo, "Anchor.toml"), "[programs.localnet]\n", "utf8");
  await writeFile(
    path.join(repo, ".riptide", "adapters", "alpha.toml"),
    [
      'program_so = "target/deploy/missing.so"',
      'idl_path = "target/idl/missing.json"',
      "",
      "[instructions]",
      "",
      "[state_mapping]",
      "",
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(repo, "target", "idl", "alpha.json"), "{}\n", "utf8");
  await writeFile(path.join(repo, "target", "deploy", "alpha.so"), "", "utf8");

  let stdout = "";
  const code = await runReadiness(
    undefined,
    { caseStudies: root, json: true },
    {
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      inspectAndAnalyzeImpl: inspectAndAnalyzeReadiness,
    }
  );

  assert.equal(code, 0);
  const parsed = JSON.parse(stdout) as {
    rows: Array<{
      slug: string;
      command_results: Array<{ artifacts: string[] }>;
    }>;
  };
  assert.deepEqual(parsed.rows.map((row) => row.slug), ["alpha"]);
  assert.doesNotMatch(stdout, /target\/idl\/alpha\.json/);
  assert.doesNotMatch(stdout, /target\/deploy\/alpha\.so/);
  assert.doesNotMatch(stdout, /target\/idl\/missing\.json/);
  assert.doesNotMatch(stdout, /target\/deploy\/missing\.so/);
});

async function fakeInspectAndAnalyze(
  inputPath: string,
  options: AnalyzeReadinessGapsOptions = {}
): Promise<InspectAndAnalyzeReadinessResult> {
  const slug = path.basename(inputPath);
  const inspection = fakeInspection(inputPath, slug);
  const report = createReadinessReport({
    repo: {
      candidate: options.candidate ?? slug,
      path: inputPath,
    },
    evidenceSnapshot: {
      candidate_record: true,
      local_repo: true,
      build_or_program_artifacts: true,
      riptide_workspace: true,
    },
    nextActions: [
      {
        layer: "documentation",
        action: `Record ${slug} readiness evidence.`,
      },
    ],
  });
  return { inspection, report };
}

function fakeInspection(rootPath: string, slug: string): ReadinessInspection {
  return {
    schemaVersion: READINESS_INSPECTION_SCHEMA_VERSION,
    inputPath: rootPath,
    rootPath,
    repo: {
      path: rootPath,
      exists: true,
      isDirectory: true,
      isGitRepo: false,
      stackMarkers: ["riptide-workspace"],
    },
    build: {
      cargoWorkspace: false,
      programSources: [artifact("program-source", "programs/demo/src/lib.rs", rootPath)],
      idls: [],
      programBinaries: [],
      tests: [],
      migrations: [],
      programIds: [],
    },
    riptide: {
      present: true,
      path: path.join(rootPath, ".riptide"),
      adapters: [
        {
          ...artifact("adapter", `.riptide/adapters/${slug}.toml`, rootPath),
          name: slug,
          validationStatus: "valid",
          lineage: { inferredAssumptionCount: 0, unsupportedFieldCount: 0 },
          instructions: [],
          actions: [],
          accounts: [],
          observations: [],
          invariants: [],
          semanticClassSupported: false,
          semanticRoles: [],
          derivedObservations: [],
          expressionInvariants: [],
          collections: [],
          errorRegistry: { present: false, count: 0 },
        },
      ],
      scenarios: [
        artifact("scenario", ".riptide/scenarios/baseline/run-config.json", rootPath),
      ],
      harnesses: [],
      slices: [],
      runCollections: [
        {
          ...artifact("run-collection", ".riptide/run-collection.json", rootPath),
          readable: true,
          totalScenarios: 1,
          statuses: ["pass"],
          verdicts: [],
          confidences: [],
          coverages: [],
          totalsByStatus: { pass: 1 },
          totalsByVerdict: {},
          totalsByCoverage: {},
          scenarios: [],
          evidencePaths: [],
          hasArtifactReadability: true,
          hasStateMovement: true,
          hasSemanticsEvaluated: false,
        },
      ],
      lastRun: {
        path: path.join(rootPath, ".riptide", "last-run.json"),
        relativePath: ".riptide/last-run.json",
        readable: true,
        totalScenarios: 1,
        statuses: ["pass"],
      },
      reports: [],
      packs: [],
      manifests: [],
      guidedSimManifests: [artifact("guided-sim-manifest", ".riptide/sim/Riptide.toml", rootPath)],
      replays: [],
      runs: [],
      campaignInputs: [
        artifact("campaign-input", `.riptide/campaigns/${slug}.campaign.toml`, rootPath),
      ],
    },
    warnings: [],
  };
}

function artifact(
  kind: ReadinessArtifact["kind"],
  relativePath: string,
  rootPath: string
): ReadinessArtifact {
  return {
    kind,
    path: path.join(rootPath, relativePath),
    relativePath,
  };
}
