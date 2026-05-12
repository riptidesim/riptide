import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  parseGjsPortalDirectoryPickerOutput,
  startStudioServer,
  type StudioServerHandle
} from "../src/studio/server.js";
import {
  discoverStudioWorkspaces,
  type StudioWorkspace
} from "../src/studio/workspaces.js";
import { registerProject } from "../src/studio/registry.js";
import {
  indexWorkspaceArtifacts,
  type StudioArtifactIndex
} from "../src/studio/artifacts.js";
import {
  isValidationError,
  StudioJobQueue,
  type JobLaunchInput,
  type JobPlanPreview,
  type JobValidationError
} from "../src/studio/jobs.js";
import { generateConfigIntent } from "../src/studio/config-intent.js";
import { ChatStore } from "../src/studio/chat/store.js";
import {
  createThreadChangesState,
  diffWorkspaceSnapshots,
  readWorkspaceStatusSnapshot
} from "../src/studio/workspace-changes.js";
import type { SimulationResult } from "../src/compiler/schema.js";

const execFile = promisify(execFileCb);

async function tmpRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-studio-${label}-`));
}

async function withServer<T>(
  options: Parameters<typeof startStudioServer>[0],
  fn: (handle: StudioServerHandle) => Promise<T>
): Promise<T> {
  const serverOptions = options ?? {};
  const registryPaths = serverOptions.registryPaths ?? { home: await tmpRoot("registry") };
  const handle = await startStudioServer({ port: 0, maxAttempts: 1, ...serverOptions, registryPaths });
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

function simulationResultFor(
  scenario: string,
  options: { invariantFires?: number; outputPath?: string } = {}
): SimulationResult {
  const invariantFires = options.invariantFires ?? 0;
  return {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario,
      seed: 7,
      personas: ["cautious-yield-farmer"],
      validator_url: "http://127.0.0.1:8899",
      output_path: options.outputPath ?? `.riptide/runs/${scenario}`
    },
    seed: 7,
    total_ticks: 4,
    timeseries: [
      { tick: 0, active_agents: 1, tvl: invariantFires > 0 ? 100 : 80 },
      { tick: 4, active_agents: invariantFires > 0 ? 0 : 1, tvl: invariantFires > 0 ? 0 : 100 }
    ],
    events:
      invariantFires > 0
        ? [
            {
              tick: 1,
              agent_id: "agent-001",
              persona_id: "cautious-yield-farmer",
              persona_label: "Cautious Yield Farmer",
              action: "invariant_violation:health",
              params: {},
              outcome: "failed",
              outcome_detail: "health invariant fired"
            }
          ]
        : [],
    agents: [
      {
        agent_id: "agent-001",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        status: invariantFires > 0 ? "liquidated" : "active",
        final_balance: invariantFires > 0 ? 0 : 125,
        pnl: invariantFires > 0 ? -100 : 25,
        total_actions: invariantFires > 0 ? 0 : 1,
        triggers_activated: invariantFires > 0 ? 1 : 0,
        liquidated_at_tick: invariantFires > 0 ? 1 : undefined
      }
    ],
    summary: {
      final_tvl: invariantFires > 0 ? 0 : 100,
      final_utilization: invariantFires > 0 ? 1 : 0,
      total_bad_debt: invariantFires > 0 ? 10 : 0,
      agents_active: invariantFires > 0 ? 0 : 1,
      agents_liquidated: invariantFires > 0 ? 1 : 0,
      agents_depleted: 0,
      invariants_fired: [
        {
          name: invariantFires > 0 ? "health" : "no_bad_debt",
          field: invariantFires > 0 ? "health_factor" : "bad_debt",
          op: invariantFires > 0 ? ">=" : "==",
          value: invariantFires > 0 ? 1 : 0,
          firings: invariantFires
        }
      ]
    },
    simulation_boundaries: ["studio test"]
  };
}

async function seedWorkspace(root: string): Promise<void> {
  const riptide = path.join(root, ".riptide");
  await mkdir(path.join(riptide, "runs", "alpha"), { recursive: true });
  await mkdir(path.join(riptide, "runs", "beta"), { recursive: true });
  await mkdir(path.join(riptide, "campaigns", "campaign_aaa"), { recursive: true });
  await mkdir(path.join(riptide, "campaigns", "campaign_aaa", "retained"), {
    recursive: true
  });
  await mkdir(path.join(riptide, "campaigns", "campaign_aaa", "retained", "case-001"), {
    recursive: true
  });
  await mkdir(path.join(riptide, "pack", "alpha"), { recursive: true });
  await mkdir(path.join(riptide, "sim", "artifacts", "run-001"), { recursive: true });
  await mkdir(path.join(riptide, "sims", "guided-one"), { recursive: true });
  await mkdir(path.join(riptide, "readiness"), { recursive: true });
  await mkdir(path.join(riptide, "scenarios", "alpha"), { recursive: true });
  await mkdir(path.join(riptide, "adapters"), { recursive: true });

  await writeFile(
    path.join(riptide, "run-collection.json"),
    JSON.stringify(
      {
        schema_version: 1,
        started_at: "2026-04-25T00:00:00.000Z",
        finished_at: "2026-04-25T00:00:01.000Z",
        allow_invariant_violations: false,
        total_scenarios: 2,
        totals_by_status: { pass: 1, fail: 1, error: 0, skipped: 0 },
        totals_by_verdict: {
          "failure-observed": 1,
          "no-failure-observed": 1,
          inconclusive: 0,
          "setup-error": 0,
          interrupted: 0
        },
        totals_by_coverage: { exercised: 2, partial: 0, unexercised: 0, unknown: 0 },
        scenarios: [
          {
            name: "alpha",
            status: "pass",
            interpretation: {
              verdict: "no-failure-observed",
              confidence: "low",
              coverage: "partial"
            }
          },
          {
            name: "beta",
            status: "fail",
            interpretation: {
              verdict: "failure-observed",
              confidence: "medium",
              coverage: "exercised"
            }
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "last-run.json"),
    JSON.stringify(
      {
        schema_version: 1,
        scenarios: [
          { name: "alpha", status: "pass" },
          { name: "beta", status: "fail" }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  // Passing scenario: no invariant fires.
  await writeFile(
    path.join(riptide, "runs", "alpha", "simulation-result.json"),
    JSON.stringify(simulationResultFor("alpha"), null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(riptide, "runs", "alpha", "report.md"), "# alpha\n", "utf8");

  // Failing scenario: invariant fires recorded as event.
  await writeFile(
    path.join(riptide, "runs", "beta", "simulation-result.json"),
    JSON.stringify(simulationResultFor("beta", { invariantFires: 1 }), null, 2) + "\n",
    "utf8"
  );
  // Intentionally omit report.md for beta to exercise the warning path.

  await writeFile(
    path.join(riptide, "campaigns", "campaign_aaa", "campaign-summary.json"),
    JSON.stringify(
      {
        total_runs: 5,
        retained_runs: 1,
        dominant_verdict: "failure-observed",
        canonical_hash: "deadbeef"
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "campaigns", "deposit-flow.campaign.toml"),
    "name = \"deposit-flow\"\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "pack", "alpha", "manifest.json"),
    JSON.stringify(
      {
        canonical_hash: "abc123",
        scenario: "alpha",
        outputs: {
          simulation_result: ".riptide/runs/alpha/simulation-result.json"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "sim", "Riptide.toml"),
    "[sim]\nbase_seed = \"deadbeef\"\n",
    "utf8"
  );
  await writeFile(
    path.join(riptide, "sim", "Cargo.toml"),
    "[package]\nname = \"guided\"\n",
    "utf8"
  );
  await writeFile(
    path.join(riptide, "sim", "artifacts", "run-001", "guided-sim-run.json"),
    JSON.stringify({ schema_version: 1, status: "passed", iterations: [] }, null, 2) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "sims", "guided-one", "manifest.json"),
    JSON.stringify({ scenario: "guided-one" }, null, 2) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "readiness", "report.md"),
    "# readiness\n",
    "utf8"
  );

  await mkdir(
    path.join(root, "reports", "case-study-readiness", "sprint-30-phase2", "corpus-static"),
    { recursive: true }
  );
  await writeFile(
    path.join(
      root,
      "reports",
      "case-study-readiness",
      "sprint-30-phase2",
      "corpus-static",
      "readiness.json"
    ),
    JSON.stringify({ schema_version: "case-study-readiness.v1", rows: [] }, null, 2) + "\n",
    "utf8"
  );

  await writeFile(path.join(riptide, "GETTING-STARTED.md"), "# getting started\n", "utf8");

  await writeFile(
    path.join(riptide, "scenarios", "alpha", "run-config.json"),
    JSON.stringify({ scenario: "alpha" }, null, 2) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "adapters", "lending.toml"),
    "protocol = \"generic\"\n[semantics]\nclass = \"lending.v1\"\n",
    "utf8"
  );
}

async function writeLegacyJob(
  file: string,
  input: { id: string; cwd: string; workspaceId?: string }
): Promise<void> {
  await writeFile(
    file,
    JSON.stringify(
      {
        id: input.id,
        kind: "readiness",
        status: "succeeded",
        created_at: "2026-05-09T00:00:00.000Z",
        updated_at: "2026-05-09T00:00:01.000Z",
        workspace_id: input.workspaceId ?? "current",
        cwd: input.cwd,
        argv: ["riptide", "readiness", ".", "--json", "--out", ".riptide/readiness"],
        output_path: ".riptide/readiness",
        expected_artifact: ".riptide/readiness/readiness.json",
        exit_code: 0,
        stdout_tail: "",
        stderr_tail: "",
        artifact_paths: [],
        warnings: []
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

test("studio workspace discovery returns the current workspace first", async () => {
  const root = await tmpRoot("workspaces-only-current");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  const workspaces = await discoverStudioWorkspaces({ cwd: root });
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]!.id, "current");
  assert.equal(workspaces[0]!.source, "current");
  assert.equal(workspaces[0]!.has_riptide, true);
  assert.deepEqual(workspaces[0]!.warnings, []);
});

test("studio workspace discovery flags missing .riptide with a next action", async () => {
  const root = await tmpRoot("workspaces-no-riptide");
  const workspaces = await discoverStudioWorkspaces({ cwd: root });
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]!.has_riptide, false);
  assert.equal(workspaces[0]!.warnings.length, 1);
  assert.match(workspaces[0]!.warnings[0]!.next_action, /riptide init/);
});

test("studio workspace discovery hides the uninitialized launch folder when a saved workspace exists", async () => {
  const root = await tmpRoot("workspaces-launch-shell");
  const external = await tmpRoot("workspaces-saved-external");
  const registryHome = await tmpRoot("workspaces-saved-registry");
  await mkdir(path.join(external, ".riptide"), { recursive: true });
  await registerProject({ label: "AMM", path: external }, { home: registryHome });

  const workspaces = await discoverStudioWorkspaces({
    cwd: root,
    registryPaths: { home: registryHome }
  });

  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]!.path, external);
  assert.equal(workspaces[0]!.source, "registered");
  assert.equal(workspaces[0]!.has_riptide, true);
});

test("studio workspace discovery surfaces case-study subfolders deterministically", async () => {
  const home = await tmpRoot("workspaces-current");
  const studies = await tmpRoot("workspaces-studies");
  await mkdir(path.join(home, ".riptide"), { recursive: true });
  await mkdir(path.join(studies, "lending", ".riptide"), { recursive: true });
  await mkdir(path.join(studies, "amm", ".riptide"), { recursive: true });
  await mkdir(path.join(studies, "no-riptide"), { recursive: true });
  await mkdir(path.join(studies, ".hidden", ".riptide"), { recursive: true });

  const workspaces = await discoverStudioWorkspaces({
    cwd: home,
    caseStudiesRoot: studies
  });

  assert.equal(workspaces.length, 4);
  assert.equal(workspaces[0]!.id, "current");
  assert.deepEqual(
    workspaces.slice(1).map((w: StudioWorkspace) => w.id),
    ["amm", "lending", "no-riptide"]
  );
  for (const ws of workspaces.slice(1, 3)) {
    assert.equal(ws.source, "case-study");
    assert.equal(ws.has_riptide, true);
  }
  assert.equal(workspaces[3]!.source, "case-study");
  assert.equal(workspaces[3]!.has_riptide, false);
  assert.equal(workspaces[3]!.warnings.length, 1);
});

test("studio artifact index is deterministic and surfaces every supported kind", async () => {
  const root = await tmpRoot("artifacts");
  await seedWorkspace(root);

  const index = await indexWorkspaceArtifacts({
    workspaceId: "current",
    workspacePath: root
  });

  assert.equal(index.has_riptide, true);
  assert.deepEqual(index.warnings, []);

  // Ordering is alphabetical by id; capture once and assert byte-stable.
  const ids = index.artifacts.map((a) => a.id);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "artifact ids must be sorted alphabetically");

  const kinds = new Set(index.artifacts.map((a) => a.kind));
  assert.ok(kinds.has("run-collection"));
  assert.ok(kinds.has("last-run"));
  assert.ok(kinds.has("run"));
  assert.ok(kinds.has("campaign-root"));
  assert.ok(kinds.has("retained-case"));
  assert.ok(kinds.has("campaign-input"));
  assert.ok(kinds.has("pack"));
  assert.ok(kinds.has("guided-sim"));
  assert.ok(kinds.has("readiness-report"));
  assert.ok(kinds.has("markdown-summary"));
  assert.ok(kinds.has("scenario"));
  assert.ok(kinds.has("adapter"));

  const beta = index.artifacts.find((a) => a.id === "run:beta");
  assert.ok(beta, "run:beta entry must exist");
  assert.equal(beta!.status, "fail");
  assert.equal(beta!.invariant_fire_count, 1);
  // Missing report.md becomes a warning with a runnable next action.
  assert.ok(beta!.warnings.some((w) => /report\.md missing/.test(w.message)));
  assert.ok(beta!.warnings.some((w) => /riptide run/.test(w.next_action)));

  const alpha = index.artifacts.find((a) => a.id === "run:alpha");
  assert.equal(alpha!.status, "pass");
  assert.equal(alpha!.invariant_fire_count, 0);

  const collection = index.artifacts.find((a) => a.id === "run-collection");
  assert.equal(collection!.kind, "run-collection");
  assert.equal(typeof collection!.verdict, "string");
  assert.equal(collection!.status, "fail");
  assert.equal(collection!.confidence, "low");
  assert.deepEqual(collection!.totals_by_verdict, {
    "failure-observed": 1,
    "no-failure-observed": 1,
    inconclusive: 0,
    "setup-error": 0,
    interrupted: 0
  });

  const adapter = index.artifacts.find((a) => a.id === "adapter:lending.toml");
  assert.equal(adapter!.meta?.protocol, "generic");
  assert.equal(adapter!.meta?.protocol_class, "lending.v1");

  const campaign = index.artifacts.find((a) => a.id === "campaign:campaign_aaa");
  assert.equal(campaign!.canonical_hash, "deadbeef");
  assert.equal(campaign!.verdict, "failure-observed");

  assert.equal(alpha!.verdict, "no-failure-observed");
  assert.equal(alpha!.coverage, "partial");
  assert.equal(alpha!.confidence, "low");

  const guidedCrate = index.artifacts.find((a) => a.id === "guided-sim:sim");
  assert.ok(guidedCrate, "singular .riptide/sim crate must be indexed");
  assert.equal(guidedCrate!.warnings.length, 0);
  assert.equal(guidedCrate!.meta?.has_riptide_toml, true);

  const guidedRun = index.artifacts.find(
    (a) => a.id === "guided-sim-run:.riptide/sim/artifacts/run-001"
  );
  assert.ok(guidedRun, "guided-sim-run.json artifact directory must be indexed");
  assert.equal(guidedRun!.status, "passed");

  assert.ok(
    index.artifacts.some(
      (a) =>
        a.id ===
        "readiness:reports/case-study-readiness/sprint-30-phase2/corpus-static/readiness.json"
    ),
    "Sprint 30 corpus readiness report must be indexed"
  );
});

test("studio indexer reports warnings for malformed run-collection.json", async () => {
  const root = await tmpRoot("artifacts-broken");
  const riptide = path.join(root, ".riptide");
  await mkdir(riptide, { recursive: true });
  await writeFile(path.join(riptide, "run-collection.json"), "{not json", "utf8");

  const index = await indexWorkspaceArtifacts({
    workspaceId: "current",
    workspacePath: root
  });

  const collection = index.artifacts.find((a) => a.id === "run-collection");
  assert.ok(collection, "broken run-collection still produces an entry");
  assert.equal(collection!.warnings.length, 1);
  assert.match(collection!.warnings[0]!.next_action, /riptide run/);
});

test("studio case-study artifacts do not inherit sibling repo readiness reports", async () => {
  const repoRoot = await tmpRoot("report-owner-repo");
  const caseRoot = path.join(repoRoot, "case-studies");
  const lending = path.join(caseRoot, "lending");
  const amm = path.join(caseRoot, "amm");
  await mkdir(path.join(repoRoot, ".riptide"), { recursive: true });
  await mkdir(path.join(lending, ".riptide"), { recursive: true });
  await mkdir(path.join(amm, ".riptide"), { recursive: true });
  await mkdir(path.join(repoRoot, "riptide", "reports", "case-study-readiness", "amm"), {
    recursive: true
  });
  await writeFile(
    path.join(repoRoot, "riptide", "reports", "case-study-readiness", "amm", "summary.md"),
    "# amm readiness\n",
    "utf8"
  );

  const index = await indexWorkspaceArtifacts({
    workspaceId: "lending",
    workspacePath: lending
  });

  assert.equal(index.has_riptide, true);
  assert.deepEqual(
    index.artifacts.filter((artifact) => artifact.kind === "readiness-report"),
    []
  );
});

test("studio server health route returns metadata about the workspace", async () => {
  const root = await tmpRoot("server-health");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  await withServer({ workspace: root }, async (handle) => {
    const health = await getJson(`${handle.url}/api/studio/health`);
    assert.equal(health.ok, true);
    assert.equal(health.schema_version, "studio-health.v1");
    assert.equal(health.workspace, root);
    assert.equal(health.workspace_count, 1);
    assert.equal(health.case_studies_root, null);
  });
});

test("studio server workspaces and artifacts endpoints expose discovered state", async () => {
  const home = await tmpRoot("server-current");
  await seedWorkspace(home);
  const studies = await tmpRoot("server-studies");
  await mkdir(path.join(studies, "lending", ".riptide"), { recursive: true });

  await withServer(
    { workspace: home, caseStudiesRoot: studies },
    async (handle) => {
      const wsBody = (await getJson(`${handle.url}/api/studio/workspaces`)) as {
        schema_version: string;
        workspaces: StudioWorkspace[];
      };
      assert.equal(wsBody.schema_version, "studio-workspaces.v1");
      assert.deepEqual(
        wsBody.workspaces.map((w) => w.id),
        ["current", "lending"]
      );

      const arts = (await getJson(`${handle.url}/api/studio/artifacts`)) as unknown as {
        schema_version: string;
        artifacts: Array<{ id: string }>;
      } & StudioArtifactIndex;
      assert.equal(arts.schema_version, "studio-artifacts.v1");
      assert.equal(arts.workspace_id, "current");
      assert.ok(arts.artifacts.some((a) => a.id === "run-collection"));

      const lendingArts = (await getJson(
        `${handle.url}/api/studio/artifacts?workspace=lending`
      )) as { workspace_id: string; has_riptide: boolean };
      assert.equal(lendingArts.workspace_id, "lending");
      assert.equal(lendingArts.has_riptide, true);

      const missing = await fetch(
        `${handle.url}/api/studio/artifacts?workspace=does-not-exist`
      );
      assert.equal(missing.status, 404);
      const missingPayload = (await missing.json()) as { error: string };
      assert.equal(missingPayload.error, "workspace_not_found");
    }
  );
});

test("studio changes route returns git workspace changes", async () => {
  const root = await tmpRoot("server-changes");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await execFile("git", ["init"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "before\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".riptide/runs/\n", "utf8");
  await execFile("git", ["add", "tracked.txt", ".gitignore"], { cwd: root });
  await execFile(
    "git",
    ["-c", "user.email=studio@example.invalid", "-c", "user.name=Studio Test", "commit", "-m", "init"],
    { cwd: root }
  );
  await writeFile(path.join(root, "tracked.txt"), "after\n", "utf8");
  await writeFile(path.join(root, "new.txt"), "new\n", "utf8");

  await withServer({ workspace: root }, async (handle) => {
    const changes = (await getJson(`${handle.url}/api/studio/changes`)) as {
      schema_version: string;
      is_git_workspace: boolean;
      changes: Array<{ path: string; status: string; index_status: string; worktree_status: string }>;
      warnings: string[];
    };
    assert.equal(changes.schema_version, "studio-changes.v1");
    assert.equal(changes.is_git_workspace, true);
    assert.deepEqual(changes.warnings, []);
    const byPath = new Map(changes.changes.map((change) => [change.path, change]));
    assert.equal(byPath.get("tracked.txt")?.status, "modified");
    assert.equal(byPath.get("tracked.txt")?.index_status, " ");
    assert.equal(byPath.get("tracked.txt")?.worktree_status, "M");
    assert.equal(byPath.get("new.txt")?.status, "untracked");
  });
});

test("studio thread changes ignore preexisting workspace dirt and studio backups", async () => {
  const root = await tmpRoot("server-thread-changes");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await execFile("git", ["init"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "before\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), ".riptide/runs/\n", "utf8");
  await execFile("git", ["add", "tracked.txt", ".gitignore"], { cwd: root });
  await execFile(
    "git",
    ["-c", "user.email=studio@example.invalid", "-c", "user.name=Studio Test", "commit", "-m", "init"],
    { cwd: root }
  );
  await mkdir(path.join(root, ".riptide.bak.20260509", "studio", "jobs"), { recursive: true });
  await writeFile(path.join(root, ".riptide.bak.20260509", "studio", "jobs", "old.json"), "old\n", "utf8");
  await writeFile(path.join(root, "unrelated-before.txt"), "old\n", "utf8");

  await withServer({ workspace: root }, async (handle) => {
    const created = await fetch(`${handle.url}/api/studio/chat/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "claude-code", model: "default", workspaceId: "current" })
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { thread: { id: string } };
    const threadId = createdBody.thread.id;

    const empty = (await getJson(`${handle.url}/api/studio/changes?workspace=current&thread=${threadId}`)) as {
      changes: unknown[];
      scope: string;
      thread_id: string | null;
    };
    assert.equal(empty.scope, "chat_thread");
    assert.equal(empty.thread_id, threadId);
    assert.deepEqual(empty.changes, []);

    const baseline = await readWorkspaceStatusSnapshot(root);
    await writeFile(path.join(root, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(root, "created-by-chat.txt"), "new\n", "utf8");
    await mkdir(path.join(root, ".riptide", "runs", "liquidity-baseline"), { recursive: true });
    await writeFile(
      path.join(root, ".riptide", "runs", "liquidity-baseline", "simulation-result.json"),
      "{}\n",
      "utf8"
    );
    const current = await readWorkspaceStatusSnapshot(root);
    const store = new ChatStore({ workspacePath: root });
    await store.writeThreadWorkspaceChanges(
      threadId,
      createThreadChangesState({
        threadId,
        baseline,
        current,
        changes: diffWorkspaceSnapshots(baseline, current)
      })
    );

    const scoped = (await getJson(`${handle.url}/api/studio/changes?workspace=current&thread=${threadId}`)) as {
      changes: Array<{ path: string; status: string }>;
    };
    const paths = scoped.changes.map((change) => change.path).sort();
    assert.deepEqual(paths, [
      ".riptide/runs/liquidity-baseline/simulation-result.json",
      "created-by-chat.txt",
      "tracked.txt"
    ]);
    assert.ok(!paths.some((p) => p.startsWith(".riptide.bak")));
    assert.ok(!paths.includes("unrelated-before.txt"));
  });
});

