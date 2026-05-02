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
    "shock_bps",
    "borrower_count",
    "deposit_scale",
    "borrow_scale",
    "fixed_one"
  ]);
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
parameters = ["shock_bps"]

[campaign.personas]
base = "fixtures/personas"
families = ["retail_borrowers"]

[campaign.personas.retail_borrowers]
source = "whale.toml"
count = "borrower_count"
scale_deposits_by = "deposit_scale"
scale_borrows_by = "borrow_scale"

[campaign.parameters.shock_bps]
distribution = "uniform"
min = 100
max = 500
integer = true
unit = "bps"

[campaign.parameters.borrower_count]
distribution = "fixed"
value = 2

[campaign.parameters.deposit_scale]
distribution = "fixed"
value = 1

[campaign.parameters.borrow_scale]
distribution = "fixed"
value = 0
`;
}
