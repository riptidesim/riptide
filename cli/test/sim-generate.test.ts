import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateSim } from "../src/sim/generate.js";
import { renderTypes } from "../src/sim/render-types.js";

test("sim generate writes a guided Rust crate from the AMM IDL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-gen-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");

  const result = await generateSim(root, {
    adapter,
    dir: ".riptide/sim"
  });

  const cargoToml = await readFile(result.manifestPath, "utf8");
  const mainRs = await readFile(path.join(result.dir, "src", "main.rs"), "utf8");
  const typesRs = await readFile(path.join(result.dir, "src", "types.rs"), "utf8");
  const accountsRs = await readFile(path.join(result.dir, "src", "accounts.rs"), "utf8");
  const flowsRs = await readFile(path.join(result.dir, "src", "flows.rs"), "utf8");
  const bootstrapToml = await readFile(result.bootstrapManifestPath, "utf8");

  assert.match(cargoToml, /riptide-sim = \{ path = /);
  assert.match(cargoToml, /riptide-sim-macros = \{ path = /);
  assert.match(cargoToml, /borsh = \{ version = "1\.6\.1"/);
  assert.match(mainRs, /#\[riptide_sim\]/);
  assert.match(mainRs, /apply_manifest_if_exists\("Riptide\.toml"\)/);
  assert.match(mainRs, /load_program_from_so/);
  assert.match(typesRs, /pub struct AddLiquidityInstructionData/);
  assert.match(typesRs, /pub fn add_liquidity\(program_id: Pubkey\) -> AddLiquidityBuilder/);
  assert.match(typesRs, /remaining_accounts/);
  assert.match(accountsRs, /pub pool: AddressStorage/);
  assert.match(accountsRs, /pub lp_position: AddressStorage/);
  assert.match(flowsRs, /pub fn guided_flow/);
  assert.match(bootstrapToml, /\[\[sim\.fork\]\]/);
  assert.match(bootstrapToml, /Protocol-specific layouts stay in your/);
});

test("sim generate uses fixed-address program load when adapter declares program_id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-fixed-program-"));
  const repoRoot = path.resolve(process.cwd(), "..");
  const sourceAdapter = await readFile(path.join(repoRoot, "fixtures", "adapters", "amm.toml"), "utf8");
  const programId = "CwvZXfji8FDrzbKnBozHWJ4PkKULYwDvn7UrYCiBDXvu";
  const adapterPath = path.join(root, "amm-fixed.toml");
  const adapter = sourceAdapter
    .replace(
      /^protocol = "generic"$/m,
      `protocol = "generic"\nprogram_id = "${programId}"`
    )
    .replace(
      'program_so = "../../programs/amm/target/deploy/amm.so"',
      `program_so = ${JSON.stringify(path.join(repoRoot, "programs", "amm", "target", "deploy", "amm.so"))}`
    )
    .replace(
      'idl_path = "../idls/amm.json"',
      `idl_path = ${JSON.stringify(path.join(repoRoot, "fixtures", "idls", "amm.json"))}`
    );
  await writeFile(adapterPath, adapter, "utf8");

  const result = await generateSim(root, {
    adapter: adapterPath,
    dir: ".riptide/sim"
  });
  const mainRs = await readFile(path.join(result.dir, "src", "main.rs"), "utf8");

  assert.match(mainRs, new RegExp(`const PROGRAM_ID: &str = "${programId}"`));
  assert.match(mainRs, /add_program_from_so\(program_id,/);
  assert.doesNotMatch(mainRs, /load_program_from_so/);
});

test("sim refresh preserves user-owned flow files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-refresh-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");

  const result = await generateSim(root, { adapter, dir: ".riptide/sim" });
  const flowPath = path.join(result.dir, "src", "flows.rs");
  const userFlow = "pub fn marker() {}\n";
  await writeFile(flowPath, userFlow, "utf8");

  await generateSim(root, {
    adapter,
    dir: ".riptide/sim",
    regenTypesOnly: true
  });

  assert.equal(await readFile(flowPath, "utf8"), userFlow);
});

test("sim generate rejects bundled lending adapters without an IDL path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-lending-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "lending.toml");

  await assert.rejects(
    () => generateSim(root, { adapter, dir: ".riptide/sim" }),
    /IDL-backed generic adapter/
  );
});

test("sim generated builders fail loudly for unsupported IDL args", () => {
  const rendered = renderTypes({
    instructions: [
      {
        name: "configureRisk",
        discriminator: [1],
        accounts: [],
        args: [{ name: "config", type: { defined: "RiskConfig" } }]
      }
    ],
    accounts: [],
    types: []
  });

  assert.match(rendered, /pub config: UnsupportedIdlArg,/);
  assert.match(
    rendered,
    /UnsupportedIdlArg::new\("config has unsupported IDL type/
  );
  assert.doesNotMatch(rendered, /pub config: \(\),/);
});

test("built CLI carries vendored guided sim runtime crates for packaged installs", async () => {
  const runtimeRoot = path.resolve(process.cwd(), "dist", "sim-runtime");

  assert.match(
    await readFile(path.join(runtimeRoot, "riptide-sim", "Cargo.toml"), "utf8"),
    /name = "riptide-sim"/
  );
  assert.match(
    await readFile(path.join(runtimeRoot, "riptide-sim-macros", "Cargo.toml"), "utf8"),
    /name = "riptide-sim-macros"/
  );
  assert.match(await readFile(path.join(runtimeRoot, "Cargo.lock"), "utf8"), /riptide-sim/);
});
