import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  generateSim,
  materializeRuntime,
  renderCargoToml,
  runtimeSourceFromRoots
} from "../src/sim/generate.js";
import { loadGenericIdl } from "../src/sim/idl.js";
import { renderTypes } from "../src/sim/render-types.js";
import { SETUP_GAPS_SCHEMA, type SetupGapsReport } from "../src/sim/setup-gaps.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd(), "..");
const derivableAdapter = path.join(repoRoot, "fixtures", "auto-genesis", "derivable", "adapter.toml");
const gapsAdapter = path.join(repoRoot, "fixtures", "auto-genesis", "gaps", "adapter.toml");
const derivableProgramSo = path.join(
  repoRoot,
  "fixtures",
  "auto-genesis",
  "derivable",
  "program",
  "target",
  "sbpf-solana-solana",
  "release",
  "contribution_pool.so"
);

/** `sim generate` with the operator summary silenced so test output stays readable. */
async function generateQuiet(
  root: string,
  adapter: string,
  extra: { regenTypesOnly?: boolean } = {}
) {
  return generateSim(root, {
    adapter,
    dir: ".riptide/sim",
    writeSummary: () => {},
    ...extra
  });
}

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

test("sim generate scaffolds a Firing Check violation for each invariant", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-gen-violations-"));
  const adapter = path.join(repoRoot, "fixtures", "adapters", "amm.toml");
  const result = await generateQuiet(root, adapter);

  const mainRs = await readFile(path.join(result.dir, "src", "main.rs"), "utf8");
  const violationsRs = await readFile(path.join(result.dir, "src", "violations.rs"), "utf8");
  assert.match(mainRs, /mod violations;/);
  assert.match(mainRs, /#\[violations\]\s+fn violations\(&mut self\) -> Vec<riptide_sim::FiringCheck> \{\s+violations::declare\(self\)/);
  const declared = [...violationsRs.matchAll(/FiringCheck::new\(\s+"([^"]+)",\s+Violation::zero_field\(/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(declared, [
    "reserve_pair_nonzero_together",
    "lp_supply_backed_by_liquidity",
    "fee_config_bounded",
    "stored_k_tracks_current_product",
    "constant_product_positive"
  ]);
  assert.match(violationsRs, /riptide sim run --firing-check/);

  await writeFile(path.join(result.dir, "src", "violations.rs"), "// authored\n", "utf8");
  await generateQuiet(root, adapter);
  assert.equal(
    await readFile(path.join(result.dir, "src", "violations.rs"), "utf8"),
    "// authored\n",
    "a later generate preserves the authored violations"
  );
});

test("sim generate declares only the generic Floor Invariant when the adapter declares no invariants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-gen-no-violations-"));
  const result = await generateQuiet(root, derivableAdapter);

  const violationsRs = await readFile(path.join(result.dir, "src", "violations.rs"), "utf8");
  const declared = [...violationsRs.matchAll(/FiringCheck::new\(\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(declared, ["supply_covers_balances"]);
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

  // Lay the adapter out the way `riptide init` + the Skill do in a user
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

test("sim generate wires the init seam when tick-0 genesis is derivable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-derived-"));

  const result = await generateQuiet(root, derivableAdapter);
  const report = result.setupGaps!;
  const flowsRs = await readFile(path.join(result.dir, "src", "flows.rs"), "utf8");

  assert.equal(report.schema_version, SETUP_GAPS_SCHEMA);
  assert.equal(report.genesis, "derived");
  assert.deepEqual(report.gaps, []);
  assert.equal(report.flows_rs, "generated");
  assert.equal(result.setupGapsPath, path.join(result.dir, "setup-gaps.json"));
  assert.deepEqual(
    JSON.parse(await readFile(result.setupGapsPath!, "utf8")) as SetupGapsReport,
    report
  );

  // One funded signer per persona agent...
  assert.match(flowsRs, /sim\.world\.register_keypair\(genesis_actor_keypair\(idx\)\)/);
  assert.match(flowsRs, /sim\.world\.airdrop\(&actor, GENESIS_ACTOR_LAMPORTS\)\?/);
  assert.match(flowsRs, /sim\.actors\.push\(actor\)/);
  // ...the adapter-declared PDA derived from its declared seeds...
  assert.match(
    flowsRs,
    /let genesis_ledger = Pubkey::find_program_address\(&\["ledger"\.as_bytes\(\), actor\.as_ref\(\)\], &program_id\)\.0;/
  );
  assert.match(flowsRs, /sim\.accounts\.ledger\.insert_agent\(idx, genesis_ledger\)/);
  // ...and the address-unconstrained account under the genesis namespace.
  assert.match(
    flowsRs,
    /let genesis_treasury = Pubkey::find_program_address\(&\[GENESIS_NAMESPACE, "treasury"\.as_bytes\(\)\], &program_id\)\.0;/
  );
  assert.match(flowsRs, /genesis_allocate\(&mut sim\.world, genesis_treasury, program_id, 16usize\)\?/);
  assert.match(flowsRs, /genesis_allocate\(&mut sim\.world, genesis_ledger, program_id, 40usize\)\?/);
  assert.doesNotMatch(flowsRs, /TODO\(setup\)/);
  assert.doesNotMatch(flowsRs, /TODO\(account\)/);
});

