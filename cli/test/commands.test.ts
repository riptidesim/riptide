import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

test("root version matches package metadata", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--version"], {
    cwd: process.cwd()
  });
  const packageJson = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
  ) as { version: string };

  assert.equal(stdout.trim(), packageJson.version);
});

test("simulate command is not registered", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--help"], {
    cwd: process.cwd()
  });
  assert.doesNotMatch(stdout, /^\s+simulate\b/m);

  let stderr = "";
  let code: number | string | undefined;
  try {
    await execFileAsync(process.execPath, [cliEntrypoint, "simulate"], {
      cwd: process.cwd()
    });
  } catch (err) {
    const execErr = err as { stderr?: string; code?: number | string };
    stderr = execErr.stderr ?? "";
    code = execErr.code;
  }

  assert.equal(code, 1);
  assert.match(stderr, /unknown command 'simulate'/);
});

test("scenarios prints the stub list", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "scenarios"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /baseline/);
  assert.match(stdout, /price-shock/);
});

test("campaign commands: validate and plan expose stable JSON without executing simulations", async () => {
  const root = await campaignFixtureRoot("commands");
  const campaignPath = path.join(root, "campaign.toml");

  const validate = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "campaign", "validate", campaignPath, "--json"],
    { cwd: root }
  );
  const validateJson = JSON.parse(validate.stdout) as {
    ok: boolean;
    campaign: { name: string; campaign_id: string; campaign_digest: string };
  };
  assert.equal(validateJson.ok, true);
  assert.equal(validateJson.campaign.name, "unit-campaign");
  assert.match(validateJson.campaign.campaign_id, /^campaign_[a-f0-9]{12}$/);
  assert.match(validateJson.campaign.campaign_digest, /^[a-f0-9]{64}$/);
  assert.equal(validate.stderr, "");

  const outRoot = path.join(root, "campaign-output");
  const plan = await execFileAsync(
    process.execPath,
    [
      cliEntrypoint,
      "campaign",
      "plan",
      campaignPath,
      "--max-runs",
      "2",
      "--out",
      outRoot,
      "--json"
    ],
    { cwd: root }
  );
  const planJson = JSON.parse(plan.stdout) as {
    ok: boolean;
    campaign: { campaign_id: string; output_dir: string };
    plan: { planned_runs: number; output_dir: string; scenario_mix: Record<string, number> };
  };
  assert.equal(planJson.ok, true);
  assert.equal(planJson.plan.planned_runs, 2);
  assert.deepEqual(planJson.plan.scenario_mix, { oracle_shock: 2 });
  assert.equal(planJson.plan.output_dir, path.join(outRoot, planJson.campaign.campaign_id));
  assert.equal(planJson.campaign.output_dir, planJson.plan.output_dir);
  await assert.rejects(
    readFile(path.join(planJson.plan.output_dir, "campaign-canonical.json"), "utf8"),
    /ENOENT/
  );
});

test("campaign commands: help documents run controls and bounded evidence language", async () => {
  const campaignHelp = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "campaign", "--help"],
    { cwd: process.cwd() }
  );
  assert.match(campaignHelp.stdout, /not complete protocol safety/i);
  assert.match(campaignHelp.stdout, /\bvalidate\b/);
  assert.match(campaignHelp.stdout, /\bplan\b/);
  assert.match(campaignHelp.stdout, /\brun\b/);

  const runHelp = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "campaign", "run", "--help"],
    { cwd: process.cwd() }
  );
  assert.match(runHelp.stdout, /--max-runs <n>/);
  assert.match(runHelp.stdout, /--out <dir>/);
  assert.match(runHelp.stdout, /--json/);
  assert.match(runHelp.stdout, /existing riptide run\s+path/i);
});

async function campaignFixtureRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `riptide-campaign-${label}-`));
  await mkdir(path.join(root, "fixtures", "adapters"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "personas"), { recursive: true });
  await mkdir(path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline"), {
    recursive: true
  });
  await writeFile(path.join(root, "fixtures", "adapters", "lending.toml"), "", "utf8");
  await writeFile(path.join(root, "fixtures", "personas", "whale.toml"), "", "utf8");
  await writeFile(
    path.join(root, "fixtures", "scenarios", "lending", "oracle-lag-baseline", "run-config.json"),
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
  await writeFile(path.join(root, "campaign.toml"), campaignToml(), "utf8");
  return root;
}

function campaignToml(): string {
  return `
[campaign]
name = "unit-campaign"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 4
seed_policy = "fixed:20260426"
replay_retention = ["first_failure", "median"]

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

[campaign.parameters.shock_bps]
distribution = "uniform"
min = 100
max = 500
integer = true
unit = "bps"

[campaign.parameters.borrower_count]
distribution = "fixed"
value = 1
`;
}
