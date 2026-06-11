import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  generateSim,
  materializeRuntime,
  renderCargoToml,
  runtimeSourceFromRoots
} from "../src/sim/generate.js";
import { loadGenericIdl } from "../src/sim/idl.js";
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
  const typesExtRs = await readFile(path.join(result.dir, "src", "types_ext.rs"), "utf8");
  const bootstrapToml = await readFile(result.bootstrapManifestPath, "utf8");

  assert.match(cargoToml, /riptide-sim = \{ path = "\//);
  assert.match(cargoToml, /riptide-sim-macros = \{ path = "\//);
  assert.doesNotMatch(cargoToml, /vendor\//);
  assert.match(cargoToml, /borsh = \{ version = "1\.6\.1"/);
  assert.match(mainRs, /#\[riptide_sim\]/);
  assert.match(mainRs, /mod types_ext;/);
  assert.match(mainRs, /apply_manifest_if_exists\("Riptide\.toml"\)/);
  assert.match(mainRs, /load_program_from_so/);
  assert.match(typesRs, /pub struct AddLiquidityInstructionData/);
  assert.match(typesRs, /pub fn add_liquidity\(program_id: Pubkey\) -> AddLiquidityBuilder/);
  assert.match(typesRs, /remaining_accounts/);
  assert.match(accountsRs, /pub pool: AddressStorage/);
  assert.match(accountsRs, /pub lp_position: AddressStorage/);
  assert.match(flowsRs, /pub fn guided_flow/);
  assert.match(typesExtRs, /User-owned extension seam/);
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

test("sim generate resolves repo-root-relative runtime paths for .riptide adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-reporoot-"));
  const repoRoot = path.resolve(process.cwd(), "..");
  const sourceAdapter = await readFile(path.join(repoRoot, "fixtures", "adapters", "amm.toml"), "utf8");

  // Lay the adapter out the way `riptide init` + riptide-config do in a user
  // repo: adapter under .riptide/adapters/ with idl_path/program_so written
  // relative to the repo root, not the adapter directory.
  await mkdir(path.join(root, ".riptide", "adapters"), { recursive: true });
  await mkdir(path.join(root, "target", "idl"), { recursive: true });
  await mkdir(path.join(root, "target", "deploy"), { recursive: true });
  const idlSource = await readFile(path.join(repoRoot, "fixtures", "idls", "amm.json"), "utf8");
  await writeFile(path.join(root, "target", "idl", "amm.json"), idlSource, "utf8");
  await writeFile(path.join(root, "target", "deploy", "amm.so"), "", "utf8");
  const adapterPath = path.join(root, ".riptide", "adapters", "amm.toml");
  const adapter = sourceAdapter
    .replace(
      'program_so = "../../programs/amm/target/deploy/amm.so"',
      'program_so = "target/deploy/amm.so"'
    )
    .replace('idl_path = "../idls/amm.json"', 'idl_path = "target/idl/amm.json"');
  await writeFile(adapterPath, adapter, "utf8");

  const result = await generateSim(root, {
    adapter: adapterPath,
    dir: ".riptide/sim"
  });

  assert.equal(result.idlPath, path.join(root, "target", "idl", "amm.json"));
  const mainRs = await readFile(path.join(result.dir, "src", "main.rs"), "utf8");
  assert.match(
    mainRs,
    new RegExp(JSON.stringify(path.join(root, "target", "deploy", "amm.so")).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
  );
});

test("sim refresh preserves user-owned flow files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-refresh-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");

  const result = await generateSim(root, { adapter, dir: ".riptide/sim" });
  const flowPath = path.join(result.dir, "src", "flows.rs");
  const typesExtPath = path.join(result.dir, "src", "types_ext.rs");
  const userFlow = "pub fn marker() {}\n";
  const userTypesExt = "pub fn custom_builder_marker() {}\n";
  await writeFile(flowPath, userFlow, "utf8");
  await writeFile(typesExtPath, userTypesExt, "utf8");

  await generateSim(root, {
    adapter,
    dir: ".riptide/sim",
    regenTypesOnly: true
  });

  assert.equal(await readFile(flowPath, "utf8"), userFlow);
  assert.equal(await readFile(typesExtPath, "utf8"), userTypesExt);
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

test("sim generated builders cover common complex Anchor IDL shapes", () => {
  const rendered = renderTypes({
    instructions: [
      {
        name: "placeOrder",
        discriminator: [1, 2, 3],
        accounts: [],
        args: [
          { name: "args", type: { defined: "PlaceOrderArgs" } },
          { name: "limits", type: { vec: { option: "u128" } } },
          { name: "keys", type: { array: ["publicKey", 2] } }
        ]
      }
    ],
    accounts: [],
    types: [
      {
        name: "PlaceOrderArgs",
        fields: [],
        type: {
          kind: "struct",
          fields: [
            { name: "side", type: { defined: "Side" } },
            { name: "priceLots", type: "i64" },
            { name: "clientOrderId", type: "u64" }
          ],
          variants: []
        }
      },
      {
        name: "Side",
        fields: [],
        type: {
          kind: "enum",
          fields: [],
          variants: [{ name: "Bid", fields: [] }, { name: "Ask", fields: [] }]
        }
      }
    ]
  });

  assert.match(rendered, /pub struct PlaceOrderArgs/);
  assert.match(rendered, /pub enum Side/);
  assert.match(rendered, /pub args: PlaceOrderArgs,/);
  assert.match(rendered, /pub limits: Vec<Option<u128>>,/);
  assert.match(rendered, /pub keys: \[Pubkey; 2\],/);
  assert.doesNotMatch(rendered, /pub args: UnsupportedIdlArg,/);
});

test("sim IDL parser accepts a complex case-study IDL when available", async () => {
  const openbook = path.resolve(
    process.cwd(),
    "..",
    "..",
    "case-studies",
    "protocol-v2",
    "sdk",
    "src",
    "idl",
    "openbook.json"
  );
  const idl = await loadGenericIdl(openbook);
  const rendered = renderTypes(idl);

  assert.match(rendered, /pub struct PlaceOrderArgs/);
  assert.match(rendered, /pub enum Side/);
  assert.match(rendered, /pub bids: Vec<PlaceMultipleOrdersArgs>,/);
  assert.match(rendered, /pub side_option: Option<Side>,/);
});

test("sim IDL parser accepts tuple-style enum variant fields from case-study IDLs", async () => {
  const drift = path.resolve(
    process.cwd(),
    "..",
    "..",
    "case-studies",
    "protocol-v2",
    "sdk",
    "src",
    "idl",
    "drift.json"
  );
  const idl = await loadGenericIdl(drift);
  const rendered = renderTypes(idl);

  assert.match(rendered, /pub enum ModifyOrderId/);
  assert.match(rendered, /UserOrderId\(u8\),/);
  assert.match(rendered, /OrderId\(u32\),/);
  assert.match(rendered, /PlaceAndTake\(bool, u8\),/);
});

test("built CLI carries vendored guided sim runtime crates for packaged installs", async () => {
  const runtimeRoot = path.resolve(process.cwd(), "dist", "sim-runtime");

  const simManifest = await readFile(path.join(runtimeRoot, "riptide-sim", "Cargo.toml"), "utf8");
  assert.match(simManifest, /name = "riptide-sim"/);
  // The bundled runtime must stay closed over relative paths: riptide-sim's
  // only path dep is its sibling macros crate, so the pair builds anywhere
  // the two directories travel together.
  assert.match(simManifest, /riptide-sim-macros = \{ path = "\.\.\/riptide-sim-macros" \}/);
  assert.match(
    await readFile(path.join(runtimeRoot, "riptide-sim-macros", "Cargo.toml"), "utf8"),
    /name = "riptide-sim-macros"/
  );
  assert.match(await readFile(path.join(runtimeRoot, "Cargo.lock"), "utf8"), /riptide-sim/);
});

async function writeFakeRuntimeCrates(root: string): Promise<void> {
  for (const crate of ["riptide-sim", "riptide-sim-macros"]) {
    await mkdir(path.join(root, crate, "src"), { recursive: true });
    await writeFile(path.join(root, crate, "Cargo.toml"), `[package]\nname = "${crate}"\n`, "utf8");
    await writeFile(path.join(root, crate, "src", "lib.rs"), "", "utf8");
  }
}

test("sim runtime source prefers a workspace checkout over the packaged runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-source-"));
  const workspaceRoot = path.join(root, "workspace");
  const packageRoot = path.join(root, "package");
  await writeFakeRuntimeCrates(workspaceRoot);
  await writeFile(path.join(workspaceRoot, "Cargo.toml"), "[workspace]\n", "utf8");
  await writeFile(path.join(workspaceRoot, "Cargo.lock"), "# lock\n", "utf8");
  await writeFakeRuntimeCrates(path.join(packageRoot, "dist", "sim-runtime"));

  const source = runtimeSourceFromRoots(workspaceRoot, packageRoot);
  assert.equal(source?.kind, "workspace");
  assert.equal(source?.simDir, path.join(workspaceRoot, "riptide-sim"));
  assert.equal(source?.macrosDir, path.join(workspaceRoot, "riptide-sim-macros"));
  assert.equal(source?.lockfilePath, path.join(workspaceRoot, "Cargo.lock"));
});

test("sim runtime source falls back to the packaged runtime without a workspace marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-source-"));
  const packageRoot = path.join(root, "package");
  const runtimeDir = path.join(packageRoot, "dist", "sim-runtime");
  await writeFakeRuntimeCrates(runtimeDir);
  await writeFile(path.join(runtimeDir, "Cargo.lock"), "# lock\n", "utf8");

  assert.equal(runtimeSourceFromRoots(undefined, packageRoot)?.kind, "packaged");

  // A Cargo.toml alone is not a workspace marker — the runtime crates must
  // resolve under it too, otherwise the packaged runtime wins.
  const stray = path.join(root, "stray");
  await mkdir(stray, { recursive: true });
  await writeFile(path.join(stray, "Cargo.toml"), "[workspace]\n", "utf8");
  const source = runtimeSourceFromRoots(stray, packageRoot);
  assert.equal(source?.kind, "packaged");
  assert.equal(source?.simDir, path.join(runtimeDir, "riptide-sim"));
  assert.equal(source?.lockfilePath, path.join(runtimeDir, "Cargo.lock"));
});