test("sim generate reports one honest gap per refusal class instead of guessing genesis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-gaps-"));

  const result = await generateQuiet(root, gapsAdapter);
  const report = result.setupGaps!;
  const flowsRs = await readFile(path.join(result.dir, "src", "flows.rs"), "utf8");

  assert.equal(report.genesis, "gaps");
  assert.equal(report.agent_skill, "/riptide-assess");
  assert.deepEqual(
    report.gaps.map((gap) => [gap.seam, gap.kind]),
    [
      ["accounts.collateral_ata", "decoded_account"],
      ["accounts.deposit_receipt", "self_initializing_account"],
      ["accounts.fee_sink", "unresolved_account"],
      ["accounts.price_feed", "literal_address"],
      ["accounts.vault", "program_constrained_address"]
    ]
  );
  // `token_program` resolves as a well-known program and must not be a gap.
  assert.equal(report.gaps.some((gap) => gap.account === "token_program"), false);
  for (const gap of report.gaps) {
    assert.deepEqual(gap.instructions, ["deposit"], `${gap.seam} names its blocked instruction`);
  }

  // The crate still generates as a compiling no-op guided flow.
  assert.match(flowsRs, /TODO\(setup\)/);
  assert.match(flowsRs, /TODO\(account\): `fee_sink`/);
  assert.match(flowsRs, /setup-gaps\.json/);
  assert.doesNotMatch(flowsRs, /genesis_allocate/);
});

test("every reported gap marker is a literal string in the file it names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-markers-"));

  const result = await generateQuiet(root, gapsAdapter);
  for (const gap of result.setupGaps!.gaps) {
    const contents = await readFile(path.join(result.dir, gap.file), "utf8");
    assert.ok(
      contents.includes(gap.marker),
      `${gap.seam}: marker ${JSON.stringify(gap.marker)} not found in ${gap.file}`
    );
  }
});

test("an adapter whose mappings resolve to no IDL instruction reports an empty action space", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-stub-"));
  const gapsDir = path.join(repoRoot, "fixtures", "auto-genesis", "gaps");
  const adapterPath = path.join(root, "unmapped.toml");
  const source = (await readFile(gapsAdapter, "utf8"))
    .replace('idl_path = "program.json"', `idl_path = ${JSON.stringify(path.join(gapsDir, "program.json"))}`)
    .replace("[instructions.deposit]", "[instructions.settle]")
    .replace('action = "deposit"', 'action = "settle"')
    .replace("[actions.deposit]", "[actions.settle]")
    .replace("action_weights = { deposit = 1.0 }", "action_weights = { settle = 1.0 }");
  await writeFile(adapterPath, source, "utf8");

  const result = await generateQuiet(root, adapterPath);
  const report = result.setupGaps!;

  assert.equal(report.genesis, "gaps");
  assert.deepEqual(
    report.gaps.map((gap) => [gap.seam, gap.kind]),
    [["adapter", "no_mapped_actions"]]
  );
  // The historical no-op stub, not a half-wired genesis.
  const flowsRs = await readFile(path.join(result.dir, "src", "flows.rs"), "utf8");
  assert.match(flowsRs, /pub fn init\(_sim: &mut Simulation\)/);
  assert.doesNotMatch(flowsRs, /genesis_allocate/);
});

test("a per-agent account with a shared PDA scope is a gap, not a collapsed roster", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-scope-"));
  const derivableDir = path.join(repoRoot, "fixtures", "auto-genesis", "derivable");
  const adapterPath = path.join(root, "scope.toml");
  // Drop `signer:agent` from the per-agent ledger's seeds: every agent would then
  // derive the same address.
  const source = (await readFile(derivableAdapter, "utf8"))
    .replace('idl_path = "program.json"', `idl_path = ${JSON.stringify(path.join(derivableDir, "program.json"))}`)
    .replace(
      'pda = { seeds = ["literal:ledger", "signer:agent"] }',
      'pda = { seeds = ["literal:ledger"] }'
    );
  await writeFile(adapterPath, source, "utf8");

  const result = await generateQuiet(root, adapterPath);

  assert.equal(result.setupGaps!.genesis, "gaps");
  assert.deepEqual(
    result.setupGaps!.gaps.map((gap) => [gap.seam, gap.kind]),
    [["accounts.ledger", "agent_scope_mismatch"]]
  );
});

