// Floor Invariants in generated sims: `sim generate --json` names the adapter's
// family and wires each of that family's Floor Invariants into the sim crate's
// invariant check and its Firing Check declarations. Driven through the runner
// against the fixture adapters, plus derivable-adapter variants for the lending
// family and the generic fallback.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CommandIO } from "../src/contract/index.js";
import { runSimGenerate } from "../src/commands/sim.js";

const FIXTURES = path.resolve(process.cwd(), "..", "fixtures");
const DERIVABLE = path.join(FIXTURES, "auto-genesis", "derivable");

interface FloorInvariants {
  family: string;
  invariants: Array<{ id: string; wired: boolean; expr: string }>;
}

interface Generated {
  floors: FloorInvariants;
  invariantsRs: string;
  violationsRs: string;
}

async function generate(adapter: string): Promise<Generated> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-floor-"));
  let stdout = "";
  const exitCode = await runSimGenerate(
    { adapter, json: true },
    {
      cwd,
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      stderrWrite: () => {}
    } satisfies CommandIO
  );
  const envelope = JSON.parse(stdout) as { ok: boolean; data: { floor_invariants: FloorInvariants } };
  assert.equal(exitCode, 0, stdout);
  assert.equal(envelope.ok, true);
  const src = path.join(cwd, ".riptide", "sim", "src");
  return {
    floors: envelope.data.floor_invariants,
    invariantsRs: await readFile(path.join(src, "invariants.rs"), "utf8"),
    violationsRs: await readFile(path.join(src, "violations.rs"), "utf8")
  };
}

/** The invariants `invariants.rs` evaluates, by name and expression. */
function checked(invariantsRs: string): Map<string, string> {
  return new Map(
    [...invariantsRs.matchAll(/descriptor\.invariant\("([^"]+)", "((?:[^"\\]|\\.)*)"/g)].map((match) => [
      match[1]!,
      match[2]!
    ])
  );
}

/** The invariants `violations.rs` declares a Firing Check for. */
function firingChecks(violationsRs: string): string[] {
  return [...violationsRs.matchAll(/FiringCheck::new\(\s+"([^"]+)"/g)].map((match) => match[1]!);
}

/** The derivable fixture adapter with a `[semantics]` block appended, paths made absolute. */
async function derivableWith(semantics: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-floor-adapter-"));
  const source = (await readFile(path.join(DERIVABLE, "adapter.toml"), "utf8"))
    .replace(/^program_so = "(.+)"$/m, (_, rel: string) => `program_so = ${JSON.stringify(path.join(DERIVABLE, rel))}`)
    .replace(/^idl_path = "(.+)"$/m, (_, rel: string) => `idl_path = ${JSON.stringify(path.join(DERIVABLE, rel))}`)
    .replace(/^\[lineage\][\s\S]*$/m, "");
  const adapter = path.join(dir, "adapter.toml");
  await writeFile(adapter, `${source}\n${semantics}`, "utf8");
  return adapter;
}

const LENDING_SEMANTICS = `[semantics]
class = "lending.v1"

[semantics.roles.position]
source = "account.ledger"
fields.contributed = "u64"

[semantics.roles.reserve]
source = "account.treasury"
fields.total = "u64"

[semantics.roles.oracle]
source = "account.treasury"
fields.contributors = "u64"

[semantics.roles.liquidation_config]
source = "account.treasury"
fields.contributors = "u64"

[semantics.derived]
collateral_value = "reserve.total"
debt_value = "position.contributed"
max_borrow_value = "collateral_value * 8 / 10"
health_factor = "collateral_value / max(debt_value, 1)"
`;

const TOKEN_SEMANTICS = `[semantics]
class = "token.v1"

[semantics.roles.source_account]
source = "account.ledger"
fields.contributed = "u64"

[semantics.roles.destination_account]
source = "account.treasury"
fields.total = "u64"

[semantics.roles.mint]
source = "account.treasury"
fields.contributors = "u64"

[semantics.derived]
source_balance = "source_account.contributed"
destination_balance = "destination_account.total"
mint_supply = "mint.contributors"
`;

test("sim generate --json: each family's Floor Invariants are wired into the generated sim", async () => {
  const cases: Array<[string, string, string[]]> = [
    [path.join(FIXTURES, "adapters", "amm.toml"), "amm", ["constant_product_positive"]],
    [path.join(FIXTURES, "adapters", "perpetuals.toml"), "perps", ["equity_above_maintenance"]],
    [path.join(FIXTURES, "adapters", "liquid-staking.toml"), "lst", ["lst_supply_backed"]],
    [path.join(FIXTURES, "adapters", "stablecoin.toml"), "stablecoin", ["collateral_covers_liabilities"]],
    [await derivableWith(LENDING_SEMANTICS), "lending", ["debt_below_collateral", "debt_below_max_borrow"]],
    [await derivableWith(TOKEN_SEMANTICS), "generic", ["supply_covers_balances"]]
  ];
  for (const [adapter, family, ids] of cases) {
    const { floors, invariantsRs, violationsRs } = await generate(adapter);
    assert.equal(floors.family, family, adapter);
    assert.deepEqual(
      floors.invariants.map((floor) => [floor.id, floor.wired]),
      ids.map((id) => [id, true]),
      family
    );
    const evaluated = checked(invariantsRs);
    for (const floor of floors.invariants) {
      assert.equal(evaluated.get(floor.id), floor.expr, `${family}: invariants.rs does not check ${floor.id}`);
    }
    const declared = firingChecks(violationsRs);
    for (const id of ids) {
      assert.ok(declared.includes(id), `${family}: violations.rs declares no Firing Check for ${id}`);
    }
    assert.match(violationsRs, /\/\/ Floor Invariant: /);
  }
});

test("sim generate --json: an adapter's own invariant named for a Floor Invariant adapts it rather than duplicating it", async () => {
  const adapter = await derivableWith(
    `${LENDING_SEMANTICS}
[[semantics.invariants]]
name = "debt_below_collateral"
expr = "debt_value * 10000 <= collateral_value * 10000"
severity = "warn"
`
  );
  const { floors, invariantsRs, violationsRs } = await generate(adapter);

  const adapted = floors.invariants.find((floor) => floor.id === "debt_below_collateral");
  assert.deepEqual(adapted, {
    id: "debt_below_collateral",
    wired: true,
    expr: "debt_value * 10000 <= collateral_value * 10000"
  });
  assert.equal(checked(invariantsRs).get("debt_below_collateral"), adapted!.expr);
  assert.equal(firingChecks(violationsRs).filter((id) => id === "debt_below_collateral").length, 1);
  assert.equal([...invariantsRs.matchAll(/descriptor\.invariant\("debt_below_collateral"/g)].length, 1);
});

test("sim generate --json: an adapter with no [semantics] gets the generic Floor Invariant as an unwired Firing Check", async () => {
  const { floors, invariantsRs, violationsRs } = await generate(path.join(DERIVABLE, "adapter.toml"));

  assert.deepEqual(floors, {
    family: "generic",
    invariants: [
      {
        id: "supply_covers_balances",
        wired: false,
        expr: "source_balance + destination_balance <= mint_supply"
      }
    ]
  });
  assert.equal(checked(invariantsRs).size, 0);
  assert.deepEqual(firingChecks(violationsRs), ["supply_covers_balances"]);
  assert.match(violationsRs, /"Floor Invariant not wired"/);
  assert.match(violationsRs, /declare \[semantics\] with class = \\"token\.v1\\"/);
});