test("studio does not auto-save discovered riptide workspaces in the user registry", async () => {
  const home = await tmpRoot("server-no-auto-remember-current");
  const studies = await tmpRoot("server-no-auto-remember-studies");
  const registryPaths = { home: await tmpRoot("server-no-auto-remember-registry") };
  await mkdir(path.join(home, ".riptide"), { recursive: true });
  await mkdir(path.join(studies, "amm", ".riptide"), { recursive: true });
  await mkdir(path.join(studies, "draft"), { recursive: true });

  await withServer(
    { workspace: home, caseStudiesRoot: studies, registryPaths },
    async (handle) => {
      const registry = (await getJson(`${handle.url}/api/studio/registry`)) as {
        schema_version: string;
        projects: Array<{ label: string; path: string; last_opened_at: string | null }>;
      };
      assert.equal(registry.schema_version, "studio-registry.v1");
      assert.deepEqual(registry.projects, []);

      const workspaces = (await getJson(`${handle.url}/api/studio/workspaces`)) as {
        workspaces: Array<{ path: string; has_riptide: boolean; registry_id: string | null }>;
      };
      assert.ok(workspaces.workspaces.some((workspace) => workspace.path === home && workspace.has_riptide));
      assert.ok(workspaces.workspaces.some((workspace) => workspace.path === path.join(studies, "amm") && workspace.has_riptide));
      assert.ok(workspaces.workspaces.every((workspace) => workspace.registry_id === null));
    }
  );
});

