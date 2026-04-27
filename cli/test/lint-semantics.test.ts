import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAdapt } from "../src/commands/adapt.js";
import { runLint } from "../src/commands/lint.js";
import { lintSemantics } from "../src/lint/semantics.js";
import type { Adapter, Semantics } from "../src/schemas/adapter.js";
import type { SmokeTestResult } from "../src/adapt/smoke.js";

const BASE_SEMANTICS: Semantics = {
  class: "lending.v1",
  roles: {
    position: {
      source: "instruction.deposit_or_borrow",
      fields: {
        collateral_amount: "u128",
        debt_amount: "u128",
      },
    },
    reserve: {
      source: "account.reserve",
      fields: {
        collateral_decimals: "u64",
        collateral_price: "u128",
        max_ltv_bps: "u64",
      },
    },
    oracle: {
      source: "account.oracle",
      fields: {
        price: "u128",
        confidence: "u128",
      },
    },
    liquidation_config: {
      source: "account.reserve",
      fields: {
        liquidation_threshold_bps: "u64",
      },
    },
  },
  derived: {
    collateral_value: "position.collateral_amount * reserve.collateral_price",
    debt_value: "position.debt_amount",
    max_borrow_value: "collateral_value * reserve.max_ltv_bps / 10000",
    health_factor: "collateral_value / max(debt_value, 1)",
  },
  invariants: [
    {
      name: "bad_debt_bound",
      expr: "debt_value <= collateral_value",
      severity: "warn",
    },
    {
      name: "ltv_below_max",
      expr: "debt_value <= max_borrow_value",
      severity: "warn",
    },
  ],
  extensions: {},
};

const STUB_PASS: SmokeTestResult = {
  passed: true,
  engineExitCode: 0,
  engineStderr: "",
  reason: "stubbed pass",
  outputPath: "/tmp/stub.json",
};

function baseAdapter(semantics: Semantics = BASE_SEMANTICS): Adapter {
  return {
    protocol: "lending",
    instructions: {
      deposit: { action: "deposit", amount: "amount", args: {} },
      borrow: { action: "borrow", amount: "amount", args: {} },
      repay: { action: "repay", amount: "amount", args: {} },
      withdraw: { action: "withdraw", amount: "amount", args: {} },
      liquidate: { action: "liquidate", amount: "repay_amount", args: {} },
    },
    state_mapping: {
      "pool.total_deposits": "tvl",
      "pool.total_borrows": "debt",
      "pool.bad_debt": "bad_debt",
      "position.collateral": "collateral",
      "position.debt": "debt",
      "position.liquidated": "liquidated",
    },
    accounts: {},
    actions: {},
    observations: {},
    personas: {},
    invariants: [],
    oracles: [],
    scheduled_actions: [],
    semantics,
    errors: [],
  };
}

function cloneSemantics(): Semantics {
  return structuredClone(BASE_SEMANTICS);
}

function findingCodes(findings: ReturnType<typeof lintSemantics>): string[] {
  return findings.map((finding) => finding.code);
}

test("semantics lint: clean migrated lending adapter exits 0", async () => {
  const fixturesRoot = path.resolve(process.cwd(), "..", "fixtures");
  const repoRoot = path.resolve(process.cwd(), "..");
  let out = "";
  let err = "";
  const exit = await runLint(
    "lending",
    {},
    {
      fixturesRoot,
      repoRoot,
      stdoutWrite: (chunk) => {
        out += chunk;
      },
      stderrWrite: (chunk) => {
        err += chunk;
      },
      color: false,
    }
  );

  assert.equal(exit, 0, `expected exit 0. stderr:\n${err}\nstdout:\n${out}`);
  assert.match(out, /semantics-clean/);
  assert.match(out, /Verdict: PASS/);
});

