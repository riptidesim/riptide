import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCampaignExpansion,
  campaignIdentity,
  materializeCampaignExpansion,
  parseCampaignToml
} from "../src/campaign/index.js";

test("campaign expansion determinism: canonical digest, run seeds, run IDs, and configs are byte-stable", async () => {
  const root = await campaignFixtureRoot();
  const campaignPath = path.join(root, "campaign.toml");
  const spec = parseCampaignToml(campaignToml(), campaignPath);

  const first = await buildCampaignExpansion(spec, { cwd: root, maxRuns: 3 });
  const second = await buildCampaignExpansion(spec, { cwd: root, maxRuns: 3 });
  const relocated = await buildCampaignExpansion(spec, {
    cwd: root,
    outputRoot: path.join(root, "campaign-output"),
    maxRuns: 3
  });

  assert.equal(first.canonicalCampaignJson, second.canonicalCampaignJson);
  assert.equal(first.campaignDigest, second.campaignDigest);
  assert.match(first.campaignId, /^campaign_[a-f0-9]{12}$/);
  assert.equal(first.runs.length, 3);

  for (let index = 0; index < first.runs.length; index += 1) {
    assert.equal(first.runs[index]?.runSeed, second.runs[index]?.runSeed);
    assert.equal(first.runs[index]?.runId, second.runs[index]?.runId);
    assert.equal(first.runs[index]?.runConfigDigest, second.runs[index]?.runConfigDigest);
    assert.equal(first.runs[index]?.runConfigJson, second.runs[index]?.runConfigJson);
    assert.equal(first.runs[index]?.runId, relocated.runs[index]?.runId);
    assert.equal(first.runs[index]?.runConfigDigest, relocated.runs[index]?.runConfigDigest);
    assert.match(first.runs[index]!.runId, /^run_[0-9]{6}_[a-f0-9]{12}$/);
  }

  assert.equal(first.runs[0]?.runId.startsWith("run_000000_"), true);
  assert.notEqual(first.runs[0]?.runId, first.runs[1]?.runId);
  assert.ok(!first.canonicalCampaignJson.includes(root), "canonical campaign JSON must not bake host paths for relative inputs");
  assert.deepEqual(Object.keys(first.runs[0]!.sampledParameters), [
    "shock_profile",
    "borrower_count"
  ]);
});

test("campaign materialization expansion: sampled coordinates change effective generated run config fields", async () => {
  const root = await materializationFixtureRoot();
  const spec = parseCampaignToml(
    materializationCampaignToml(),
    path.join(root, "campaign.toml")
  );

  const plan = await buildCampaignExpansion(spec, { cwd: root, maxRuns: 16 });
  const effectiveSignatures = new Set<string>();
  const observedScenarios = new Set<string>();

  for (const run of plan.runs) {
    const config = JSON.parse(run.runConfigJson) as {
      agents: number;
      campaign: { sampled_parameters: Record<string, unknown> };
      personas: string[];
      scenario: string;
      ticks: number;
    };
    const params = config.campaign.sampled_parameters;
    const whaleShareBps = Number(params.whale_share_bps);
    const expectedWhales = Math.max(
      1,
      Math.min(10, Math.round((10 * whaleShareBps) / 10_000))
    );

    assert.equal(config.scenario, params.shock_profile);
    observedScenarios.add(config.scenario);
    assert.equal(config.ticks, 20 + Number(params.oracle_lag_ticks));
    assert.equal(config.agents, config.personas.length);
    assert.equal(config.personas.filter((persona) => persona === "whale").length, expectedWhales);
    assert.equal(
      config.personas.filter((persona) => persona === "steady-lp").length,
      config.agents - expectedWhales
    );

    effectiveSignatures.add(
      JSON.stringify({
        agents: config.agents,
        personas: config.personas,
        scenario: config.scenario,
        ticks: config.ticks
      })
    );
  }

  assert.ok(
    effectiveSignatures.size >= 2,
    "sampled parameters must alter effective run config fields, not only campaign metadata"
  );
  assert.deepEqual([...observedScenarios].sort(), ["bank-run", "price-shock"]);
});