test("studio init opens an existing .riptide workspace without overwriting it", async () => {
  const home = await tmpRoot("server-init-existing-home");
  const external = await tmpRoot("server-init-existing-external");
  await mkdir(path.join(home, ".riptide"), { recursive: true });
  await mkdir(path.join(external, ".riptide", "adapters"), { recursive: true });
  const existingAdapter = path.join(external, ".riptide", "adapters", "amm.toml");
  await writeFile(existingAdapter, "# existing adapter\n", "utf8");

  await withServer({ workspace: home }, async (handle) => {
    const initResponse = await fetch(`${handle.url}/api/studio/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        program_name: "amm",
        protocol: "amm",
        path: external,
        label: "AMM Workspace"
      })
    });
    assert.equal(initResponse.status, 200);
    const opened = (await initResponse.json()) as {
      created: string[];
      warnings: string[];
      workspaces: Array<{ id: string; label: string; path: string; has_riptide: boolean; registry_id: string | null }>;
    };
    assert.deepEqual(opened.created, []);
    assert.match(opened.warnings.join("\n"), /existing \.riptide directory found/);
    assert.equal((await stat(existingAdapter)).isFile(), true);

    const target = opened.workspaces.find((workspace) => workspace.path === external);
    assert.equal(target?.label, "AMM Workspace");
    assert.equal(target?.has_riptide, true);
    assert.match(target?.registry_id ?? "", /^prj_/);

    const registry = (await getJson(`${handle.url}/api/studio/registry`)) as {
      projects: Array<{ label: string; path: string }>;
    };
    assert.ok(registry.projects.some((project) => project.path === external && project.label === "AMM Workspace"));
  });
});

test("studio init from an uninitialized launch folder returns the chosen workspace only", async () => {
  const launchRoot = await tmpRoot("server-init-launch-shell");
  const projectRoot = await tmpRoot("server-init-chosen-project");

  await withServer({ workspace: launchRoot }, async (handle) => {
    const initResponse = await fetch(`${handle.url}/api/studio/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        program_name: "amm",
        protocol: "amm",
        path: projectRoot,
        label: "AMM"
      })
    });
    assert.equal(initResponse.status, 201);
    const body = (await initResponse.json()) as {
      workspaces: Array<{ id: string; label: string; path: string; has_riptide: boolean; registry_id: string | null }>;
    };
    assert.equal((await stat(path.join(projectRoot, ".riptide"))).isDirectory(), true);
    assert.ok(body.workspaces.some((workspace) => workspace.path === projectRoot && workspace.has_riptide));
    assert.ok(!body.workspaces.some((workspace) => workspace.path === launchRoot));
  });
});