test("setup-gaps.json is byte-stable across generations of the same adapter", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-det-a-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-det-b-"));

  const a = await generateQuiet(first, gapsAdapter);
  const b = await generateQuiet(second, gapsAdapter);

  assert.equal(
    (await readFile(a.setupGapsPath!, "utf8")).replace(first, ""),
    (await readFile(b.setupGapsPath!, "utf8")).replace(second, "")
  );
});

test("sim refresh preserves the genesis report alongside the user-owned flows it describes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-refresh-"));

  const first = await generateQuiet(root, derivableAdapter);
  const flowsPath = path.join(first.dir, "src", "flows.rs");
  await writeFile(flowsPath, "pub fn marker() {}\n", "utf8");

  const refreshed = await generateQuiet(root, derivableAdapter, { regenTypesOnly: true });
  assert.equal(refreshed.setupGaps, undefined);
  assert.equal(await readFile(flowsPath, "utf8"), "pub fn marker() {}\n");
  assert.ok(existsSync(first.setupGapsPath!));

  // A later full generate still preserves flows.rs, and says so, so a consumer
  // does not read the classification as a description of the genesis on disk.
  const again = await generateQuiet(root, derivableAdapter);
  assert.equal(again.setupGaps!.flows_rs, "preserved");
  assert.equal(await readFile(flowsPath, "utf8"), "pub fn marker() {}\n");
});

test("the genesis report is additive for existing hand-authored adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-additive-"));
  const adapter = path.join(repoRoot, "fixtures", "adapters", "amm.toml");

  const result = await generateQuiet(root, adapter);

  assert.equal(result.setupGaps!.genesis, "derived");
  assert.match(await readFile(path.join(result.dir, "src", "types.rs"), "utf8"), /SwapBuilder/);
  assert.match(await readFile(result.bootstrapManifestPath, "utf8"), /\[\[sim\.fork\]\]/);
});

// The strongest available evidence for the derived genesis: the generated crate
// compiles and one seed of the real program runs against it. Skipped unless the
// fixture program has been built — it is source-only in the repo (see
// fixtures/auto-genesis/README.md) because a committed .so is an unreviewable
// binary.
test("a derived genesis compiles and drives the real program for one seed", async (t) => {
  if (!existsSync(derivableProgramSo)) {
    t.skip(
      `fixture program not built at ${derivableProgramSo}; see fixtures/auto-genesis/README.md for the build command`
    );
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-genesis-smoke-"));
  const result = await generateQuiet(root, derivableAdapter);

  await execFileAsync("cargo", ["build", "--release", "--quiet"], { cwd: result.dir });
  await execFileAsync(
    process.execPath,
    [
      path.resolve(process.cwd(), "dist/src/index.js"),
      "sim",
      "run",
      result.dir,
      "--iterations",
      "1",
      "--flows",
      "4",
      "--seed",
      "deadbeef",
      "--out",
      path.join(root, "artifacts")
    ],
    { cwd: root }
  );

  const run = JSON.parse(
    await readFile(path.join(root, "artifacts", "guided-sim-run.json"), "utf8")
  ) as {
    totals: { tx_success: number; panics: number };
    iterations: { tx_outcomes: { label: string; ok: boolean; logs: string[] }[] }[];
  };

  // A genesis whose addresses, owner, or sizes were wrong would leave every
  // transaction failing, so a successful contribute is the load-bearing check.
  assert.ok(run.totals.tx_success > 0, "the derived genesis must let real transactions land");
  assert.equal(run.totals.panics, 0);
  const contributed = run.iterations
    .flatMap((iteration) => iteration.tx_outcomes)
    .find((outcome) => outcome.label === "contribute" && outcome.ok);
  assert.ok(contributed, "at least one contribute transaction must succeed against the program");
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

/** Case-study IDLs live in a sibling checkout that is not always present. */
function caseStudyIdl(name: string): string {
  return path.resolve(repoRoot, "..", "case-studies", "protocol-v2", "sdk", "src", "idl", name);
}

test("sim IDL parser accepts a complex case-study IDL when available", async (t) => {
  const openbook = caseStudyIdl("openbook.json");
  if (!existsSync(openbook)) {
    t.skip(`case-study IDL not checked out at ${openbook}`);
    return;
  }
  const idl = await loadGenericIdl(openbook);
  const rendered = renderTypes(idl);

  assert.match(rendered, /pub struct PlaceOrderArgs/);
  assert.match(rendered, /pub enum Side/);
  assert.match(rendered, /pub bids: Vec<PlaceMultipleOrdersArgs>,/);
  assert.match(rendered, /pub side_option: Option<Side>,/);
});

test("sim IDL parser accepts tuple-style enum variant fields from case-study IDLs", async (t) => {
  const drift = caseStudyIdl("drift.json");
  if (!existsSync(drift)) {
    t.skip(`case-study IDL not checked out at ${drift}`);
    return;
  }
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