test("campaign materialization reuses run-config persona count maps for whale share", async () => {
  const root = await materializationFixtureRoot({
    personas: {
      maker: 4,
      taker: 4,
      liquidator: 2
    }
  });
  const spec = parseCampaignToml(
    materializationCampaignToml(),
    path.join(root, "campaign.toml")
  );

  const plan = await buildCampaignExpansion(spec, { cwd: root, maxRuns: 8 });
  const declaredPersonas = new Set(["maker", "taker", "liquidator"]);

  for (const run of plan.runs) {
    const config = JSON.parse(run.runConfigJson) as {
      agents: number;
      campaign: { sampled_parameters: Record<string, unknown> };
      personas: string[];
    };
    const params = config.campaign.sampled_parameters;
    const whaleShareBps = Number(params.whale_share_bps);
    const expectedConcentratedAgents = Math.max(
      1,
      Math.min(10, Math.round((10 * whaleShareBps) / 10_000))
    );

    assert.equal(config.agents, config.personas.length);
    assert.ok(config.personas.every((persona) => declaredPersonas.has(persona)));
    assert.deepEqual(
      config.personas.slice(0, expectedConcentratedAgents),
      Array.from({ length: expectedConcentratedAgents }, () => "maker")
    );
    assert.ok(config.personas.includes("taker"));
    assert.ok(config.personas.includes("liquidator"));
  }
});

test("campaign expansion determinism: range seed policies stay inside the declared range", async () => {
  const root = await campaignFixtureRoot();
  const spec = parseCampaignToml(
    campaignToml().replace('seed_policy = "fixed:20260426"', 'seed_policy = "range:1000..1002"'),
    path.join(root, "campaign.toml")
  );

  const plan = await buildCampaignExpansion(spec, { cwd: root, maxRuns: 5 });
  for (const run of plan.runs) {
    const seed = BigInt(run.runSeed);
    assert.ok(seed >= 1000n && seed <= 1002n, `seed ${seed} should be inside range`);
  }
});

test("campaign expansion determinism: dry materialization writes generated run configs without executing simulations", async () => {
  const root = await campaignFixtureRoot();
  const spec = parseCampaignToml(campaignToml(), path.join(root, "campaign.toml"));
  const plan = await materializeCampaignExpansion(spec, { cwd: root, maxRuns: 2 });

  const identity = campaignIdentity(spec);
  assert.equal(plan.campaignDigest, identity.campaignDigest);
  assert.equal(plan.runs.length, 2);

  const canonicalBytes = await readFile(path.join(plan.campaignRoot, "campaign-canonical.json"), "utf8");
  assert.equal(canonicalBytes, `${plan.canonicalCampaignJson}\n`);

  for (const run of plan.runs) {
    const bytes = await readFile(run.runConfigPath, "utf8");
    assert.equal(bytes, run.runConfigJson);
    assert.equal(path.dirname(run.runConfigPath), run.runDir);
    assert.ok(run.runConfigPath.includes(path.join(".riptide", "campaigns", plan.campaignId, "runs")));
  }

  const parsedRunConfig = JSON.parse(plan.runs[0]!.runConfigJson) as {
    adapter: string;
    campaign: {
      adapter: string;
      campaign_digest: string;
      run_id: string;
      sampled_parameters: Record<string, unknown>;
      scenario_family: string;
    };
    seed: number;
    output_path: string;
  };
  assert.equal(parsedRunConfig.campaign.campaign_digest, plan.campaignDigest);
  assert.equal(parsedRunConfig.campaign.run_id, plan.runs[0]!.runId);
  assert.equal(parsedRunConfig.campaign.adapter, "fixtures/adapters/lending.toml");
  assert.equal(parsedRunConfig.campaign.scenario_family, "oracle_shock");
  assert.equal(path.isAbsolute(parsedRunConfig.adapter), false);
  const resolvedAdapter = path.resolve(
    path.dirname(plan.runs[0]!.runConfigPath),
    parsedRunConfig.adapter
  );
  assert.equal(resolvedAdapter, spec.adapter.resolved);
  assert.equal(await readFile(resolvedAdapter, "utf8"), "# lending adapter fixture\n");
  assert.equal(typeof parsedRunConfig.seed, "number");
  assert.ok(parsedRunConfig.output_path.includes(plan.runs[0]!.runId));
});