test("studio registry delete forgets registered workspace without deleting files", async () => {
  const home = await tmpRoot("server-registry-delete-current");
  const external = await tmpRoot("server-registry-delete-external");
  await mkdir(path.join(home, ".riptide"), { recursive: true });
  await mkdir(path.join(external, ".riptide", "studio", "threads"), { recursive: true });
  await writeFile(path.join(external, ".riptide", "campaign.toml"), "[campaign]\n", "utf8");
  await writeFile(path.join(external, ".riptide", "studio", "threads", "sessions.json"), "{}", "utf8");
  await writeFile(path.join(external, "program.rs"), "// source file\n", "utf8");

  await withServer({ workspace: home }, async (handle) => {
    const createResponse = await fetch(`${handle.url}/api/studio/registry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: external, label: "External Workspace" })
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as {
      workspaces: Array<{ id: string; path: string; source: string }>;
    };
    const target = created.workspaces.find((workspace) => workspace.path === external);
    assert.equal(target?.source, "registered");

    const deleteResponse = await fetch(
      `${handle.url}/api/studio/registry/${encodeURIComponent(target!.id)}`,
      { method: "DELETE" }
    );
    assert.equal(deleteResponse.status, 200);
    const deleted = (await deleteResponse.json()) as {
      schema_version: string;
      removed: { path: string; riptide_path: string; has_riptide: boolean; preserved: boolean };
      workspaces: Array<{ id: string; path: string }>;
    };
    assert.equal(deleted.schema_version, "studio-registry-removed.v1");
    assert.equal(deleted.removed.path, external);
    assert.equal(deleted.removed.has_riptide, true);
    assert.equal(deleted.removed.preserved, true);
    assert.equal(deleted.removed.riptide_path, path.join(external, ".riptide"));
    assert.ok(!deleted.workspaces.some((workspace) => workspace.id === target!.id));
    assert.ok(!deleted.workspaces.some((workspace) => workspace.path === external));

    const registry = (await getJson(`${handle.url}/api/studio/registry`)) as {
      projects: Array<{ path: string }>;
    };
    assert.ok(!registry.projects.some((project) => project.path === external));
    assert.equal((await stat(path.join(external, ".riptide", "campaign.toml"))).isFile(), true);
    assert.equal((await stat(path.join(external, ".riptide", "studio", "threads", "sessions.json"))).isFile(), true);
    assert.equal((await stat(path.join(external, "program.rs"))).isFile(), true);

    const missingResponse = await fetch(
      `${handle.url}/api/studio/registry/${encodeURIComponent(target!.id)}`,
      { method: "DELETE" }
    );
    assert.equal(missingResponse.status, 404);
  });
});

test("studio registry delete can forget the launch workspace without re-adding it", async () => {
  const home = await tmpRoot("server-registry-delete-current-entry");
  await mkdir(path.join(home, ".riptide", "campaigns"), { recursive: true });
  await writeFile(path.join(home, ".riptide", "campaigns", "demo.toml"), "[campaign]\n", "utf8");
  await writeFile(path.join(home, "lib.rs"), "// source file\n", "utf8");

  await withServer({ workspace: home }, async (handle) => {
    const registerResponse = await fetch(`${handle.url}/api/studio/registry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: home, label: "Home Workspace" })
    });
    assert.equal(registerResponse.status, 201);

    const before = (await getJson(`${handle.url}/api/studio/workspaces`)) as {
      workspaces: Array<{ id: string; path: string; source: string; registry_id: string | null }>;
    };
    const current = before.workspaces.find((workspace) => workspace.id === "current");
    assert.equal(current?.path, home);
    assert.equal(current?.source, "current");
    assert.match(current?.registry_id ?? "", /^prj_/);

    const deleteResponse = await fetch(
      `${handle.url}/api/studio/registry/${encodeURIComponent(current!.registry_id!)}`,
      { method: "DELETE" }
    );
    assert.equal(deleteResponse.status, 200);
    const deleted = (await deleteResponse.json()) as {
      removed: { path: string; riptide_path: string; has_riptide: boolean; preserved: boolean };
      workspaces: Array<{ id: string; path: string; source: string; registry_id: string | null; has_riptide: boolean }>;
    };
    assert.equal(deleted.removed.path, home);
    assert.equal(deleted.removed.has_riptide, true);
    assert.equal(deleted.removed.preserved, true);
    assert.equal(deleted.removed.riptide_path, path.join(home, ".riptide"));
    const stillCurrent = deleted.workspaces.find((workspace) => workspace.id === "current");
    assert.equal(stillCurrent?.path, home);
    assert.equal(stillCurrent?.source, "current");
    assert.equal(stillCurrent?.registry_id, null);
    assert.equal(stillCurrent?.has_riptide, true);

    const registry = (await getJson(`${handle.url}/api/studio/registry`)) as {
      projects: Array<{ path: string }>;
    };
    assert.ok(!registry.projects.some((project) => project.path === home));
    assert.equal((await stat(path.join(home, ".riptide", "campaigns", "demo.toml"))).isFile(), true);
    assert.equal((await stat(path.join(home, "lib.rs"))).isFile(), true);
  });
});