test("packaged runtime is vendored next to the generated crate with relative path deps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-vendor-"));
  const packageRoot = path.join(root, "package");
  await writeFakeRuntimeCrates(path.join(packageRoot, "dist", "sim-runtime"));
  const source = runtimeSourceFromRoots(undefined, packageRoot);
  assert.ok(source);

  const outDir = path.join(root, "repo", ".riptide", "sim");
  await mkdir(outDir, { recursive: true });
  const paths = await materializeRuntime(outDir, source);

  assert.equal(paths.simPath, "vendor/riptide-sim");
  assert.equal(paths.macrosPath, "vendor/riptide-sim-macros");
  assert.match(
    await readFile(path.join(outDir, "vendor", "riptide-sim", "Cargo.toml"), "utf8"),
    /name = "riptide-sim"/
  );
  assert.match(
    await readFile(path.join(outDir, "vendor", "riptide-sim-macros", "Cargo.toml"), "utf8"),
    /name = "riptide-sim-macros"/
  );

  const manifest = renderCargoToml("demo-riptide-sim", paths);
  assert.match(manifest, /riptide-sim = \{ path = "vendor\/riptide-sim" \}/);
  assert.match(manifest, /riptide-sim-macros = \{ path = "vendor\/riptide-sim-macros" \}/);
  assert.ok(!manifest.includes(packageRoot), "manifest must not leak the install location");
});