test("campaign expansion determinism: missing scenario templates fail dry expansion", async () => {
  const root = await campaignFixtureRoot();
  const spec = parseCampaignToml(
    campaignToml().replace(
      'source = "fixtures/scenarios/lending/oracle-lag-baseline"',
      'source = "fixtures/scenarios/lending/missing-template"'
    ),
    path.join(root, "campaign.toml")
  );

  await assert.rejects(
    buildCampaignExpansion(spec, { cwd: root, maxRuns: 1 }),
    /campaign scenario template not found/
  );
});

async function campaignFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-campaign-expansion-"));
  await mkdir(path.join(root, "fixtures", "adapters"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "personas"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline"), {
    recursive: true
  });
  await writeFile(
    path.join(root, "fixtures", "adapters", "lending.toml"),
    "# lending adapter fixture\n",
    "utf8"
  );
  await writeFile(path.join(root, "fixtures", "personas", "whale.toml"), "", "utf8");
  await writeFile(
    path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline", "run-config.json"),
    JSON.stringify(
      {
        agents: 1,
        ticks: 20,
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
  return root;
}

async function materializationFixtureRoot(options: { personas?: unknown } = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-campaign-materialization-"));
  await mkdir(path.join(root, "fixtures", "adapters"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "personas"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "scenarios", "lending", "stress"), {
    recursive: true
  });
  await writeFile(
    path.join(root, "fixtures", "adapters", "lending.toml"),
    "# lending adapter fixture\n",
    "utf8"
  );
  await writeFile(path.join(root, "fixtures", "personas", "whale.toml"), "", "utf8");
  await writeFile(path.join(root, "fixtures", "personas", "steady-lp.toml"), "", "utf8");
  await writeFile(
    path.join(root, "fixtures", "scenarios", "lending", "stress", "run-config.json"),
    JSON.stringify(
      {
        agents: 10,
        ticks: 20,
        scenario: "price-shock",
        personas: options.personas ?? Array.from({ length: 10 }, () => "steady-lp"),
        validator_url: "unused",
        output_path: "template-output"
      },
      null,
      2
    ),
    "utf8"
  );
  return root;
}

function campaignToml(): string {
  return `
[campaign]
name = "unit-campaign"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 5
seed_policy = "fixed:20260426"

[campaign.scenarios]
selection = "weighted"
families = ["oracle_shock"]

[campaign.scenarios.oracle_shock]
source = "fixtures/scenarios/lending/oracle-lag-baseline"
weight = 1
parameters = ["shock_profile"]

[campaign.personas]
base = "fixtures/personas"
families = ["retail_borrowers"]

[campaign.personas.retail_borrowers]
source = "whale.toml"
count = "borrower_count"

[campaign.parameters.shock_profile]
distribution = "fixed"
value = "price-shock"

[campaign.parameters.borrower_count]
distribution = "fixed"
value = 2
`;
}

function materializationCampaignToml(): string {
  return `
[campaign]
name = "materialization-campaign"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 16
seed_policy = "fixed:20260426"

[campaign.scenarios]
selection = "weighted"
families = ["stress"]

[campaign.scenarios.stress]
source = "fixtures/scenarios/lending/stress"
weight = 1
parameters = ["shock_profile", "oracle_lag_ticks", "whale_share_bps"]

[campaign.personas]
base = "fixtures/personas"
families = []

[campaign.parameters.shock_profile]
distribution = "discrete"
values = ["price-shock", "bank-run"]
weights = [1, 1]

[campaign.parameters.oracle_lag_ticks]
distribution = "discrete"
values = [0, 2, 4]
weights = [1, 1, 1]
unit = "ticks"

[campaign.parameters.whale_share_bps]
distribution = "discrete"
values = [500, 3000]
weights = [1, 1]
unit = "bps"
`;
}