test("studio workspace removal preserves on-disk chat when reopening", async () => {
  const home = await tmpRoot("server-registry-delete-chat-cache");
  await mkdir(path.join(home, ".riptide"), { recursive: true });

  await withServer({ workspace: home }, async (handle) => {
    const registerResponse = await fetch(`${handle.url}/api/studio/registry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: home, label: "Home Workspace" })
    });
    assert.equal(registerResponse.status, 201);

    const createdThread = await fetch(`${handle.url}/api/studio/chat/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "current", agentId: "codex", model: "default", title: "Old setup" })
    });
    assert.equal(createdThread.status, 201);
    const beforeThreads = (await getJson(`${handle.url}/api/studio/chat/threads?workspace=current`)) as {
      threads: unknown[];
    };
    assert.equal(beforeThreads.threads.length, 1);

    const beforeWorkspaces = (await getJson(`${handle.url}/api/studio/workspaces`)) as {
      workspaces: Array<{ id: string; registry_id: string | null }>;
    };
    const current = beforeWorkspaces.workspaces.find((workspace) => workspace.id === "current");
    assert.match(current?.registry_id ?? "", /^prj_/);

    const deleteResponse = await fetch(
      `${handle.url}/api/studio/registry/${encodeURIComponent(current!.registry_id!)}`,
      { method: "DELETE" }
    );
    assert.equal(deleteResponse.status, 200);
    assert.equal((await stat(path.join(home, ".riptide"))).isDirectory(), true);

    const initResponse = await fetch(`${handle.url}/api/studio/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ program_name: "home", protocol: "custom", path: home, label: "Home Workspace" })
    });
    assert.equal(initResponse.status, 200);

    const afterThreads = (await getJson(`${handle.url}/api/studio/chat/threads?workspace=current`)) as {
      threads: unknown[];
    };
    assert.equal(afterThreads.threads.length, 1);
  });
});

test("studio jobs route returns the persisted job list (empty by default)", async () => {
  const root = await tmpRoot("server-jobs-stub");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  await withServer({ workspace: root }, async (handle) => {
    const jobs = (await getJson(`${handle.url}/api/studio/jobs`)) as {
      schema_version: string;
      jobs: unknown[];
    };
    assert.equal(jobs.schema_version, "studio-jobs.v1");
    assert.deepEqual(jobs.jobs, []);
  });
});

test("studio directory picker route returns an allowlisted selected path", async () => {
  const root = await tmpRoot("server-picker");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const selected = path.join(root, "new-workspace");

  await withServer(
    {
      workspace: root,
      directoryPicker: async () => ({ path: selected, cancelled: false })
    },
    async (handle) => {
      const response = await fetch(`${handle.url}/api/studio/pick-directory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        schema_version: string;
        path: string | null;
        cancelled: boolean;
      };
      assert.equal(body.schema_version, "studio-pick-directory.v1");
      assert.equal(body.path, selected);
      assert.equal(body.cancelled, false);
    }
  );
});

test("studio xdg portal picker parser extracts selected folder path", () => {
  assert.deepEqual(parseGjsPortalDirectoryPickerOutput("OK\t/home/you/code/my program\n"), {
    kind: "success",
    path: "/home/you/code/my program"
  });
});

test("studio xdg portal picker parser reports cancellation", () => {
  assert.deepEqual(parseGjsPortalDirectoryPickerOutput("CANCEL\n"), {
    kind: "cancelled"
  });
});

test("studio xdg portal picker parser reports helper failures", () => {
  assert.deepEqual(parseGjsPortalDirectoryPickerOutput("UNAVAILABLE\tportal returned no URI\n"), {
    kind: "unavailable",
    message: "portal returned no URI"
  });
});

test("studio browse-directory route lists child directories without native dialogs", async () => {
  const root = await tmpRoot("server-browser");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await mkdir(path.join(root, "alpha"), { recursive: true });
  await mkdir(path.join(root, "beta"), { recursive: true });
  await writeFile(path.join(root, "not-a-dir.txt"), "ignore me", "utf8");

  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(`${handle.url}/api/studio/browse-directory?path=${encodeURIComponent(root)}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      schema_version: string;
      path: string;
      parent: string | null;
      entries: Array<{ name: string; path: string }>;
    };
    assert.equal(body.schema_version, "studio-directory-list.v1");
    assert.equal(body.path, root);
    assert.ok(body.parent);
    assert.deepEqual(body.entries.map((entry) => entry.name), [".riptide", "alpha", "beta"]);
  });
});

test("studio detect-program route accepts a folder path before workspace setup", async () => {
  const launchRoot = await tmpRoot("server-detect-launch");
  const projectRoot = await tmpRoot("server-detect-project");
  await mkdir(path.join(projectRoot, "programs", "amm_core"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "programs", "amm_core", "Cargo.toml"),
    `[package]
name = "amm_core"
version = "0.1.0"

[lib]
crate-type = ["cdylib", "lib"]
`,
    "utf8"
  );

  await withServer({ workspace: launchRoot }, async (handle) => {
    const response = await fetch(
      `${handle.url}/api/studio/detect-program?path=${encodeURIComponent(projectRoot)}`
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      schema_version: string;
      programName: string | null;
      source: string | null;
      candidates: Array<{ programName: string; source: string }>;
    };
    assert.equal(body.schema_version, "studio-detect-program.v1");
    assert.equal(body.programName, "amm-core");
    assert.equal(body.source, "cargo-workspace");
    assert.deepEqual(
      body.candidates.map((candidate) => ({ programName: candidate.programName, source: candidate.source })),
      [{ programName: "amm-core", source: "cargo-workspace" }]
    );
  });
});

test("studio graph route returns a populated diagram from a seeded workspace", async () => {
  const root = await tmpRoot("server-graph");
  await seedWorkspace(root);

  await withServer({ workspace: root }, async (handle) => {
    const graph = (await getJson(`${handle.url}/api/studio/graph`)) as {
      schema_version: string;
      workspace_id: string;
      selection: Record<string, string | null>;
      nodes: Array<{ id: string; kind: string; label: string }>;
      edges: Array<{ id: string; from: string; to: string; label: string }>;
      warnings: unknown[];
    };
    assert.equal(graph.schema_version, "studio-graph.v2");
    assert.equal(graph.workspace_id, "current");
    assert.ok(graph.nodes.length >= 4, "graph should include workspace + engine + adapter + scenario nodes");

    const kinds = new Set(graph.nodes.map((n) => n.kind));
    assert.ok(kinds.has("workspace"));
    assert.ok(kinds.has("engine"));
    assert.ok(kinds.has("adapter"));
    assert.ok(kinds.has("scenario"));
    assert.ok(kinds.has("run"));

    const ids = graph.nodes.map((n) => n.id);
    assert.deepEqual([...ids].sort(), [...new Set(ids)].sort(), "node ids must be unique");

    const edgeIds = graph.edges.map((e) => e.id);
    assert.deepEqual([...edgeIds].sort(), [...new Set(edgeIds)].sort(), "edge ids must be unique");
    for (const edge of graph.edges) {
      assert.ok(ids.includes(edge.from), `edge from ${edge.from} must reference a known node`);
      assert.ok(ids.includes(edge.to), `edge to ${edge.to} must reference a known node`);
    }
  });
});

test("studio report route returns the markdown body for a run artifact", async () => {
  const root = await tmpRoot("server-report");
  await seedWorkspace(root);

  await withServer({ workspace: root }, async (handle) => {
    const payload = (await getJson(
      `${handle.url}/api/studio/report?artifact=${encodeURIComponent("run:alpha")}`
    )) as {
      schema_version: string;
      content_type: string;
      label: string;
      body: string;
    };
    assert.equal(payload.schema_version, "studio-report.v1");
    assert.equal(payload.content_type, "markdown");
    assert.equal(payload.label, "report.md");
    assert.match(payload.body, /alpha/);

    const missing = await fetch(
      `${handle.url}/api/studio/report?artifact=${encodeURIComponent("run:does-not-exist")}`
    );
    assert.equal(missing.status, 404);
  });
});

test("studio report route returns TOML bodies as TOML", async () => {
  const root = await tmpRoot("server-report-toml");
  await seedWorkspace(root);

  await withServer({ workspace: root }, async (handle) => {
    const payload = (await getJson(
      `${handle.url}/api/studio/report?artifact=${encodeURIComponent("adapter:lending.toml")}`
    )) as {
      schema_version: string;
      content_type: string;
      label: string;
      body: string;
    };
    assert.equal(payload.schema_version, "studio-report.v1");
    assert.equal(payload.content_type, "toml");
    assert.equal(payload.label, "lending.toml");
    assert.match(payload.body, /\[semantics\]/);
  });
});

test("studio dashboard mount returns collection compatible with the existing dashboard", async () => {
  const root = await tmpRoot("server-dashboard-mount");
  await seedWorkspace(root);

  await withServer({ workspace: root }, async (handle) => {
    const collection = (await getJson(`${handle.url}/api/collection`)) as {
      schema_version?: number;
      scenarios?: Array<{ name: string }>;
      total_scenarios?: number;
    };
    assert.equal(typeof collection.schema_version, "number");
    assert.ok(Array.isArray(collection.scenarios));

    const result = await fetch(
      `${handle.url}/api/result?source=${encodeURIComponent(".riptide/runs/alpha")}`
    );
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type") ?? "", /application\/json/);

    const labels = await fetch(`${handle.url}/api/labels`);
    assert.equal(labels.status, 200);

    const packCollection = (await getJson(
      `${handle.url}/api/collection?source=${encodeURIComponent(".riptide/pack/alpha")}`
    )) as {
      scenarios?: Array<{ name: string; status: string }>;
    };
    assert.equal(packCollection.scenarios?.[0]?.name, "alpha");
    assert.equal(packCollection.scenarios?.[0]?.status, "pass");
  });
});

test("studio dashboard mount serves the dashboard.html shell", async () => {
  const root = await tmpRoot("server-dashboard-shell");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(`${handle.url}/dashboard`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const body = await response.text();
    assert.match(body, /Riptide Dashboard/);
  });
});

test("studio dashboard mount rejects sources that escape the workspace", async () => {
  const root = await tmpRoot("server-source-escape");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(
      `${handle.url}/api/collection?source=${encodeURIComponent("../escape")}`
    );
    assert.equal(response.status, 400);
  });
});

test("studio server serves the React app from /", async () => {
  // The CLI serves the React + Vite production bundle from
  // cli/assets/studio/index.html. Source edits under cli/studio-app/
  // must be rebuilt before they affect the served Studio UI.
  const root = await tmpRoot("server-html");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(`${handle.url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const body = await response.text();
    assert.match(body, /Riptide Studio/);
    assert.match(body, /\/api\/studio/);
  });
});