test("semantics lint: missing required role fails with next step", () => {
  const semantics = cloneSemantics();
  delete semantics.roles.oracle;

  const findings = lintSemantics(baseAdapter(semantics));
  assert.ok(findingCodes(findings).includes("semantics-missing-required-role"));
  assert.match(findings.find((f) => f.code === "semantics-missing-required-role")?.hint ?? "", /Add \[semantics\.roles\.oracle\]/);
});

test("semantics lint: missing required derived observation fails", () => {
  const semantics = cloneSemantics();
  delete semantics.derived.health_factor;

  const findings = lintSemantics(baseAdapter(semantics));
  assert.ok(findingCodes(findings).includes("semantics-missing-required-derived"));
  assert.match(findings.find((f) => f.code === "semantics-missing-required-derived")?.subject ?? "", /health_factor/);
});

test("semantics lint: malformed derived expression fails", () => {
  const semantics = cloneSemantics();
  semantics.derived.health_factor = "collateral_value /";

  const findings = lintSemantics(baseAdapter(semantics));
  assert.ok(findingCodes(findings).includes("semantics-expression-parse-failed"));
  assert.match(findings.find((f) => f.code === "semantics-expression-parse-failed")?.message ?? "", /malformed semantic expression/);
});

test("semantics lint: derived observation cycle names offenders", () => {
  const semantics = cloneSemantics();
  semantics.derived.health_factor = "buffer + 1";
  semantics.derived.buffer = "health_factor + 1";

  const findings = lintSemantics(baseAdapter(semantics));
  const cycle = findings.find((f) => f.code === "semantics-derived-cycle");
  assert.ok(cycle, `expected cycle finding, got ${JSON.stringify(findings, null, 2)}`);
  assert.match(cycle.message, /health_factor/);
  assert.match(cycle.message, /buffer/);
});

test("semantics lint: malformed class string fails", () => {
  const semantics = cloneSemantics();
  semantics.class = "lending_v1";

  const findings = lintSemantics(baseAdapter(semantics));
  assert.ok(findingCodes(findings).includes("semantics-malformed-class"));
  assert.match(findings.find((f) => f.code === "semantics-malformed-class")?.hint ?? "", /lending\.v1/);
});

test("adapt: semantics lint preflight aborts before smoke even without JSON lineage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-semantics-"));
  const adapterPath = path.join(dir, "adapter.toml");
  await writeFile(
    adapterPath,
    `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }
borrow = { action = "borrow", amount = "amount" }
repay = { action = "repay", amount = "amount" }
withdraw = { action = "withdraw", amount = "amount" }
liquidate = { action = "liquidate", amount = "repay_amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"pool.total_borrows" = "debt"
"pool.bad_debt" = "bad_debt"
"position.collateral" = "collateral"
"position.debt" = "debt"
"position.liquidated" = "liquidated"

[actions]
[observations]
[personas]

[semantics]
class = "lending.v1"

[semantics.roles.position]
source = "instruction.deposit_or_borrow"
fields.collateral_amount = "u128"
fields.debt_amount = "u128"

[semantics.roles.reserve]
source = "account.reserve"
fields.collateral_price = "u128"
fields.max_ltv_bps = "u64"

[semantics.roles.oracle]
source = "account.oracle"
fields.price = "u128"
fields.confidence = "u128"

[semantics.roles.liquidation_config]
source = "account.reserve"
fields.liquidation_threshold_bps = "u64"

[semantics.derived]
collateral_value = "position.collateral_amount * reserve.collateral_price"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"
health_factor = "collateral_value /"
`,
    "utf8"
  );

  let smokeInvoked = false;
  const exit = await runAdapt(
    { adapter: adapterPath },
    {
      engineBinary: "/tmp/fake-engine",
      runSmokeTestImpl: async () => {
        smokeInvoked = true;
        return STUB_PASS;
      },
    }
  );

  assert.equal(exit, 2);
  assert.equal(smokeInvoked, false, "smoke must not run after semantics lint failure");
});
