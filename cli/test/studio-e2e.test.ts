import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startStudioServer, type StudioServerHandle } from "../src/studio/server.js";

async function tmpRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `riptide-studio-e2e-${label}-`));
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

test("studio e2e endpoints work against case-study workspaces", async () => {
  const primary = await tmpRoot("primary");
  const caseRoot = await tmpRoot("case-root");
  await mkdir(path.join(primary, ".riptide"), { recursive: true });

  const slugA = "amm";
  const slugB = "lending";
  const wsA = path.join(caseRoot, slugA);
  const wsB = path.join(caseRoot, slugB);
  await seedCaseStudy(wsA, slugA);
  await mkdir(path.join(wsB, ".riptide"), { recursive: true });

  await withServer({ workspace: primary, caseStudiesRoot: caseRoot }, async (handle) => {
    const workspaces = await getJson(`${handle.url}/api/studio/workspaces`) as {
      workspaces: Array<{ id: string; source: string }>;
    };
    assert.deepEqual(workspaces.workspaces.map((workspace) => workspace.id), ["current", slugA, slugB]);
    assert.equal(workspaces.workspaces[0]!.source, "current");

    const artifacts = await getJson(`${handle.url}/api/studio/artifacts?workspace=${slugA}`) as {
      artifacts: Array<{ id: string; kind: string }>;
    };
    assert.ok(artifacts.artifacts.some((artifact) => artifact.id === "run-collection"));
    assert.ok(artifacts.artifacts.some((artifact) => artifact.id === "run:smoke"));

    const graph = await getJson(`${handle.url}/api/studio/graph?workspace=${slugA}`) as {
      nodes: Array<{ kind: string }>;
    };
    assert.ok(graph.nodes.some((node) => node.kind === "adapter"));
    assert.ok(graph.nodes.some((node) => node.kind === "engine"));

    const report = await getJson(`${handle.url}/api/studio/report?workspace=${slugA}&artifact=run%3Asmoke`) as {
      content_type: string;
      body: string;
    };
    assert.equal(report.content_type, "markdown");
    assert.match(report.body, /smoke report/);

    const planResponse = await fetch(`${handle.url}/api/studio/jobs/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace: slugA,
        kind: "run",
        params: { scenario: "smoke" }
      })
    });
    assert.equal(planResponse.status, 200);
    const planBody = (await planResponse.json()) as { plan: { argv: string[] } };
    assert.deepEqual(planBody.plan.argv.slice(0, 3), ["riptide", "run", "smoke"]);

    const intentResponse = await fetch(`${handle.url}/api/studio/config/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: slugA,
        protocol_class: "amm",
        repo_path: wsA,
        risk_goal: "no_value_loss",
        scenario_target: "swap-stress",
        evidence_boundary: "current-state-only"
      })
    });
    assert.equal(intentResponse.status, 200);
    const intent = (await intentResponse.json()) as { handoff_prompt: string; proposed_files: Array<{ path: string }> };
    assert.match(intent.handoff_prompt, /riptide-config/);
    assert.ok(intent.proposed_files.some((file) => file.path.includes("amm")));
  });
});

test("studio chat runs in the selected case-study workspace", async () => {
  const primary = await tmpRoot("chat-primary");
  const caseRoot = await tmpRoot("chat-case-root");
  const fakeBin = await tmpRoot("chat-bin");
  await mkdir(path.join(primary, ".riptide"), { recursive: true });

  const slug = "lending";
  const ws = path.join(caseRoot, slug);
  await seedCaseStudy(ws, slug);
  await writeFakeCodex(path.join(fakeBin, "codex"));

  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;
  try {
    await withServer({ workspace: primary, caseStudiesRoot: caseRoot }, async (handle) => {
      const created = await fetch(`${handle.url}/api/studio/chat/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: slug,
          agentId: "codex",
          model: "default",
          title: "case-study chat"
        })
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as { thread: { id: string } };
      const threadId = createdBody.thread.id;

      const run = await fetch(`${handle.url}/api/studio/chat/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: slug,
          prompt: "print your cwd"
        })
      });
      assert.equal(run.status, 202);

      const detail = await waitForChatAssistant(handle.url, slug, threadId);
      assert.ok(
        detail.messages.some((m) => m.kind === "assistant" && (m.text ?? "").includes(`cwd=${ws}`)),
        JSON.stringify(detail.messages)
      );
    });
  } finally {
    process.env.PATH = oldPath;
  }
});

async function seedCaseStudy(root: string, slug: string): Promise<void> {
  const riptide = path.join(root, ".riptide");
  await mkdir(path.join(riptide, "adapters"), { recursive: true });
  await mkdir(path.join(riptide, "scenarios", "smoke"), { recursive: true });
  await mkdir(path.join(riptide, "runs", "smoke"), { recursive: true });

  await writeFile(
    path.join(riptide, "adapters", `${slug}.toml`),
    [
      'protocol = "generic"',
      "",
      "[semantics]",
      'class = "amm.v1"',
      "",
      "[personas.trader]",
      'label = "Trader"',
      "",
      "[[invariants]]",
      'name = "reserves_non_negative"',
      'field = "reserves"',
      'op = ">="',
      "value = 0",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    path.join(riptide, "scenarios", "smoke", "run-config.json"),
    JSON.stringify({ scenario: "smoke", agents: 1, ticks: 4, seed: 7 }, null, 2) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(riptide, "run-collection.json"),
    JSON.stringify(
      {
        schema_version: 1,
        total_scenarios: 1,
        totals_by_status: { pass: 1 },
        totals_by_verdict: { "no-failure-observed": 1 },
        totals_by_coverage: { exercised: 1 },
        scenarios: [
          {
            name: "smoke",
            status: "pass",
            interpretation: {
              verdict: "no-failure-observed",
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
    path.join(riptide, "runs", "smoke", "simulation-result.json"),
    JSON.stringify(
      {
        run_config: {
          agents: 1,
          ticks: 4,
          scenario: "smoke",
          seed: 7,
          personas: ["trader"],
          validator_url: "http://127.0.0.1:8899",
          output_path: ".riptide/runs/smoke"
        },
        seed: 7,
        total_ticks: 4,
        timeseries: [{ tick: 0, active_agents: 1, tvl: 100 }],
        events: [],
        agents: [],
        summary: {
          final_tvl: 100,
          final_utilization: 0,
          total_bad_debt: 0,
          agents_active: 1,
          agents_liquidated: 0,
          agents_depleted: 0,
          invariants_fired: [{ name: "reserves_non_negative", field: "reserves", op: ">=", value: 0, firings: 0 }]
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(path.join(riptide, "runs", "smoke", "report.md"), "# smoke report\n", "utf8");
}

async function writeFakeCodex(target: string): Promise<void> {
  await writeFile(
    target,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('codex 1.2.3');",
      "  process.exit(0);",
      "}",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const cwd = process.cwd();",
      "  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-session' }));",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `cwd=${cwd}; prompt=${input.trim()}` } }));",
      "  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));",
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(target, 0o755);
}

async function waitForChatAssistant(
  baseUrl: string,
  workspace: string,
  threadId: string
): Promise<{ messages: Array<{ kind: string; text?: string }> }> {
  const url = `${baseUrl}/api/studio/chat/threads/${threadId}?workspace=${encodeURIComponent(workspace)}`;
  const deadline = Date.now() + 5000;
  let last: { messages: Array<{ kind: string; text?: string }> } = { messages: [] };
  while (Date.now() < deadline) {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    last = (await res.json()) as { messages: Array<{ kind: string; text?: string }> };
    if (last.messages.some((m) => m.kind === "assistant")) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}