test("studio server rejects non-GET methods on read-only routes", async () => {
  const root = await tmpRoot("server-methods");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(`${handle.url}/api/studio/health`, {
      method: "POST"
    });
    assert.equal(response.status, 405);
    const workspaces = await fetch(`${handle.url}/api/studio/workspaces`, { method: "DELETE" });
    assert.equal(workspaces.status, 405);
  });
});

test("studio server rejects non-loopback bind hosts", async () => {
  const root = await tmpRoot("server-host");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  await assert.rejects(
    () => startStudioServer({ workspace: root, host: "0.0.0.0", port: 0 }),
    /localhost-only/
  );
});

test("studio server returns a 404 with route map for unknown paths", async () => {
  const root = await tmpRoot("server-404");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(`${handle.url}/api/studio/does-not-exist`);
    assert.equal(response.status, 404);
    const payload = (await response.json()) as { error: string; routes: string[] };
    assert.equal(payload.error, "not_found");
    assert.ok(payload.routes.includes("GET /api/studio/health"));
  });
});

// ---------------------------------------------------------------------------
// Sprint 31 / T09 — local job queue + launcher
// ---------------------------------------------------------------------------

function harmlessJobQueue(): StudioJobQueue {
  // Replace spawn behaviour with `node -e <script>` invocations that
  // exit immediately. The harness still validates argv/cwd handling
  // and persistence under .riptide/studio/jobs/ — the actual command
  // is just `node -e "process.exit(0)"`.
  return new StudioJobQueue({
    cliBin: { node: process.execPath, entry: "-e" },
    concurrency: 1
  });
}

test("studio job queue maps each allowlisted kind to a deterministic argv", async () => {
  const root = await tmpRoot("jobs-allowlist");
  await mkdir(path.join(root, ".riptide", "scenarios", "alpha"), { recursive: true });
  const queue = harmlessJobQueue();
  const workspaces = await discoverStudioWorkspaces({ cwd: root });
  queue.setWorkspaces(workspaces);

  const cases: Array<{ input: JobLaunchInput; expect: string[] }> = [
    {
      input: { workspaceId: "current", kind: "run", params: {} },
      expect: ["riptide", "run", "--quiet"]
    },
    {
      input: { workspaceId: "current", kind: "run", params: { scenario: "alpha" } },
      expect: ["riptide", "run", "alpha", "--quiet"]
    },
    {
      input: {
        workspaceId: "current",
        kind: "replay",
        params: { config: ".riptide/replays/x/replay-config.json" }
      },
      expect: ["riptide", "replay", ".riptide/replays/x/replay-config.json", "--quiet"]
    },
    {
      input: {
        workspaceId: "current",
        kind: "campaign-validate",
        params: { campaign: ".riptide/campaigns/c.campaign.toml" }
      },
      expect: ["riptide", "campaign", "validate", ".riptide/campaigns/c.campaign.toml"]
    },
    {
      input: {
        workspaceId: "current",
        kind: "campaign-plan",
        params: { campaign: ".riptide/campaigns/c.campaign.toml" }
      },
      expect: ["riptide", "campaign", "plan", ".riptide/campaigns/c.campaign.toml"]
    },
    {
      input: {
        workspaceId: "current",
        kind: "campaign-run",
        params: { campaign: ".riptide/campaigns/c.campaign.toml" }
      },
      expect: ["riptide", "campaign", "run", ".riptide/campaigns/c.campaign.toml"]
    },
    {
      input: { workspaceId: "current", kind: "review", params: { pack: ".riptide/pack/alpha" } },
      expect: ["riptide", "review", ".riptide/pack/alpha", "--quiet"]
    },
    {
      input: { workspaceId: "current", kind: "readiness", params: {} },
      expect: ["riptide", "readiness", ".", "--json", "--out", ".riptide/readiness"]
    }
  ];

  for (const c of cases) {
    const plan = queue.plan(c.input);
    assert.ok(!isValidationError(plan), `plan failed for ${c.input.kind}`);
    const p = plan as JobPlanPreview;
    assert.deepEqual(p.argv, c.expect, `argv for ${c.input.kind}`);
    assert.equal(p.cwd, workspaces[0]?.path);
    assert.ok(p.command_string.length > 0);
  }
});

test("studio job queue attaches campaign harness when available", async () => {
  const root = await tmpRoot("jobs-campaign-harness");
  await mkdir(path.join(root, ".riptide", "harness"), { recursive: true });
  await writeFile(
    path.join(root, ".riptide", "harness", "Cargo.toml"),
    '[package]\nname = "campaign-harness"\nversion = "0.1.0"\nedition = "2021"\n'
  );

  const queue = harmlessJobQueue();
  queue.setWorkspaces([
    {
      id: "current",
      label: "x",
      source: "current",
      path: root,
      riptide_path: path.join(root, ".riptide"),
      has_riptide: true,
      warnings: []
    }
  ]);

  const auto = queue.plan({
    workspaceId: "current",
    kind: "campaign-run",
    params: { campaign: ".riptide/campaigns/c.campaign.toml" }
  });
  assert.ok(!isValidationError(auto), `plan failed: ${JSON.stringify(auto)}`);
  assert.deepEqual((auto as JobPlanPreview).argv, [
    "riptide",
    "campaign",
    "run",
    ".riptide/campaigns/c.campaign.toml",
    "--harness",
    ".riptide/harness"
  ]);
  assert.match((auto as JobPlanPreview).notes.join(" "), /Detected \.riptide\/harness/);

  const explicit = queue.plan({
    workspaceId: "current",
    kind: "campaign-run",
    params: {
      campaign: ".riptide/campaigns/c.campaign.toml",
      harness: ".riptide/custom-harness"
    }
  });
  assert.ok(!isValidationError(explicit), `plan failed: ${JSON.stringify(explicit)}`);
  assert.deepEqual((explicit as JobPlanPreview).argv, [
    "riptide",
    "campaign",
    "run",
    ".riptide/campaigns/c.campaign.toml",
    "--harness",
    ".riptide/custom-harness"
  ]);

  const escaped = queue.plan({
    workspaceId: "current",
    kind: "campaign-run",
    params: {
      campaign: ".riptide/campaigns/c.campaign.toml",
      harness: "../outside"
    }
  });
  assert.ok(isValidationError(escaped));
  assert.equal((escaped as JobValidationError).payload.error, "invalid_param");
});

