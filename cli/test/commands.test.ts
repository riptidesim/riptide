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

test("commands: root help is compact, ordered for first-hour use, and example-driven", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--help"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /Deterministic Solana simulations, campaigns, and reviewer-ready evidence\./);
  assert.match(stdout, /Start here:/);
  assert.match(stdout, /Advanced\/support:/);
  assert.match(stdout, /Examples:/);
  assert.match(stdout, /riptide run --adapter \.riptide\/adapters\/<program-name>\.toml --seeds 1 --seed-root 1337/);
  assert.match(stdout, /riptide campaign validate \.riptide\/campaigns\/<risk>\.campaign\.toml/);
  assert.match(stdout, /riptide <command> --help/);
  assert.doesNotMatch(stdout, /complete protocol safety/i);

  const ordered = [
    "init",
    "readiness",
    "campaign",
    "run",
    "review",
    "doctor"
  ].map((command) => {
    const index = stdout.indexOf(`  ${command}`);
    assert.notEqual(index, -1, `${command} missing from root help:\n${stdout}`);
    return index;
  });
  assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);

  assert.ok(stdout.split("\n").length < 80, stdout);
});

test("scenarios prints the stub list", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "scenarios"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /baseline/);
  assert.match(stdout, /price-shock/);
});

test("scenarios catalog prints the public family catalog", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "scenarios", "catalog"],
    { cwd: process.cwd() }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /Riptide Scenario Family Catalog/);
  assert.match(stdout, /Total families: 25/);
  assert.match(stdout, /lending \(Lending, 5 families\)/);
  assert.match(stdout, /stablecoin \(Stablecoin, 5 families\)/);
  assert.match(stdout, /liquid-staking \(Liquid Staking, 5 families\)/);
  assert.match(stdout, /perpetuals \(Perpetuals, 5 families\)/);
  assert.match(stdout, /amm \(AMM, 5 families\)/);
  assert.equal(stdout.match(/claim_level=/g)?.length, 25);
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

test("campaign materialization expansion: plan output exposes run coordinates and sampled parameters", async () => {
  const campaignPath = path.resolve(
    process.cwd(),
    "..",
    "fixtures",
    "campaigns",
    "lending",
    "solend-shape-liquidation-safety",
    "campaign.toml"
  );
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-campaign-plan-output-"));

  const human = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "campaign", "plan", campaignPath, "--max-runs", "1", "--out", outRoot],
    { cwd: path.resolve(process.cwd(), "..") }
  );
  assert.match(human.stdout, /planned run coordinates:/);
  assert.match(
    human.stdout,
    /run_000000_[a-f0-9]{12}: seed=\d+ family=oracle_lag_baseline params=shock_profile=price-shock, oracle_lag_ticks=2/
  );

  const json = await execFileAsync(
    process.execPath,
    [
      cliEntrypoint,
      "campaign",
      "plan",
      campaignPath,
      "--max-runs",
      "1",
      "--out",
      outRoot,
      "--json"
    ],
    { cwd: path.resolve(process.cwd(), "..") }
  );
  const parsed = JSON.parse(json.stdout) as {
    plan: {
      runs: Array<{
        run_id: string;
        run_seed: string;
        scenario_family: string;
        sampled_parameters: Record<string, unknown>;
      }>;
    };
  };
  assert.equal(parsed.plan.runs[0]?.run_id.startsWith("run_000000_"), true);
  assert.match(parsed.plan.runs[0]?.run_seed ?? "", /^\d+$/);
  assert.equal(parsed.plan.runs[0]?.scenario_family, "oracle_lag_baseline");
  assert.deepEqual(parsed.plan.runs[0]?.sampled_parameters, {
    shock_profile: "price-shock",
    oracle_lag_ticks: 2
  });
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
  assert.match(runHelp.stdout, /--serve/);
  assert.match(runHelp.stdout, /--json/);
  assert.match(runHelp.stdout, /existing riptide run\s+path/i);
});

test("campaign commands: run --serve fails intentionally with a useful message", async () => {
  let stderr = "";
  let code: number | string | undefined;
  try {
    await execFileAsync(
      process.execPath,
      [cliEntrypoint, "campaign", "run", "campaign.toml", "--serve"],
      { cwd: process.cwd() }
    );
  } catch (err) {
    const execErr = err as { stderr?: string; code?: number | string };
    stderr = execErr.stderr ?? "";
    code = execErr.code;
  }

  assert.equal(code, 2);
  assert.match(stderr, /campaign run --serve is not supported yet/);
  assert.match(stderr, /riptide review <campaign-root>/);
  assert.match(stderr, /riptide run --serve/);
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
value = 1
`;
}
