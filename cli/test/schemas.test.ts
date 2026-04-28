import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import TOML from "toml";

import { validateAdapter } from "../src/schemas/adapter.js";

async function readToml(relativeToRepo: string): Promise<unknown> {
  const raw = await readFile(path.resolve(process.cwd(), "..", relativeToRepo), "utf8");
  return TOML.parse(raw);
}

test("schemas: adapter schema accepts shared semantics breadth fixture", async () => {
  const raw = await readToml("engine/tests/fixtures/semantics-breadth-demo.toml");
  const adapter = validateAdapter(raw, "engine/tests/fixtures/semantics-breadth-demo.toml");
  const semantics = adapter.semantics;

  assert.ok(semantics);
  assert.equal(semantics.class, "lending.v1");
  assert.equal(semantics.oracles.oracle.length, 2);
  assert.equal(semantics.oracles.oracle[0]?.weight, 60);
  assert.equal(semantics.oracles.oracle[1]?.program_id, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.equal(semantics.collections.worst_health_factor?.formula, "worst");
  assert.equal(semantics.collections.worst_health_factor?.over, "reserves");
  assert.equal(semantics.replay?.state_source, "fixture");
  assert.equal(semantics.replay?.slot, 123456789);
  assert.equal(Object.keys(semantics.replay?.roles ?? {}).length, 4);
});

test("schemas: adapter schema accepts mainnet-rpc replay at parse time", async () => {
  const raw = await readFile(
    path.resolve(process.cwd(), "..", "engine/tests/fixtures/semantics-breadth-demo.toml"),
    "utf8"
  );
  const parsed = TOML.parse(raw.replace('state_source = "fixture"', 'state_source = "mainnet-rpc"'));
  const adapter = validateAdapter(parsed, "mainnet-rpc.toml");

  assert.equal(adapter.semantics?.replay?.state_source, "mainnet-rpc");
});

test("schemas: legacy semantics adapter keeps new breadth fields empty", async () => {
  const raw = await readToml("fixtures/adapters/lending.toml");
  const legacy = structuredClone(raw) as {
    semantics?: { oracles?: unknown; collections?: unknown; replay?: unknown };
  };
  delete legacy.semantics?.oracles;
  delete legacy.semantics?.collections;
  delete legacy.semantics?.replay;
  const adapter = validateAdapter(legacy, "fixtures/adapters/lending.toml");
  const semantics = adapter.semantics;

  assert.ok(semantics);
  assert.deepEqual(semantics.oracles, {});
  assert.deepEqual(semantics.collections, {});
  assert.equal(semantics.replay, undefined);
});

test("schemas: malformed semantics breadth blocks have typed diagnostics", async () => {
  const raw = await readFile(
    path.resolve(process.cwd(), "..", "engine/tests/fixtures/semantics-breadth-demo.toml"),
    "utf8"
  );

  assert.throws(
    () =>
      validateAdapter(
        TOML.parse(raw.replace("[[semantics.oracles.oracle]]", "[[semantics.oracles.price_feed]]")),
        "bad-oracle-role.toml"
      ),
    /UnknownOracleRole/
  );
  assert.throws(
    () =>
      validateAdapter(
        TOML.parse(raw.replace("formula = \"worst\"", "formula = \"median\"")),
        "bad-formula.toml"
      ),
    /UnknownCollectionFormula/
  );
  assert.throws(
    () =>
      validateAdapter(
        TOML.parse(raw.replace("over = \"reserves\"", "over = \"vaults\"")),
        "bad-collection-role.toml"
      ),
    /UnknownCollectionRole/
  );
  assert.throws(
    () =>
      validateAdapter(
        TOML.parse(raw.replace("state_source = \"fixture\"", "state_source = \"archive\"")),
        "bad-replay-source.toml"
      ),
    /UnknownReplayStateSource/
  );
  assert.throws(
    () =>
      validateAdapter(
        TOML.parse(raw.replace("pack_path = \"state-packs/semantics-breadth-demo\"\n", "")),
        "missing-pack.toml"
      ),
    /MissingReplayPackPath/
  );
  assert.throws(
    () =>
      validateAdapter(
        TOML.parse(raw.replace("weight = 60", "weight = 0").replace("weight = 40", "weight = 0")),
        "zero-weights.toml"
      ),
    /MultiOracleWeightsAllZero/
  );
  assert.throws(
    () =>
      validateAdapter(
        TOML.parse(
          raw.replace(
            'program_id = "11111111111111111111111111111111"',
            'program_id = "22222222222222222222222222222222"'
          )
        ),
        "bad-pubkey.toml"
      ),
    /decoded to .* bytes/
  );
});
