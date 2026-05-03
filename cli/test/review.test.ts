import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { collectInvariantFires } from "../src/review/markdown.js";
import { executeCampaign, parseCampaignToml } from "../src/campaign/index.js";
import type { SimulationResult } from "../src/compiler/schema.js";
import {
  resolveArtifactsDir,
  type RunOneContext
} from "../src/run/loop.js";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");
const __dirname = path.resolve(process.cwd(), "test");
const packPath = path.resolve(__dirname, "../../fixtures/replays/lending-whale-bad-debt/");
const packResultPath = path.join(packPath, "riptide-output", "replays", "lending-whale-bad-debt", "simulation-result.json");
const expectedRawSha256 = "770a10497af484a310da2aaed654dd315030565afd362ae8b1011fb0249191ae";
let materializedPackPromise: Promise<void> | undefined;

test("review validates the lending whale replay pack and emits markdown", async () => {
  await ensureReviewPackMaterialized();
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntrypoint, "review", packPath], {
    cwd: process.cwd(),
  });

  assert.equal(stderr, "");
  assert.match(stdout, /# Pack: lending-whale-bad-debt/);
  assert.match(stdout, /\*\*Proof level 3 - Failure-shape replay\*\*/);
  assert.match(stdout, /Canonical hash: `6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1`/);
  assert.match(stdout, new RegExp(`Raw output SHA256: \`${expectedRawSha256}\``));
  assert.match(stdout, /no_bad_debt/);
  assert.match(stdout, /rerun\.sh` is present and `sh -n` parseable; it was not executed/);
});

test("review --json emits validation, invariant, digest, canonical hash, and raw sha256 fields", async () => {
  await ensureReviewPackMaterialized();
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "review", packPath, "--json"], {
    cwd: process.cwd(),
  });

  const payload = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal((payload.pack as Record<string, unknown>).slug, "lending-whale-bad-debt");
  assert.equal((payload.hash as Record<string, unknown>).ok, true);
  assert.equal((payload.hash as Record<string, unknown>).observed, "6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1");
  assert.equal((payload.hash as Record<string, unknown>).raw_sha256, expectedRawSha256);
  assert.equal(Array.isArray(payload.validation), true);
  assert.equal(Array.isArray(payload.invariant_fires), true);
  assert.match(String((payload.manifest as Record<string, unknown>).digest), /^[a-f0-9]{64}$/);
});

test("review accepts a campaign root and maps retained cases to risk and rerun evidence", async () => {
  const root = await campaignReviewFixtureRoot();
  const spec = parseCampaignToml(
    await readFile(path.join(root, "campaign.toml"), "utf8"),
    path.join(root, "campaign.toml")
  );
  const result = await executeCampaign(spec, {
    cwd: root,
    maxRuns: 3,
    runOne: async (ctx) => {
      const index = resultRunIndex(ctx.scenario.runConfigPath);
      const simulation = campaignSimulationResult(index, {
        totalBadDebt: index === 1 ? 2500 : 0,
        totalLiquidations: index === 1 ? 3 : 0,
        maxUtilization: index === 1 ? 7.5 : 1.1,
        minTvl: index === 1 ? 700 : 1000
      });
      const artifactsDir = await writeCampaignArtifacts(ctx, simulation);
      return { kind: "pass", wallClockS: 0.01, artifactsDir, result: simulation };
    }
  });

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", result.plan.campaignRoot, "--quiet"],
    { cwd: root }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /# Campaign Review: campaign-review-fixture/);
  assert.match(stdout, /worst_bad_debt/);
  assert.match(stdout, /bad_debt=2500/);
  assert.match(stdout, /warn_signals=collection_worst_health_factor/);
  assert.doesNotMatch(stdout, /invariants=collection_worst_health_factor/);
  assert.match(stdout, /rerun\.sh is present and sh -n parseable/);

  const otherCwd = await mkdtemp(path.join(os.tmpdir(), "riptide-review-other-cwd-"));
  const { stdout: otherStdout, stderr: otherStderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", result.plan.campaignRoot, "--quiet"],
    { cwd: otherCwd }
  );

  assert.equal(otherStderr, "");
  assert.match(otherStdout, /# Campaign Review: campaign-review-fixture/);
  assert.match(otherStdout, /bad_debt=2500/);
});

test("review collects fired semantic expression invariants before legacy rows", () => {
  const fires = collectInvariantFires({
    semantics: { class: "lending.v1" },
    summary: {
      invariants_fired: [
        {
          name: "legacy_no_bad_debt",
          field: "bad_debt",
          op: "==",
          value: 0,
          firings: 1,
          first_tick: 7,
        },
      ],
      expression_invariants: [
        {
          name: "ltv_below_max",
          expr: "debt_value <= max_borrow_value",
          severity: "warn",
          first_tick: 4,
          firing_count: 1,
          observed: [{ tick: 4, values: { debt_value: 100, max_borrow_value: 90 } }],
        },
      ],
    },
    events: [],
  });

  assert.equal(fires.length, 1);
  assert.equal(fires[0]!.name, "ltv_below_max");
  assert.equal(fires[0]!.rule, "debt_value <= max_borrow_value");
  assert.equal(fires[0]!.firstTick, 4);
  assert.equal(fires[0]!.firingCount, 1);
  assert.equal(fires[0]!.observed, "T4: Debt value: 100, Max borrow value: 90");
});

test("review ignores invariant evidence from fields excluded from the canonical hash", async () => {
  const copied = await copyPack("riptide-review-unhashed-invariants-");
  const resultPath = path.join(copied, "riptide-output", "replays", "lending-whale-bad-debt", "simulation-result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
  const summary = result.summary as Record<string, unknown>;
  summary.expression_invariants = [
    {
      name: "fake_semantic_fire",
      expr: "fake == true",
      firing_count: 1,
      first_tick: 1,
      observed: [{ tick: 1, values: { fake: true } }],
    },
  ];
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  const manifestPath = path.join(copied, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.invariant_firings = [
    {
      name: "fake_manifest_fire",
      firings: 1,
      first_tick: 1,
      field: "fake",
      op: "==",
      value: true,
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "review", copied, "--json"], {
    cwd: process.cwd(),
  });

  const payload = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal((payload.hash as Record<string, unknown>).ok, true);
  assert.equal((payload.hash as Record<string, unknown>).observed, "6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1");
  const fires = payload.invariant_fires as Array<Record<string, unknown>>;
  assert.deepEqual(fires.map((fire) => fire.name), ["no_bad_debt"]);
});

test("review derives What Broke from hash-covered evidence when summary.md is tampered", async () => {
  const copied = await copyPack("riptide-review-unhashed-summary-");
  await writeFile(
    path.join(copied, "summary.md"),
    [
      "# Run summary - tampered",
      "",
      "- **Outcome:** No invariant fired; all checks stayed clean.",
      "",
    ].join("\n"),
    "utf8"
  );

  const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
    cwd: process.cwd(),
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Hash verification: passed/);
  assert.match(
    stdout,
    /## What Broke\s+no_bad_debt fired first at tick 4, indicating the declared proof condition was violated in this pack\./
  );
  assert.doesNotMatch(stdout, /No invariant fired; all checks stayed clean/);
});

test("review --out writes markdown and prints a short success line", async () => {
  await ensureReviewPackMaterialized();
  const tmp = await mkdtemp(path.join(os.tmpdir(), "riptide-review-out-"));
  const outPath = path.join(tmp, "review.md");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", packPath, "--out", outPath],
    { cwd: process.cwd() }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /wrote review markdown:/);
  const markdown = await readFile(outPath, "utf8");
  assert.match(markdown, /# Pack: lending-whale-bad-debt/);
  assert.match(markdown, /What This Proof Does Not Claim/);
});

test("review validates an unchanged pack copied outside the checkout", async () => {
  const copied = await copyPack("riptide-review-copied-");
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
    cwd: process.cwd(),
  });

  assert.equal(stderr, "");
  assert.match(stdout, /# Pack: lending-whale-bad-debt/);
  assert.match(stdout, /Hash verification: passed/);
});

test("review exits 2 when an indexed path is absolute", async () => {
  const copied = await copyPack("riptide-review-absolute-index-");
  await writeFile(
    path.join(copied, "inputs", "paths.json"),
    JSON.stringify({ adapter: path.join(copied, "adapter.toml"), config: "config.json" }, null, 2) + "\n",
    "utf8"
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /absolute indexed paths are not allowed/);
      assert.match(err.stderr ?? "", /field: inputs\.adapter/);
      return true;
    }
  );
});

test("review exits 2 when an indexed path escapes the pack root", async () => {
  const copied = await copyPack("riptide-review-escaping-index-");
  await writeFile(path.join(path.dirname(copied), "outside-adapter.toml"), "# outside pack\n", "utf8");
  await writeFile(
    path.join(copied, "inputs", "paths.json"),
    JSON.stringify({ adapter: "../outside-adapter.toml", config: "config.json" }, null, 2) + "\n",
    "utf8"
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /indexed path escapes pack root/);
      assert.match(err.stderr ?? "", /field: inputs\.adapter/);
      return true;
    }
  );
});

test("review exits 2 when an indexed path symlink canonicalizes outside the pack root", async () => {
  const copied = await copyPack("riptide-review-symlink-index-");
  const outsideResult = path.join(packPath, "riptide-output", "replays", "lending-whale-bad-debt", "simulation-result.json");
  const symlinkPath = path.join(copied, "outputs", "simulation-result-link.json");
  await symlink(outsideResult, symlinkPath);
  await writeFile(
    path.join(copied, "outputs", "paths.json"),
    JSON.stringify({ simulation_result: "outputs/simulation-result-link.json" }, null, 2) + "\n",
    "utf8"
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied, "--json"], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /canonicalizes outside it/);
      assert.match(err.stderr ?? "", /field: outputs\.simulation_result/);
      return true;
    }
  );
});

test("review exits 2 when default simulation-result fallback symlink canonicalizes outside the pack root", async () => {
  const copied = await copyPack("riptide-review-symlink-default-result-");
  const outsideResult = path.join(packPath, "riptide-output", "replays", "lending-whale-bad-debt", "simulation-result.json");
  const symlinkPath = path.join(copied, "outputs", "simulation-result.json");
  const manifestPath = path.join(copied, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

  delete manifest.outputs;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(path.join(copied, "outputs", "paths.json"), "{}\n", "utf8");
  await symlink(outsideResult, symlinkPath);

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied, "--json"], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /canonicalizes outside it/);
      assert.match(err.stderr ?? "", /field: outputs\.simulation_result/);
      return true;
    }
  );
});

test("review exits 2 on malformed manifest", async () => {
  const copied = await copyPack("riptide-review-malformed-");
  await writeFile(path.join(copied, "manifest.json"), "{ nope", "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /malformed manifest\.json/);
      return true;
    }
  );
});

test("review exits 2 on canonical hash mismatch", async () => {
  const copied = await copyPack("riptide-review-hash-");
  const manifestPath = path.join(copied, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.canonical_hash = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /canonical hash mismatch/);
      assert.match(err.stderr ?? "", /expected: 0000000000000000000000000000000000000000000000000000000000000000/);
      assert.match(err.stderr ?? "", /observed: 6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1/);
      return true;
    }
  );
});

async function campaignReviewFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-review-campaign-"));
  await mkdir(path.join(root, "fixtures", "adapters"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "personas"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "scenarios", "lending", "stress"), {
    recursive: true
  });
  await writeFile(path.join(root, "fixtures", "adapters", "lending.toml"), "", "utf8");
  await writeFile(path.join(root, "fixtures", "personas", "whale.toml"), "", "utf8");
  await writeFile(
    path.join(root, "fixtures", "scenarios", "lending", "stress", "run-config.json"),
    JSON.stringify(
      {
        agents: 1,
        ticks: 4,
        scenario: "price-shock",
        personas: ["whale"],
        validator_url: "unused",
        output_path: "template-output"
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(root, "campaign.toml"),
    `
[campaign]
name = "campaign-review-fixture"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 3
seed_policy = "fixed:20260502"
replay_retention = ["worst_bad_debt", "median"]

[campaign.scenarios]
selection = "weighted"
families = ["stress"]

[campaign.scenarios.stress]
source = "fixtures/scenarios/lending/stress"
weight = 1
parameters = ["shock_profile"]

[campaign.personas]
base = "fixtures/personas"
families = []

[campaign.parameters.shock_profile]
distribution = "fixed"
value = "price-shock"
`,
    "utf8"
  );
  return root;
}

async function writeCampaignArtifacts(
  ctx: RunOneContext,
  result: SimulationResult
): Promise<string> {
  const artifactsDir = resolveArtifactsDir(ctx);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, "simulation-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(artifactsDir, "report.md"), "# Report\n", "utf8");
  return artifactsDir;
}

function campaignSimulationResult(
  index: number,
  metrics: {
    totalBadDebt: number;
    totalLiquidations: number;
    maxUtilization: number;
    minTvl: number;
  }
): SimulationResult {
  return {
    run_config: {
      agents: 1,
      ticks: 4,
      scenario: "unit",
      seed: index + 1,
      personas: ["whale"],
      validator_url: "unused",
      output_path: ".riptide/runs/unit"
    },
    seed: index + 1,
    total_ticks: 4,
    timeseries: [
      {
        tick: 0,
        active_agents: 1,
        tvl: 1000,
        utilization: 0,
        cumulative_bad_debt: 0,
        cumulative_liquidations: 0
      },
      {
        tick: 4,
        active_agents: 1,
        tvl: metrics.minTvl,
        utilization: metrics.maxUtilization,
        cumulative_bad_debt: metrics.totalBadDebt,
        cumulative_liquidations: metrics.totalLiquidations
      }
    ],
    events: [
      {
        tick: 1,
        agent_id: "agent-001",
        persona_id: "whale",
        persona_label: "Whale",
        action: "deposit",
        params: { amount: 1 },
        outcome: "success"
      }
    ],
    agents: [
      {
        agent_id: "agent-001",
        persona_id: "whale",
        persona_label: "Whale",
        status: "active",
        final_balance: 100,
        pnl: 0,
        total_actions: 1,
        triggers_activated: 0
      }
    ],
    summary: {
      agents_active: 1,
      agents_liquidated: metrics.totalLiquidations > 0 ? 1 : 0,
      agents_depleted: 0,
      final_tvl: metrics.minTvl,
      final_utilization: metrics.maxUtilization,
      total_bad_debt: metrics.totalBadDebt,
      total_liquidations: metrics.totalLiquidations,
      invariants_fired: [
        { name: "bad_debt_bound", field: "bad_debt", op: "<=", value: 0, firings: 0 }
      ],
      expression_invariants: [
        {
          name: "collection_worst_health_factor",
          expr: "collection.worst_health_factor > 1.0",
          severity: "warn",
          first_tick: index === 1 ? 2 : null,
          firing_count: index === 1 ? 1 : 0,
          observed: index === 1 ? [{ tick: 2, values: { "collection.worst_health_factor": 1 } }] : [],
          first_fired_tick: index === 1 ? 2 : null,
          firings: index === 1 ? 1 : 0
        }
      ]
    },
    simulation_boundaries: ["unit test"]
  };
}

function resultRunIndex(runConfigPath: string): number {
  const runDir = path.basename(path.dirname(runConfigPath));
  const match = /^run_(\d{6})_/.exec(runDir);
  return match ? Number(match[1]) : -1;
}

async function copyPack(prefix: string): Promise<string> {
  await ensureReviewPackMaterialized();
  const tmpParent = await mkdtemp(path.join(os.tmpdir(), prefix));
  const copied = path.join(tmpParent, "lending-whale-bad-debt");
  await cp(packPath, copied, { recursive: true });
  return copied;
}

async function ensureReviewPackMaterialized(): Promise<void> {
  materializedPackPromise ??= materializeReviewPackIfNeeded();
  await materializedPackPromise;
}

async function materializeReviewPackIfNeeded(): Promise<void> {
  const existing = await readOptionalFile(packResultPath);
  if (existing && sha256(existing) === expectedRawSha256) {
    return;
  }

  await execFileAsync(
    process.execPath,
    [cliEntrypoint, "replay", "config.json", "--allow-invariant-violations", "--quiet"],
    { cwd: packPath }
  );

  const generated = await readFile(packResultPath);
  assert.equal(sha256(generated), expectedRawSha256);
}

async function readOptionalFile(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
