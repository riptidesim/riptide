import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  CampaignValidationError,
  parseCampaignToml,
  type CampaignDiagnostic
} from "../src/campaign/index.js";

function validCampaignToml(overrides = ""): string {
  return `
[campaign]
name = "unit-campaign"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 3
seed_policy = "fixed:20260426"
replay_retention = ["first_failure", "median"]
${overrides}

[campaign.scenarios]
selection = "weighted"
families = ["oracle_shock"]

[campaign.scenarios.oracle_shock]
source = "fixtures/scenarios/lending/oracle-lag-baseline"
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
value = 2
`;
}

test("campaign schema: accepts a valid minimal Campaign TOML v1", () => {
  const filePath = path.resolve("/tmp/riptide-campaign-tests/campaign.toml");
  const spec = parseCampaignToml(validCampaignToml(), filePath);

  assert.equal(spec.name, "unit-campaign");
  assert.equal(spec.semanticClass, "lending.v1");
  assert.equal(spec.riskObjective, "liquidation-safety");
  assert.equal(spec.runBudget, 3);
  assert.deepEqual(spec.replayRetention, ["first_failure", "median"]);
  assert.equal(spec.adapter.resolved, path.resolve(path.dirname(filePath), "fixtures/adapters/lending.toml"));
  assert.equal(spec.adapter.digestPath, "fixtures/adapters/lending.toml");
  assert.equal(spec.scenarios.definitions.oracle_shock?.weight, 1);
  assert.equal(spec.personas.definitions.retail_borrowers?.scaleDepositsBy, "fixed_one");
  assert.equal(spec.parameters.fixed_one?.distribution, "fixed");
});

test("campaign schema: rejects missing required sections", () => {
  const toml = `
[campaign]
name = "missing-sections"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 1
seed_policy = "expanding"
`;

  const diagnostics = diagnosticsFor(toml);
  assertHasDiagnostic(diagnostics, "campaign.scenarios", /missing required table/);
  assertHasDiagnostic(diagnostics, "campaign.personas", /missing required table/);
  assertHasDiagnostic(diagnostics, "campaign.parameters", /missing required table/);
});

test("campaign schema: rejects invalid seed policies", () => {
  const diagnostics = diagnosticsFor(validCampaignToml().replace(
    'seed_policy = "fixed:20260426"',
    'seed_policy = "range:200..100"'
  ));

  assertHasDiagnostic(diagnostics, "campaign.seed_policy", /start must be <= end/);
});

test("campaign schema: rejects malformed distribution-specific fields", () => {
  const diagnostics = diagnosticsFor(`
[campaign]
name = "bad-distribution"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 1
seed_policy = "expanding"

[campaign.scenarios]
selection = "weighted"
families = ["oracle_shock"]

[campaign.scenarios.oracle_shock]
source = "fixtures/scenarios/lending/oracle-lag-baseline"
parameters = ["shock_bps"]

[campaign.personas]
base = "fixtures/personas"
families = ["retail_borrowers"]

[campaign.personas.retail_borrowers]
source = "whale.toml"
count = "borrower_count"

[campaign.parameters.shock_bps]
distribution = "uniform"
min = 500
max = 100
values = [1, 2]

[campaign.parameters.borrower_count]
distribution = "discrete"
values = [1, 2]
weights = [1]
`);

  assertHasDiagnostic(diagnostics, "campaign.parameters.shock_bps.values", /unknown key/);
  assertHasDiagnostic(diagnostics, "campaign.parameters.shock_bps.max", /greater than or equal/);
  assertHasDiagnostic(diagnostics, "campaign.parameters.borrower_count.weights", /length must match/);
});

test("campaign schema: rejects unknown keys and bad family references", () => {
  const diagnostics = diagnosticsFor(`
[campaign]
name = "bad-keys"
adapter = "fixtures/adapters/lending.toml"
class = "lending.v1"
risk_objective = "liquidation-safety"
run_budget = 1
seed_policy = "expanding"
surprise = true

[campaign.scenarios]
selection = "weighted"
families = ["oracle_shock"]

[campaign.scenarios.oracle_shock]
source = "fixtures/scenarios/lending/oracle-lag-baseline"
parameters = ["missing_parameter"]

[campaign.scenarios.unlisted]
source = "fixtures/scenarios/lending/oracle-lag-baseline"

[campaign.personas]
base = "fixtures/personas"
families = ["retail_borrowers"]

[campaign.personas.retail_borrowers]
source = "whale.toml"
count = "borrower_count"

[campaign.personas.extra]
source = "liquidator.toml"
count = "borrower_count"

[campaign.parameters.borrower_count]
distribution = "fixed"
value = 1
`);

  assertHasDiagnostic(diagnostics, "campaign.surprise", /unknown key/);
  assertHasDiagnostic(diagnostics, "campaign.scenarios.unlisted", /unknown key/);
  assertHasDiagnostic(diagnostics, "campaign.personas.extra", /unknown key/);
  assertHasDiagnostic(diagnostics, "campaign.scenarios.oracle_shock.parameters", /missing_parameter/);
});

test("campaign schema: rejects bad retention labels", () => {
  const diagnostics = diagnosticsFor(validCampaignToml().replace(
    'replay_retention = ["first_failure", "median"]',
    'replay_retention = ["first_failure", "worst_magic", "first_failure"]'
  ));

  assertHasDiagnostic(diagnostics, "campaign.replay_retention[1]", /unsupported retention label/);
  assertHasDiagnostic(diagnostics, "campaign.replay_retention[2]", /duplicate retention label/);
});

function diagnosticsFor(toml: string): CampaignDiagnostic[] {
  try {
    parseCampaignToml(toml, "/tmp/riptide-campaign-tests/campaign.toml");
  } catch (err) {
    assert.ok(err instanceof CampaignValidationError);
    return err.diagnostics;
  }
  assert.fail("expected campaign validation to fail");
}

function assertHasDiagnostic(
  diagnostics: CampaignDiagnostic[],
  diagnosticPath: string,
  message: RegExp
): void {
  assert.ok(
    diagnostics.some(
      (diagnostic) => diagnostic.path === diagnosticPath && message.test(diagnostic.message)
    ),
    `expected diagnostic ${diagnosticPath} ${message}, got ${JSON.stringify(diagnostics)}`
  );
}
