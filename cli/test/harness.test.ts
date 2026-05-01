import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateHarness } from "../src/commands/harness.js";

test("harness generate writes a Rust crate with adapter account hints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-harness-gen-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");

  const result = await generateHarness(root, {
    adapter,
    dir: ".riptide/harness",
    name: "demo-harness"
  });

  const cargoToml = await readFile(result.manifestPath, "utf8");
  const mainRs = await readFile(path.join(result.dir, "src", "main.rs"), "utf8");

  assert.match(cargoToml, /name = "demo-harness"/);
  assert.match(cargoToml, /riptide-engine = /);
  assert.match(mainRs, /impl RiptideHarness for ProjectHarness/);
  assert.match(mainRs, /ctx\.require_declared_account\("pool"\)\?/);
  assert.match(mainRs, /ctx\.require_declared_account\("lp_position"\)\?/);
});

test("harness generate rejects non-generic adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-harness-lending-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "lending.toml");

  await assert.rejects(
    () => generateHarness(root, { adapter, dir: ".riptide/harness" }),
    /generic SBF\/IDL adapters/
  );
});