test("studio job queue rejects unknown kinds and missing required params", () => {
  const queue = harmlessJobQueue();
  const ws: StudioWorkspace = {
    id: "current",
    label: "x",
    source: "current",
    path: "/tmp/does-not-matter",
    riptide_path: "/tmp/does-not-matter/.riptide",
    has_riptide: true,
    warnings: []
  };
  queue.setWorkspaces([ws]);
  const bad = queue.plan({ workspaceId: "current", kind: "destroy" as never, params: {} });
  assert.ok(isValidationError(bad) && bad.status === 400);
  const missing = queue.plan({ workspaceId: "current", kind: "replay", params: {} });
  assert.ok(isValidationError(missing) && missing.status === 400);
  assert.match(((missing as JobValidationError).payload.message as string) ?? "", /config/);
});

test("studio job queue rejects publish/push/release tokens even via params", () => {
  const queue = harmlessJobQueue();
  const ws: StudioWorkspace = {
    id: "current",
    label: "x",
    source: "current",
    path: "/tmp/does-not-matter",
    riptide_path: "/tmp/does-not-matter/.riptide",
    has_riptide: true,
    warnings: []
  };
  queue.setWorkspaces([ws]);
  // Direct shape: a campaign whose name embeds `push`. The token
  // appears verbatim in argv and must be rejected.
  const result = queue.plan({
    workspaceId: "current",
    kind: "campaign-validate",
    params: { campaign: "publish" }
  });
  assert.ok(isValidationError(result) && result.status === 400);
  assert.match(((result as JobValidationError).payload.error as string) ?? "", /forbidden/);
});

test("studio job queue rejects shell metacharacters and absolute paths", () => {
  const queue = harmlessJobQueue();
  const ws: StudioWorkspace = {
    id: "current",
    label: "x",
    source: "current",
    path: "/tmp/does-not-matter",
    riptide_path: "/tmp/does-not-matter/.riptide",
    has_riptide: true,
    warnings: []
  };
  queue.setWorkspaces([ws]);
  for (const evil of ["/etc/passwd", "../escape", "x;rm -rf .", "x && id", "x|less"]) {
    assert.throws(
      () =>
        queue.plan({
          workspaceId: "current",
          kind: "replay",
          params: { config: evil }
        }),
      /must not escape|must be a workspace-relative|metacharacters|absolute/
    );
  }
});

test("studio job queue persists job history under .riptide/studio/jobs/", async () => {
  const root = await tmpRoot("jobs-persist");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  const queue = harmlessJobQueue();
  const workspaces = await discoverStudioWorkspaces({ cwd: root });
  queue.setWorkspaces(workspaces);

  // Use a kind that uses our `node -e` shim. We pass a tiny script
  // via params.scenario; the actual argv we want spawn() to invoke is
  // `node -e <script>` because cliBin.entry is "-e".
  // In effect: argv becomes [node, "-e", "run", "process.exit(0);", "--quiet"]
  // — node treats the `-e` script as the next arg. We override by
  // patching argv: use the review kind which only emits `["riptide","review"]`,
  // which under the harmless shim becomes `node -e riptide review` ->
  // node interprets `riptide` as the script and exits with an error
  // unless we use a real script. Instead, use a fake kind via direct
  // spawn — for persistence we just need a job to land on disk.
  const result = await queue.launch({
    workspaceId: "current",
    kind: "readiness",
    params: {}
  });
  assert.ok(!isValidationError(result), `launch returned validation error: ${JSON.stringify(result)}`);
  await queue.waitIdle();

  const dir = path.join(root, ".riptide", "studio", "jobs");
  const { readdir } = await import("node:fs/promises");
  const persisted = await readdir(dir);
  assert.ok(persisted.length >= 1, "at least one job persisted");
  assert.ok(persisted.every((f) => f.endsWith(".json")));
});

test("studio jobs HTTP plan rejects publish-shaped commands and accepts run", async () => {
  const root = await tmpRoot("jobs-http-plan");
  await mkdir(path.join(root, ".riptide", "scenarios", "alpha"), { recursive: true });
  await withServer({ workspace: root }, async (handle) => {
    const planRes = await fetch(`${handle.url}/api/studio/jobs/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: "current",
        kind: "run",
        params: { scenario: "alpha" }
      })
    });
    assert.equal(planRes.status, 200);
    const planBody = (await planRes.json()) as { plan: JobPlanPreview };
    assert.deepEqual(planBody.plan.argv, ["riptide", "run", "alpha", "--quiet"]);
    assert.equal(planBody.plan.kind, "run");
    assert.equal(planBody.plan.expected_artifact, ".riptide/runs/alpha/simulation-result.json");

    const forbidden = await fetch(`${handle.url}/api/studio/jobs/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: "current",
        kind: "campaign-validate",
        params: { campaign: "push" }
      })
    });
    assert.equal(forbidden.status, 400);
    const forbiddenBody = (await forbidden.json()) as { error: string };
    assert.equal(forbiddenBody.error, "forbidden_command");
  });
});

test("studio jobs HTTP launch persists to disk and lists in /api/studio/jobs", async () => {
  const root = await tmpRoot("jobs-http-launch");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  // Use a job queue that maps to a no-op `node -e <script>` so we don't
  // depend on the compiled CLI being on disk during the test.
  const fakeQueue = new StudioJobQueue({
    cliBin: { node: process.execPath, entry: "-e" },
    concurrency: 1
  });
  await withServer({ workspace: root, jobQueue: fakeQueue }, async (handle) => {
    const launch = await fetch(`${handle.url}/api/studio/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: "current",
        kind: "readiness",
        params: {}
      })
    });
    assert.equal(launch.status, 201);
    const body = (await launch.json()) as { job: { id: string; argv: string[]; cwd: string } };
    assert.equal(body.job.cwd, path.resolve(root));
    assert.deepEqual(body.job.argv, [
      "riptide",
      "readiness",
      ".",
      "--json",
      "--out",
      ".riptide/readiness"
    ]);

    await fakeQueue.waitIdle();

    const list = (await getJson(`${handle.url}/api/studio/jobs`)) as {
      jobs: Array<{ id: string; status: string }>;
    };
    assert.ok(list.jobs.some((j) => j.id === body.job.id));

    const detail = (await getJson(`${handle.url}/api/studio/jobs/${body.job.id}`)) as {
      job: { status: string };
    };
    assert.ok(["succeeded", "failed", "cancelled"].includes(detail.job.status));

    const cancel = await fetch(`${handle.url}/api/studio/jobs/${body.job.id}/cancel`, {
      method: "POST"
    });
    assert.equal(cancel.status, 200);
  });
});

test("studio jobs HTTP rejects non-allowlisted kinds and bad payloads", async () => {
  const root = await tmpRoot("jobs-http-reject");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await withServer({ workspace: root }, async (handle) => {
    const badKind = await fetch(`${handle.url}/api/studio/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "current", kind: "destroy", params: {} })
    });
    assert.equal(badKind.status, 400);

    const noBody = await fetch(`${handle.url}/api/studio/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ""
    });
    assert.equal(noBody.status, 400);

    const noKind = await fetch(`${handle.url}/api/studio/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "current" })
    });
    assert.equal(noKind.status, 400);
  });
});

