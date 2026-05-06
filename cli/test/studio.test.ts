import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startStudioServer, type StudioServerHandle } from "../src/studio/server.js";
import {
  discoverStudioWorkspaces,
  type StudioWorkspace
} from "../src/studio/workspaces.js";
import {
  indexWorkspaceArtifacts,
  type StudioArtifactIndex
} from "../src/studio/artifacts.js";
import type { SimulationResult } from "../src/compiler/schema.js";

async function tmpRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-studio-${label}-`));
}

async function withServer<T>(
  options: Parameters<typeof startStudioServer>[0],
  fn: (handle: StudioServerHandle) => Promise<T>
): Promise<T> {
  const handle = await startStudioServer({ port: 0, maxAttempts: 1, ...options });
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

  assert.equal(workspaces.length, 3);
  assert.equal(workspaces[0]!.id, "current");
  assert.deepEqual(
    workspaces.slice(1).map((w: StudioWorkspace) => w.id),
    ["amm", "lending"]
  );
  for (const ws of workspaces.slice(1)) {
    assert.equal(ws.source, "case-study");
    assert.equal(ws.has_riptide, true);
  }
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

test("studio jobs route still returns the Phase 1 placeholder", async () => {
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

test("studio server serves the static studio.html shell from /", async () => {
  const root = await tmpRoot("server-html");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(`${handle.url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const body = await response.text();
    assert.match(body, /Riptide Studio/);
    assert.match(body, /\/api\/studio\/health/);
  });
});

test("studio server rejects non-GET methods", async () => {
  const root = await tmpRoot("server-methods");
  await mkdir(path.join(root, ".riptide"), { recursive: true });
  await withServer({ workspace: root }, async (handle) => {
    const response = await fetch(`${handle.url}/api/studio/health`, {
      method: "POST"
    });
    assert.equal(response.status, 405);
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