test("studio jobs hydration surfaces persisted jobs after restart", async () => {
  const root = await tmpRoot("jobs-hydrate");
  const registryPaths = { home: await tmpRoot("jobs-hydrate-registry") };
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  // First server: launch a job, persist it.
  const firstQueue = new StudioJobQueue({
    cliBin: { node: process.execPath, entry: "-e" },
    concurrency: 1
  });
  const handleA = await startStudioServer({
    workspace: root,
    port: 0,
    maxAttempts: 1,
    jobQueue: firstQueue,
    registryPaths
  });
  try {
    const launch = await fetch(`${handleA.url}/api/studio/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "current", kind: "readiness", params: {} })
    });
    assert.equal(launch.status, 201);
    await firstQueue.waitIdle();
  } finally {
    await handleA.close();
  }

  // Second server: a fresh queue should still see the persisted job.
  const secondQueue = new StudioJobQueue({
    cliBin: { node: process.execPath, entry: "-e" },
    concurrency: 1
  });
  const handleB = await startStudioServer({
    workspace: root,
    port: 0,
    maxAttempts: 1,
    jobQueue: secondQueue,
    registryPaths
  });
  try {
    const list = (await getJson(`${handleB.url}/api/studio/jobs`)) as {
      jobs: Array<{ id: string }>;
    };
    assert.ok(list.jobs.length >= 1, "previous job survives restart");
  } finally {
    await handleB.close();
  }
});

test("studio jobs hydration normalizes legacy current ids to the owning workspace", async () => {
  const primary = await tmpRoot("jobs-hydrate-primary");
  const caseRoot = await tmpRoot("jobs-hydrate-cases");
  const lending = path.join(caseRoot, "lending");
  const amm = path.join(caseRoot, "amm");
  await mkdir(path.join(primary, ".riptide"), { recursive: true });
  await mkdir(path.join(lending, ".riptide", "studio", "jobs"), { recursive: true });
  await mkdir(path.join(amm, ".riptide", "studio", "jobs"), { recursive: true });

  await writeLegacyJob(path.join(lending, ".riptide", "studio", "jobs", "lending.json"), {
    id: "legacy-lending",
    cwd: lending
  });
  await writeLegacyJob(path.join(amm, ".riptide", "studio", "jobs", "amm.json"), {
    id: "legacy-amm",
    cwd: amm
  });

  await withServer({ workspace: primary, caseStudiesRoot: caseRoot }, async (handle) => {
    const list = (await getJson(`${handle.url}/api/studio/jobs`)) as {
      jobs: Array<{ id: string; workspace_id: string; cwd: string }>;
    };
    const byId = new Map(list.jobs.map((job) => [job.id, job]));
    assert.equal(byId.get("legacy-lending")?.workspace_id, "lending");
    assert.equal(byId.get("legacy-amm")?.workspace_id, "amm");
    assert.equal(byId.get("legacy-lending")?.cwd, lending);
    assert.equal(byId.get("legacy-amm")?.cwd, amm);
    assert.ok(!list.jobs.some((job) => job.workspace_id === "current" && job.cwd !== primary));
  });
});

test("studio jobs HTTP list scopes rows to the selected workspace", async () => {
  const primary = await tmpRoot("jobs-http-scope-primary");
  const caseRoot = await tmpRoot("jobs-http-scope-cases");
  const lending = path.join(caseRoot, "lending");
  const amm = path.join(caseRoot, "amm");
  await mkdir(path.join(primary, ".riptide", "studio", "jobs"), { recursive: true });
  await mkdir(path.join(lending, ".riptide", "studio", "jobs"), { recursive: true });
  await mkdir(path.join(amm, ".riptide", "studio", "jobs"), { recursive: true });

  await writeLegacyJob(path.join(primary, ".riptide", "studio", "jobs", "current.json"), {
    id: "current-job",
    cwd: primary,
    workspaceId: "current"
  });
  await writeLegacyJob(path.join(lending, ".riptide", "studio", "jobs", "lending.json"), {
    id: "lending-job",
    cwd: lending,
    workspaceId: "lending"
  });
  await writeLegacyJob(path.join(amm, ".riptide", "studio", "jobs", "amm.json"), {
    id: "amm-job",
    cwd: amm,
    workspaceId: "amm"
  });

  await withServer({ workspace: primary, caseStudiesRoot: caseRoot }, async (handle) => {
    const all = (await getJson(`${handle.url}/api/studio/jobs`)) as {
      jobs: Array<{ id: string; workspace_id: string }>;
    };
    assert.deepEqual(new Set(all.jobs.map((job) => job.id)), new Set(["current-job", "lending-job", "amm-job"]));

    const scoped = (await getJson(`${handle.url}/api/studio/jobs?workspace=lending`)) as {
      jobs: Array<{ id: string; workspace_id: string }>;
    };
    assert.deepEqual(scoped.jobs.map((job) => job.id), ["lending-job"]);
    assert.ok(scoped.jobs.every((job) => job.workspace_id === "lending"));

    const missing = await fetch(`${handle.url}/api/studio/jobs?workspace=does-not-exist`);
    assert.equal(missing.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Sprint 31 / T10 — chat-like config handoff
// ---------------------------------------------------------------------------

test("config intent generator returns prompt + proposed files for a complete payload", () => {
  const result = generateConfigIntent({
    workspace_id: "lending",
    protocol_class: "lending",
    repo_path: "/abs/path/to/lending",
    risk_goal: "no_bad_debt",
    scenario_target: "whale-shock",
    evidence_boundary: "campaign-grid",
    notes: "Use cautious yield farmers."
  });
  if (!("schema_version" in result)) {
    throw new Error(`unexpected validation error: ${JSON.stringify(result.payload)}`);
  }
  assert.equal(result.schema_version, "studio-config-intent.v1");
  assert.equal(result.intent.protocol_class, "lending");
  assert.equal(result.intent.evidence_boundary, "campaign-grid");
  assert.ok(result.proposed_files.some((f: { path: string }) => f.path === ".riptide/adapters/lending.toml"));
  assert.ok(result.proposed_files.some((f: { path: string }) => f.path.includes("whale-shock")));
  assert.ok(result.validation_commands.includes("riptide doctor"));
  assert.ok(result.handoff_prompt.includes("riptide-config"));
  assert.ok(result.handoff_prompt.includes("skill is unavailable"));
  assert.ok(result.handoff_prompt.includes("~/.codex/skills/riptide-config/SKILL.md"));
  assert.ok(result.handoff_prompt.includes("/abs/path/to/lending"));
  assert.ok(!/already (?:edited|applied|wrote)/.test(result.handoff_prompt));
});

test("config intent generator rejects missing fields and unknown protocol classes", () => {
  const missing = generateConfigIntent({
    workspace_id: "current",
    protocol_class: "lending",
    repo_path: "/abs",
    risk_goal: "no_bad_debt"
  } as Record<string, unknown>);
  assert.ok("status" in missing && missing.status === 400);

  const wrong = generateConfigIntent({
    workspace_id: "current",
    protocol_class: "rocketscience",
    repo_path: "/abs",
    risk_goal: "no_bad_debt",
    scenario_target: "x",
    evidence_boundary: "current-state-only"
  });
  assert.ok("status" in wrong && wrong.status === 400);
});

test("config intent HTTP endpoint returns the prompt and never claims it edited files", async () => {
  const root = await tmpRoot("config-intent-http");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await withServer({ workspace: root }, async (handle) => {
    const ok = await fetch(`${handle.url}/api/studio/config/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: "current",
        protocol_class: "amm",
        repo_path: root,
        risk_goal: "no_value_loss",
        scenario_target: "swap-stress",
        evidence_boundary: "current-state-only"
      })
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as {
      handoff_prompt: string;
      proposed_files: Array<{ path: string }>;
      notes: string[];
    };
    assert.match(body.handoff_prompt, /riptide-config/);
    assert.ok(body.proposed_files.some((f) => f.path.includes("amm")));
    assert.ok(body.notes.some((n) => /did not edit/i.test(n)));

    const bad = await fetch(`${handle.url}/api/studio/config/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(bad.status, 400);
  });
});

test("studio loads case-study workspaces from --case-studies-root", async () => {
  const caseRoot = await tmpRoot("case-studies-root");
  for (const name of ["lending", "anchor-uniswap-v2"]) {
    await mkdir(path.join(caseRoot, name, ".riptide"), { recursive: true });
  }
  await mkdir(path.join(caseRoot, "fresh-case"), { recursive: true });
  const cwd = await tmpRoot("primary");
  await mkdir(path.join(cwd, ".riptide"), { recursive: true });

  await withServer({ workspace: cwd, caseStudiesRoot: caseRoot }, async (handle) => {
    const list = (await getJson(`${handle.url}/api/studio/workspaces`)) as {
      workspaces: Array<{ id: string; source: string; has_riptide: boolean }>;
    };
    const ids = list.workspaces.map((w) => w.id);
    assert.equal(list.workspaces[0]?.source, "current");
    assert.ok(ids.includes("lending"));
    assert.ok(ids.includes("anchor-uniswap-v2"));
    const fresh = list.workspaces.find((w) => w.id === "fresh-case");
    assert.equal(fresh?.source, "case-study");
    assert.equal(fresh?.has_riptide, false);
  });
});
