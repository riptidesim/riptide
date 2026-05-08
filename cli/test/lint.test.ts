// `riptide lint` + lint substrate tests.
//
// Covers:
// - classification of lineage source kinds (missing / non-JSON / JSON)
// - clean lint on a JSON-IDL-backed adapter (exit 0)
// - positive mismatch failures: instruction / arg / account / field
// - warn-only path for non-JSON lineage source (e.g. lending)
// - explicit SKIP when there is no [lineage] block
// - shipping JSON-IDL adapters (`amm`, `perpetuals`,
//   `liquid-staking`) lint cleanly as shipped (no FAILs)
// - `lending` lands as explicit warn-only (non-JSON source)

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyLineageSourceKind,
  lintAdapter,
} from "../src/lint/index.js";
import { runLint } from "../src/commands/lint.js";
import { resolveAdapterArg } from "../src/adapter/resolve.js";
import { renderAdapterStub } from "../src/init/index.js";
import type { Adapter, Semantics } from "../src/schemas/adapter.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = findRepoRoot(TEST_DIR);
const FIXTURES_ROOT = path.join(REPO_ROOT, "fixtures");

function findRepoRoot(testDir: string): string {
  const candidates = [
    path.resolve(testDir, "..", ".."),
    path.resolve(testDir, "..", "..", ".."),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
  ];
  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, "engine", "Cargo.toml")) &&
      existsSync(path.join(candidate, "fixtures", "adapters"))
    ) {
      return candidate;
    }
  }
  return path.resolve(testDir, "..", "..");
}

// Minimal but realistic JSON-IDL-backed adapter + IDL pair used for the
// isolated-unit tests. Mirrors the shape of `fixtures/idls/amm.json`
// but trimmed to one instruction and one account.
const SIMPLE_IDL = JSON.stringify({
  version: "0.1.0",
  name: "simple",
  instructions: [
    {
      name: "deposit",
      accounts: [{ name: "owner", signer: true }, { name: "pool", writable: true }],
      args: [{ name: "amount", type: "u64" }],
    },
    {
      name: "initialize_pool",
      accounts: [{ name: "admin", signer: true }, { name: "pool", writable: true }],
      args: [{ name: "fee_bps", type: "u64" }],
    },
  ],
  accounts: [
    {
      name: "pool",
      fields: [
        { name: "is_initialized", type: "bool" },
        { name: "total_deposits", type: "u64" },
        { name: "fee_bps", type: "u64" },
      ],
    },
  ],
});

const IDL_WITH_REQUIRED_ACCOUNTS = JSON.stringify({
  version: "0.1.0",
  name: "required_accounts",
  instructions: [
    {
      name: "initialize_reserve",
      accounts: [
        { name: "authority", signer: true, writable: true },
        { name: "reserve", writable: true },
        { name: "price_update_v2" },
        { name: "receipt_mint", writable: true },
        { name: "reserve_token_account", writable: true },
        { name: "system_program", address: "11111111111111111111111111111111" },
        { name: "token_program" },
        { name: "associated_token_program", address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" },
      ],
      args: [{ name: "amount", type: "u64" }],
    },
  ],
  accounts: [
    {
      name: "reserve",
      fields: [{ name: "available_amount", type: "u64" }],
    },
  ],
});

const CLEAN_ADAPTER_TOML = (idlRelPath: string) => `protocol = "generic"
program_so = "./simple.so"
idl_path = "${idlRelPath}"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "${idlRelPath}"
generator = "hand-authored"
unsupported_fields = [
  "instruction \`initialize_pool\` — admin setup",
  "account \`pool.total_deposits\` — externally owned agent account smoke field",
  "account \`pool.is_initialized\` — bootstrap metadata",
  "account \`pool.fee_bps\` — config, not persona-observable",
]
`;

const BROKEN_INSTRUCTION_TOML = (idlRelPath: string) => `protocol = "generic"
program_so = "./simple.so"
idl_path = "${idlRelPath}"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
nonexistent_ix = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "${idlRelPath}"
`;

const BROKEN_ARG_TOML = (idlRelPath: string) => `protocol = "generic"
program_so = "./simple.so"
idl_path = "${idlRelPath}"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "nonexistent_arg" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["nonexistent_arg"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "${idlRelPath}"
`;

const BROKEN_FIELD_TOML = (idlRelPath: string) => `protocol = "generic"
program_so = "./simple.so"
idl_path = "${idlRelPath}"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.ghost_field" = "pool.ghost_field"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.ghost_field" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "${idlRelPath}"
`;

const BROKEN_ACCOUNT_TOML = (idlRelPath: string) => `protocol = "generic"
program_so = "./simple.so"
idl_path = "${idlRelPath}"

[accounts.ghost_account]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"ghost_account.something" = "ghost_account.something"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"ghost_account.something" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "${idlRelPath}"
`;

const MISSING_IDL_ACCOUNTS_TOML = (idlRelPath: string) => `protocol = "generic"
program_so = "./simple.so"
idl_path = "${idlRelPath}"

[accounts.reserve]
kind = "shared"
space = 64

[instructions]
initialize_reserve = { action = "initialize_reserve", amount = "amount" }

[state_mapping]
"reserve.available_amount" = "reserve.available_amount"

[actions.initialize_reserve]
label = "Initialize reserve"
takes = ["amount"]

[observations]
"reserve.available_amount" = "uint"

[personas.operator]
label = "Operator"
action_rate_multiplier = 1.0
action_weights = { initialize_reserve = 1.0 }
triggers = []

[lineage]
idl_source = "${idlRelPath}"
`;

const NON_JSON_LINEAGE_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[actions]
[observations]
[personas]

[lineage]
idl_source = "programs/lending_pool/src/state.rs"
generator = "hand-authored"
`;

const NO_LINEAGE_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[actions]
[observations]
[personas]
`;

const GENERIC_ORACLE_TOML = (oracleBlock: string, oracleAccountExtra = "") => `protocol = "generic"
program_so = "./simple.so"
idl_path = "fixtures/idls/simple.json"

[accounts.player]
kind = "agent"
space = 64

[accounts.oracle]
kind = "shared"
space = 134
${oracleAccountExtra}

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"player.balance" = "player.balance"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"player.balance" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

${oracleBlock}
`;

const ERROR_REGISTRY_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[errors]]
code = 8
label = "insufficient_collateral"
interpretation = "Borrow or withdraw exceeded the position collateral constraint."

[actions]
[observations]
[personas]
`;

const DUPLICATE_ERROR_CODE_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[errors]]
code = 8
label = "insufficient_collateral"
interpretation = "Borrow or withdraw exceeded the position collateral constraint."

[[errors]]
code = 8
label = "insufficient_liquidity"
interpretation = "Pool liquidity was insufficient."

[actions]
[observations]
[personas]
`;

const DUPLICATE_ERROR_LABEL_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[errors]]
code = 8
label = "insufficient_collateral"
interpretation = "Borrow or withdraw exceeded the position collateral constraint."

[[errors]]
code = 9
label = "insufficient_collateral"
interpretation = "Pool liquidity was insufficient."

[actions]
[observations]
[personas]
`;

const MALFORMED_ERROR_LABEL_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[errors]]
code = 8
label = "InsufficientCollateral"
interpretation = "Borrow or withdraw exceeded the position collateral constraint."

[actions]
[observations]
[personas]
`;

const MISSING_ERROR_FIELD_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[errors]]
code = 8
label = "insufficient_collateral"

[actions]
[observations]
[personas]
`;

const VALID_PUBKEY_A = "11111111111111111111111111111111";
const VALID_PUBKEY_B = "So11111111111111111111111111111111111111112";
const VALID_PUBKEY_C = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const VALID_PUBKEY_D = "SysvarC1ock11111111111111111111111111111111";

const SEMANTICS_BREADTH_BASE: Semantics = {
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
        collateral_price: "u128",
        max_ltv_bps: "u64",
      },
    },
    oracle: {
      source: "account.oracle",
      fields: {
        confidence: "u128",
        staleness: "u64",
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
  invariants: [],
  extensions: {},
  oracles: {
    oracle: [
      {
        program_id: VALID_PUBKEY_A,
        account: VALID_PUBKEY_B,
        confidence: "oracle.confidence",
        staleness: "oracle.staleness",
        weight: 60,
      },
      {
        program_id: VALID_PUBKEY_C,
        account: VALID_PUBKEY_D,
        confidence: "oracle.confidence",
        staleness: "oracle.staleness",
        weight: 40,
      },
    ],
  },
  collections: {
    worst_health_factor: {
      over: "reserves",
      formula: "worst",
      expr: "collateral_value / max(debt_value, 1)",
    },
  },
  replay: {
    state_source: "fixture",
    pack_path: "state-packs/semantics-breadth-demo",
    slot: 123456789,
    roles: {
      position: VALID_PUBKEY_B,
      reserve: VALID_PUBKEY_D,
      oracle: VALID_PUBKEY_A,
      liquidation_config: VALID_PUBKEY_C,
    },
  },
};

async function setupAdapterPair(
  adapterContents: string,
  idlContents: string | null
): Promise<{ adapterPath: string; repoRoot: string }> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-lint-test-"));
  const adaptersDir = path.join(repoRoot, "fixtures", "adapters");
  const idlsDir = path.join(repoRoot, "fixtures", "idls");
  await mkdir(adaptersDir, { recursive: true });
  await mkdir(idlsDir, { recursive: true });
  const adapterPath = path.join(adaptersDir, "test-adapter.toml");
  await writeFile(adapterPath, adapterContents, "utf8");
  if (idlContents !== null) {
    const idlPath = path.join(idlsDir, "simple.json");
    await writeFile(idlPath, idlContents, "utf8");
  }
  return { adapterPath, repoRoot };
}

function cloneBreadthSemantics(): Semantics {
  return structuredClone(SEMANTICS_BREADTH_BASE);
}

function semanticsBreadthAdapter(semantics: Semantics): Adapter {
  return {
    protocol: "lending",
    instructions: {
      deposit: { action: "deposit", amount: "amount", args: {}, bindings: {} },
      borrow: { action: "borrow", amount: "amount", args: {}, bindings: {} },
      repay: { action: "repay", amount: "amount", args: {}, bindings: {} },
      withdraw: { action: "withdraw", amount: "amount", args: {}, bindings: {} },
      liquidate: { action: "liquidate", amount: "repay_amount", args: {}, bindings: {} },
    },
    state_mapping: {},
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

function minimalGenericAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    protocol: "generic",
    program_so: "./simple.so",
    idl_path: "fixtures/idls/simple.json",
    instructions: {
      refresh: { action: "refresh", args: {} },
    },
    state_mapping: {
      "reserve.available_amount": "reserve.available_amount",
    },
    accounts: {
      reserve: { kind: "shared", space: 64 },
    },
    actions: {
      refresh: { label: "Refresh", takes: [] },
    },
    observations: {
      "reserve.available_amount": "uint",
    },
    personas: {
      keeper: {
        label: "Keeper",
        action_rate_multiplier: 1,
        amount: 1,
        action_weights: { refresh: 1 },
        triggers: [],
        persona_args: {},
      },
    },
    invariants: [],
    oracles: [],
    scheduled_actions: [],
    semantics: undefined,
    errors: [],
    lineage: undefined,
    ...overrides,
  };
}

async function lintBreadthSemantics(semantics: Semantics) {
  return lintAdapter({
    adapter: semanticsBreadthAdapter(semantics),
    adapterPath: "/tmp/semantics-breadth.toml",
    adapterName: "semantics-breadth",
    repoRoot: "/tmp",
  });
}

function findingCodes(findings: Array<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}

// ---- unit: classification ----

test("classifyLineageSourceKind: undefined → missing-lineage", () => {
  assert.equal(classifyLineageSourceKind(undefined), "missing-lineage");
});

test("classifyLineageSourceKind: empty idl_source → missing-lineage", () => {
  assert.equal(
    classifyLineageSourceKind({
      idl_source: undefined,
      inferred_assumptions: [],
      unsupported_fields: [],
    }),
    "missing-lineage"
  );
});

test("classifyLineageSourceKind: .json suffix → json-idl", () => {
  assert.equal(
    classifyLineageSourceKind({
      idl_source: "fixtures/idls/foo.json",
      inferred_assumptions: [],
      unsupported_fields: [],
    }),
    "json-idl"
  );
});

test("classifyLineageSourceKind: Rust source → non-json", () => {
  assert.equal(
    classifyLineageSourceKind({
      idl_source: "programs/lending_pool/src/state.rs",
      inferred_assumptions: [],
      unsupported_fields: [],
    }),
    "non-json"
  );
});

// ---- unit: semantics breadth lint ----

test("lintAdapter: clean semantics breadth surface emits a named PASS", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.derived.first_oracle_price = "oracle.0.price";
  semantics.derived.weighted_collateral_value =
    "position.collateral_amount * oracle.weighted_price";
  semantics.collections.worst_health_factor!.expr = "oracle.1.price / max(debt_value, 1)";

  const report = await lintBreadthSemantics(semantics);

  assert.equal(report.exitCode, 0);
  assert.ok(findingCodes(report.findings).includes("semantics-breadth-clean"));
  assert.ok(findingCodes(report.findings).includes("lineage-missing"));
});

test("lintAdapter: semantics oracle role must exist", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.oracles.price_feed = semantics.oracles.oracle!;
  delete semantics.oracles.oracle;

  const report = await lintBreadthSemantics(semantics);

  assert.equal(report.exitCode, 2);
  assert.ok(findingCodes(report.findings).includes("semantics-oracle-unknown-role"));
  assert.match(
    report.findings.find((finding) => finding.code === "semantics-oracle-unknown-role")?.message ?? "",
    /UnknownOracleRole\(price_feed\)/
  );
});

test("lintAdapter: semantics oracle pubkeys and positive total weights are enforced", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.oracles.oracle![0]!.program_id = "not-a-pubkey";
  semantics.oracles.oracle![0]!.weight = 0;
  semantics.oracles.oracle![1]!.weight = 0;

  const report = await lintBreadthSemantics(semantics);
  const codes = findingCodes(report.findings);

  assert.equal(report.exitCode, 2);
  assert.ok(codes.includes("semantics-oracle-invalid-pubkey"));
  assert.ok(codes.includes("semantics-oracle-zero-total-weight"));
});

test("lintAdapter: semantics collections validate over, formula, and expression syntax", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.collections.worst_health_factor!.over = "vaults";
  semantics.collections.worst_health_factor!.formula = "median";
  semantics.collections.worst_health_factor!.expr = "collateral_value /";

  const report = await lintBreadthSemantics(semantics);
  const codes = findingCodes(report.findings);

  assert.equal(report.exitCode, 2);
  assert.ok(codes.includes("semantics-collection-unknown-role"));
  assert.ok(codes.includes("semantics-collection-unknown-formula"));
  assert.ok(codes.includes("semantics-collection-expression-parse-failed"));
});

test("lintAdapter: semantics replay validates state_source", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.replay!.state_source = "archive";

  const report = await lintBreadthSemantics(semantics);

  assert.equal(report.exitCode, 2);
  assert.ok(findingCodes(report.findings).includes("semantics-replay-unknown-state-source"));
});

test("lintAdapter: semantics replay validates relative pack_path and role bindings", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.replay!.pack_path = "/abs/state-pack";
  semantics.replay!.roles.ghost = VALID_PUBKEY_A;
  semantics.replay!.roles.oracle = "abc";

  const report = await lintBreadthSemantics(semantics);
  const codes = findingCodes(report.findings);

  assert.equal(report.exitCode, 2);
  assert.ok(codes.includes("semantics-replay-invalid-pack-path"));
  assert.ok(codes.includes("semantics-replay-unknown-role"));
  assert.ok(codes.includes("semantics-replay-invalid-pubkey"));
});

test("lintAdapter: semantics replay rejects path traversal in pack_path", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.replay!.pack_path = "../escape";

  const report = await lintBreadthSemantics(semantics);
  const codes = findingCodes(report.findings);

  assert.equal(report.exitCode, 2);
  assert.ok(codes.includes("semantics-replay-invalid-pack-path"));
});

test("lintAdapter: semantics mainnet-rpc replay is WARN, not FAIL", async () => {
  const semantics = cloneBreadthSemantics();
  semantics.replay!.state_source = "mainnet-rpc";
  delete semantics.replay!.pack_path;

  const report = await lintBreadthSemantics(semantics);
  const codes = findingCodes(report.findings);

  assert.equal(report.exitCode, 1);
  assert.ok(codes.includes("semantics-replay-mainnet-rpc-not-implemented"));
  assert.equal(report.findings.some((finding) => finding.level === "fail"), false);
});

// ---- runLint end-to-end via temp adapter pairs ----

test("runLint: clean JSON-IDL-backed adapter → exit 0", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(
    CLEAN_ADAPTER_TOML("fixtures/idls/simple.json"),
    SIMPLE_IDL
  );
  let out = "";
  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.equal(exit, 0, `expected 0, got ${exit}. stderr:\n${err}\n\nstdout:\n${out}`);
  assert.match(out, /Verdict: PASS/);
  assert.match(out, /JSON IDL/);
  assert.match(out, /mapped-surface-clean/);
});

test("runLint: legacy Anchor IDL account type fields and nested paths → exit 0", async () => {
  const legacyIdl = JSON.stringify({
    version: "0.1.0",
    name: "legacy",
    instructions: [
      {
        name: "setValidatorScore",
        accounts: [{ name: "state", isMut: true }],
        args: [{ name: "score", type: "u32" }],
      },
      {
        name: "changeAuthority",
        accounts: [{ name: "state", isMut: true }],
        args: [],
      },
    ],
    accounts: [
      {
        name: "State",
        type: {
          kind: "struct",
          fields: [
            { name: "validatorSystem", type: { defined: "ValidatorSystem" } },
            { name: "paused", type: "bool" },
          ],
        },
      },
    ],
    types: [
      {
        name: "ValidatorSystem",
        type: {
          kind: "struct",
          fields: [{ name: "totalValidatorScore", type: "u32" }],
        },
      },
    ],
  });
  const adapterToml = `protocol = "generic"
program_so = "./legacy.so"
idl_path = "fixtures/idls/simple.json"

[accounts.state]
kind = "shared"
space = 128

[instructions]
setValidatorScore = { action = "set_validator_score", amount = "score" }

[state_mapping]
"state.validatorSystem.totalValidatorScore" = "validator.total_score"

[actions.set_validator_score]
takes = ["score"]

[observations]
"validator.total_score" = "uint"

[personas.manager]
action_rate_multiplier = 1.0
action_weights = { set_validator_score = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
unsupported_fields = [
  "instruction \`changeAuthority\` is outside this smoke",
  "field \`state.validatorSystem\` is otherwise deterministic setup",
  "field \`state.paused\` is outside this smoke",
]
`;
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, legacyIdl);
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 0, out);
  assert.match(out, /mapped-surface-clean/);
});

test("runLint: broken instruction → exit 2 with named diagnostic", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(
    BROKEN_INSTRUCTION_TOML("fixtures/idls/simple.json"),
    SIMPLE_IDL
  );
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /FAIL/);
  assert.match(out, /instruction-not-in-idl/);
  assert.match(out, /\[instructions\]\.nonexistent_ix/);
});

test("runLint: broken instruction arg → exit 2", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(
    BROKEN_ARG_TOML("fixtures/idls/simple.json"),
    SIMPLE_IDL
  );
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /instruction-amount-arg-not-in-idl/);
  assert.match(out, /nonexistent_arg/);
});

test("runLint: broken field reference → exit 2", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(
    BROKEN_FIELD_TOML("fixtures/idls/simple.json"),
    SIMPLE_IDL
  );
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /state-mapping-field-not-in-idl|observation-field-not-in-idl/);
  assert.match(out, /ghost_field/);
});

test("runLint: broken account → exit 2", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(
    BROKEN_ACCOUNT_TOML("fixtures/idls/simple.json"),
    SIMPLE_IDL
  );
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /account-not-in-idl|state-mapping-account-not-in-idl|observation-account-not-in-idl/);
  assert.match(out, /ghost_account/);
});

test("runLint: mapped IDL instruction with undeclared required accounts → exit 2 with stubs", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(
    MISSING_IDL_ACCOUNTS_TOML("fixtures/idls/simple.json"),
    IDL_WITH_REQUIRED_ACCOUNTS
  );
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /instruction-account-not-declared/);
  assert.match(out, /price_update_v2/);
  assert.match(out, /receipt_mint/);
  assert.match(out, /reserve_token_account/);
  assert.match(out, /\[accounts\.price_update_v2\]/);
  assert.match(out, /\[accounts\.receipt_mint\]/);
  assert.match(out, /\[accounts\.reserve_token_account\]/);
  assert.doesNotMatch(out, /authority.*not declared/);
  assert.doesNotMatch(out, /system_program.*not declared/);
  assert.doesNotMatch(out, /token_program.*not declared/);
  assert.doesNotMatch(out, /associated_token_program.*not declared/);
});

test("runLint: non-JSON lineage source → explicit WARN, exit 1", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(NON_JSON_LINEAGE_TOML, null);
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 1);
  assert.match(out, /WARN/);
  assert.match(out, /lineage-non-json/);
  assert.match(out, /non-JSON/);
  assert.doesNotMatch(out, /Verdict: PASS/);
});

test("lintAdapter: generic invariant fields must be declared observations", async () => {
  const report = await lintAdapter({
    adapter: minimalGenericAdapter({
      invariants: [
        { name: "active_agents_survive", field: "active_agents", op: ">", value: 0 },
      ],
    }),
    adapterPath: "/tmp/generic-invariant.toml",
    adapterName: "generic-invariant",
    repoRoot: "/tmp",
  });

  assert.equal(report.exitCode, 2);
  assert.ok(findingCodes(report.findings).includes("generic-invariant-field-not-observed"));
});

test("lintAdapter: scheduled action account references must be declared", async () => {
  const report = await lintAdapter({
    adapter: minimalGenericAdapter({
      scheduled_actions: [
        {
          name: "refresh_each_tick",
          instruction: "refresh",
          interval_ticks: 1,
          accounts: ["reserve", "ghost"],
          args: {},
        },
      ],
    }),
    adapterPath: "/tmp/generic-scheduled.toml",
    adapterName: "generic-scheduled",
    repoRoot: "/tmp",
  });

  assert.equal(report.exitCode, 2);
  assert.ok(findingCodes(report.findings).includes("scheduled-action-account-not-declared"));
  assert.match(
    report.findings.find((finding) => finding.code === "scheduled-action-account-not-declared")?.hint ?? "",
    /\[accounts\.ghost\]/
  );
});

test("runLint: no [lineage] block → explicit SKIP, exit 0", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(NO_LINEAGE_TOML, null);
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 0);
  assert.match(out, /SKIP/);
  assert.match(out, /lineage-missing/);
  // Critical: the absence of a lineage block must not render as PASS
  // on the machine-checkable surface.
  assert.doesNotMatch(out, /mapped-surface-clean/);
});

test("runLint: valid [errors] registry is accepted", async () => {
  const { adapterPath, repoRoot } = await setupAdapterPair(ERROR_REGISTRY_TOML, null);
  let out = "";
  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.equal(exit, 0, `stdout:\n${out}\nstderr:\n${err}`);
  assert.match(out, /lineage-missing/);
});

for (const [name, toml, pattern] of [
  ["duplicate code", DUPLICATE_ERROR_CODE_TOML, /duplicate program error code `8`/],
  ["duplicate label", DUPLICATE_ERROR_LABEL_TOML, /duplicate program error label `insufficient_collateral`/],
  ["malformed label", MALFORMED_ERROR_LABEL_TOML, /program error label must be snake_case/],
  ["missing required field", MISSING_ERROR_FIELD_TOML, /interpretation.*expected string, received undefined/],
] as const) {
  test(`runLint: invalid [errors] ${name} → exit 2 with next step`, async () => {
    const { adapterPath, repoRoot } = await setupAdapterPair(toml, null);
    let err = "";
    const exit = await runLint(
      adapterPath,
      {},
      {
        repoRoot,
        stdoutWrite: () => {},
        stderrWrite: (c) => { err += c; },
        color: false,
      }
    );
    assert.equal(exit, 2);
    assert.match(err, pattern);
    assert.match(err, /next step:/);
  });
}

test("runLint: unknown adapter name → exit 2 with named error", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-lint-missing-"));
  const adaptersDir = path.join(repoRoot, "fixtures", "adapters");
  await mkdir(adaptersDir, { recursive: true });

  let err = "";
  const exit = await runLint(
    "not-a-real-adapter",
    {},
    {
      fixturesRoot: path.join(repoRoot, "fixtures"),
      repoRoot,
      stdoutWrite: () => {},
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(err, /adapter not found for `not-a-real-adapter`/);
});

test("runLint: untouched init stub gets scaffold-specific next step", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-lint-init-stub-"));
  const adaptersDir = path.join(repoRoot, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const adapterPath = path.join(adaptersDir, "lending.toml");
  await writeFile(adapterPath, renderAdapterStub("lending"), "utf8");

  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: () => {},
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );

  assert.equal(exit, 2);
  assert.match(err, /incomplete `riptide init` stub/);
  assert.match(err, /invoke `\/riptide-config`/);
  assert.match(err, /fill the TODO blocks/);
  assert.match(err, /accounts, instructions, state_mapping, actions, observations, and personas/);
  assert.match(err, /Then rerun `riptide lint/);
});

// ---- integration: shipping JSON-IDL adapters lint cleanly ----

test("runLint: shipping amm lints cleanly (no FAILs)", async () => {
  let out = "";
  let err = "";
  const exit = await runLint(
    "amm",
    {},
    {
      fixturesRoot: FIXTURES_ROOT,
      repoRoot: REPO_ROOT,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.ok(exit === 0 || exit === 1, `amm lint should be PASS or WARN, not FAIL. exit=${exit}. stderr:\n${err}`);
  assert.doesNotMatch(out, / FAIL {2}\[/);
  assert.match(out, /JSON IDL/);
});

test("runLint: shipping perpetuals lints cleanly (no FAILs)", async () => {
  let out = "";
  const exit = await runLint(
    "perpetuals",
    {},
    {
      fixturesRoot: FIXTURES_ROOT,
      repoRoot: REPO_ROOT,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.ok(exit === 0 || exit === 1, `perpetuals lint should be PASS or WARN, got exit=${exit}`);
  assert.doesNotMatch(out, / FAIL {2}\[/);
});

test("runLint: shipping liquid-staking lints cleanly (no FAILs)", async () => {
  let out = "";
  const exit = await runLint(
    "liquid-staking",
    {},
    {
      fixturesRoot: FIXTURES_ROOT,
      repoRoot: REPO_ROOT,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.ok(exit === 0 || exit === 1, `liquid-staking lint should be PASS or WARN, got exit=${exit}`);
  assert.doesNotMatch(out, / FAIL {2}\[/);
});

test("runLint: shipping lending semantics preflight passes despite non-JSON lineage → exit 0", async () => {
  let out = "";
  const exit = await runLint(
    "lending",
    {},
    {
      fixturesRoot: FIXTURES_ROOT,
      repoRoot: REPO_ROOT,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 0, `lending must land as PASS/0 after semantics lint. stdout:\n${out}`);
  assert.match(out, /non-JSON/);
  assert.match(out, /semantics-clean/);
  assert.match(out, /programs\/lending_pool\/src\/state\.rs/);
  assert.match(out, /Verdict: PASS/);
  assert.doesNotMatch(out, / FAIL {2}\[/);
});

// ---- regression: external-repo adapter path derives its own repo root ----

test("runLint: external adapter path resolves its own IDL (not the installed CLI's checkout)", async () => {
  // Repros the High finding: previously, runLint() defaulted repoRoot
  // to the installed Riptide monorepo regardless of where the adapter
  // lived. A temp external repo laid out exactly like the shipping
  // fixtures would false-fail with idl-unreadable because the linter
  // resolved the IDL inside the CLI's own checkout.
  const { adapterPath, repoRoot } = await setupAdapterPair(
    CLEAN_ADAPTER_TOML("fixtures/idls/simple.json"),
    SIMPLE_IDL
  );

  // Note: no repoRoot override. The command must derive the correct
  // repo root from the adapter path alone.
  let out = "";
  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      stdoutWrite: (c) => { out += c; },
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.equal(exit, 0, `expected 0, got ${exit}. stdout:\n${out}\nstderr:\n${err}`);
  assert.match(out, /Verdict: PASS/);
  assert.match(out, new RegExp(`Source kind: JSON IDL — ${repoRoot.replace(/[/\\]/g, "\\$&")}`));
  assert.doesNotMatch(out, /idl-unreadable/);
});

test("runLint: .riptide/adapters/ downstream repo convention derives its own repo root", async () => {
  // Downstream-user repos bootstrapped via `riptide init` place
  // adapters at `<root>/.riptide/adapters/<name>.toml`. The derivation
  // must handle this convention too.
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-lint-downstream-"));
  const adaptersDir = path.join(repoRoot, ".riptide", "adapters");
  const idlsDir = path.join(repoRoot, "fixtures", "idls");
  await mkdir(adaptersDir, { recursive: true });
  await mkdir(idlsDir, { recursive: true });
  await writeFile(path.join(idlsDir, "simple.json"), SIMPLE_IDL, "utf8");
  const adapterPath = path.join(adaptersDir, "ext.toml");
  await writeFile(
    adapterPath,
    CLEAN_ADAPTER_TOML("fixtures/idls/simple.json"),
    "utf8"
  );

  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 0);
  assert.match(out, /Verdict: PASS/);
});

// ---- regression: invalid owner block is rejected, not silently skipped ----

test("runLint: empty owner block is rejected at validation (not silently skipped)", async () => {
  // Repros the Medium finding: previously, the linter treated any
  // present `owner` block as "externally owned" and skipped IDL cross
  // checks — including for `owner = {}`, which the engine rejects.
  // Now the CLI schema rejects the invalid owner block at load time
  // and the bad pool.ghost reference is never masked.
  const adapterToml = `protocol = "generic"
program_so = "./mini.so"
idl_path = "fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64
owner = {}

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.ghost" = "pool.ghost"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.ghost" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
`;
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, SIMPLE_IDL);

  let out = "";
  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  // The adapter fails Zod-side validation (matching engine contract);
  // the linter should never see it. Exit 2 with a named diagnostic.
  assert.equal(exit, 2, `expected 2, got ${exit}. stdout:\n${out}\nstderr:\n${err}`);
  assert.match(err, /adapter failed validation/);
  assert.match(err, /empty `owner` block/);
});

test("runLint: owner with both program_so and pubkey is rejected at validation", async () => {
  const adapterToml = `protocol = "generic"
program_so = "./mini.so"
idl_path = "fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64
owner = { program_so = "./sibling.so", pubkey = "11111111111111111111111111111111" }

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.ghost" = "pool.ghost"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.ghost" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
`;
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, SIMPLE_IDL);
  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: () => {},
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(err, /both `owner\.program_so` and `owner\.pubkey`/);
});

test("runLint: owner.pubkey with invalid base58 character is rejected at validation", async () => {
  // Repros the remaining contract gap: engine's
  // `Pubkey::from_str` rejects non-base58 chars, but the CLI side
  // previously accepted anything non-empty. A bogus pubkey must not
  // be treated as a valid external-owner marker; otherwise the
  // linter silently skips IDL cross-check on that account.
  const adapterToml = `protocol = "generic"
program_so = "./mini.so"
idl_path = "fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64
owner = { pubkey = "not-a-pubkey" }

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.ghost" = "pool.ghost"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.ghost" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
`;
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, SIMPLE_IDL);
  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: () => {},
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(err, /is not a valid base58-encoded 32-byte pubkey/);
  assert.match(err, /invalid base58 character/);
});

test("runLint: owner.pubkey that decodes to the wrong byte length is rejected at validation", async () => {
  // "abc" is valid base58 but decodes to 2 bytes, not 32. Previously
  // the CLI accepted any non-empty string; now it must fail and
  // engine-match on the length check.
  const adapterToml = `protocol = "generic"
program_so = "./mini.so"
idl_path = "fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64
owner = { pubkey = "abc" }

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.x" = "pool.x"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.x" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
`;
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, SIMPLE_IDL);
  let err = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: () => {},
      stderrWrite: (c) => { err += c; },
      color: false,
    }
  );
  assert.equal(exit, 2);
  assert.match(err, /is not a valid base58-encoded 32-byte pubkey/);
  assert.match(err, /decoded to \d+ bytes \(expected 32\)/);
});

test("runLint: owner.pubkey with a valid 32-byte base58 key is accepted + skips IDL cross-check on that account", async () => {
  // Positive case: the system-program pubkey (32 zero bytes encodes
  // to "11111111111111111111111111111111") must pass schema validation
  // AND make the linter legitimately skip IDL cross-check on that
  // account — the adapter maps an unrelated account-field that would
  // otherwise FAIL.
  const adapterToml = `protocol = "generic"
program_so = "./mini.so"
idl_path = "fixtures/idls/simple.json"

[accounts.external]
kind = "shared"
space = 64
owner = { pubkey = "11111111111111111111111111111111" }

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"
"external.anything"   = "external.anything"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"
"external.anything"   = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
unsupported_fields = [
  "instruction \`initialize_pool\` — admin setup",
  "account \`pool.total_deposits\` — externally owned agent account smoke field",
  "account \`pool.is_initialized\` — bootstrap metadata",
  "account \`pool.fee_bps\` — config, not persona-observable",
]
`;
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, SIMPLE_IDL);
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 0, `expected PASS on valid base58 pubkey, got exit=${exit}. stdout:\n${out}`);
  assert.match(out, /Verdict: PASS/);
  // `external.anything` must NOT surface as a FAIL finding — the
  // account is legitimately sibling-owned and must be skipped from
  // the IDL cross-check.
  assert.doesNotMatch(out, / FAIL {2}\[/);
});

test("runLint: agent account with valid owner pubkey is accepted and skipped from IDL cross-check", async () => {
  const adapterToml = `protocol = "generic"
program_so = "./mini.so"
idl_path = "fixtures/idls/simple.json"

[accounts.pool]
kind = "agent"
space = 64
owner = { pubkey = "11111111111111111111111111111111" }

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.x" = "pool.x"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.x" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
unsupported_fields = [
  "instruction \`initialize_pool\` — admin setup",
  "account \`pool.total_deposits\` — externally owned agent account smoke field",
  "account \`pool.is_initialized\` — bootstrap metadata",
  "account \`pool.fee_bps\` — config, not persona-observable",
]
`;
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, SIMPLE_IDL);
  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );
  assert.equal(exit, 0, `expected PASS on agent external owner, got exit=${exit}. stdout:\n${out}`);
  assert.match(out, /Verdict: PASS/);
  assert.doesNotMatch(out, / FAIL {2}\[/);
});

// ---- coverage report sanity ----

test("lintAdapter: coverage report includes uncovered-instruction warnings for an unacknowledged IDL instruction", async () => {
  // `initialize_pool` in SIMPLE_IDL is acknowledged in CLEAN_ADAPTER_TOML's
  // unsupported_fields, so a clean coverage report has 0 uncovered.
  // Strip the unsupported_fields entry and confirm the linter then
  // warns about `initialize_pool`.
  const adapterToml = CLEAN_ADAPTER_TOML("fixtures/idls/simple.json").replace(
    /unsupported_fields = \[[\s\S]*?\]/m,
    "unsupported_fields = []"
  );
  const { adapterPath, repoRoot } = await setupAdapterPair(adapterToml, SIMPLE_IDL);

  let out = "";
  const exit = await runLint(
    adapterPath,
    {},
    {
      repoRoot,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
    }
  );

  assert.equal(exit, 1, "stripped unsupported_fields must WARN, not FAIL");
  assert.match(out, /idl-instruction-uncovered/);
  assert.match(out, /initialize_pool/);
  // Coverage report must expose the uncovered count ≥ 1.
  assert.match(out, /Uncovered instructions\s+:\s+[1-9]/);
});

// ---- resolveAdapterArg: downstream `.riptide/adapters/` bare-name resolution ----
//
// The install-first docs tell a user to run `riptide lint <program-name>`
// immediately after `riptide init` scaffolds `.riptide/adapters/<program-name>.toml`
// in a downstream repo. These tests pin that resolution path so the guidance
// does not drift back to "only shipping fixture adapters lint by bare name".

test("resolveAdapterArg: bare name resolves against <cwd>/.riptide/adapters/ first (downstream repo)", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-resolve-downstream-"));
  const riptideAdaptersDir = path.join(repoRoot, ".riptide", "adapters");
  await mkdir(riptideAdaptersDir, { recursive: true });
  const adapterPath = path.join(riptideAdaptersDir, "my-program.toml");
  await writeFile(adapterPath, "protocol = \"lending\"\n", "utf8");

  const resolved = resolveAdapterArg("my-program", { cwd: repoRoot });
  assert.ok(resolved, "bare name must resolve against <cwd>/.riptide/adapters/");
  assert.equal(resolved!.path, adapterPath);
  assert.equal(resolved!.displayName, "my-program");
});

test("resolveAdapterArg: <cwd>/.riptide/adapters/ wins over the shipping fixtures layer", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-resolve-priority-"));
  const downstreamDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(downstreamDir, { recursive: true });
  const downstreamAdapter = path.join(downstreamDir, "my-program.toml");
  await writeFile(downstreamAdapter, "# downstream\n", "utf8");

  const fixturesRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-resolve-fixtures-"));
  const shippingDir = path.join(fixturesRoot, "adapters");
  await mkdir(shippingDir, { recursive: true });
  const shippingAdapter = path.join(shippingDir, "my-program.toml");
  await writeFile(shippingAdapter, "# shipping\n", "utf8");

  const resolved = resolveAdapterArg("my-program", { cwd, fixturesRoot });
  assert.ok(resolved);
  assert.equal(
    resolved!.path,
    downstreamAdapter,
    "downstream `.riptide/adapters/` layer must win over the fixtures layer"
  );
});

test("resolveAdapterArg: falls through to fixturesRoot when no downstream adapter exists", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-resolve-fallthrough-"));
  const fixturesRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-resolve-fixtures-ft-"));
  const shippingDir = path.join(fixturesRoot, "adapters");
  await mkdir(shippingDir, { recursive: true });
  const shippingAdapter = path.join(shippingDir, "shipping-only.toml");
  await writeFile(shippingAdapter, "# shipping only\n", "utf8");

  const resolved = resolveAdapterArg("shipping-only", { cwd, fixturesRoot });
  assert.ok(resolved, "bare name must still resolve against fixturesRoot when no downstream adapter exists");
  assert.equal(resolved!.path, shippingAdapter);
});

test("resolveAdapterArg: returns null when neither layer has the adapter", () => {
  const resolved = resolveAdapterArg("definitely-not-there-xyz", {
    cwd: "/tmp",
    fixturesRoot: "/tmp/does-not-exist",
  });
  assert.equal(resolved, null);
});

test("resolveAdapterArg: legacy string-only fixturesRoot argument still works", async () => {
  // Backward-compat: the original signature was
  //   resolveAdapterArg(arg, fixturesRoot?: string)
  // and callers still pass a bare string. New options object is additive.
  const fixturesRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-resolve-legacy-"));
  const shippingDir = path.join(fixturesRoot, "adapters");
  await mkdir(shippingDir, { recursive: true });
  const shippingAdapter = path.join(shippingDir, "legacy.toml");
  await writeFile(shippingAdapter, "# legacy\n", "utf8");

  const resolved = resolveAdapterArg("legacy", fixturesRoot);
  assert.ok(resolved);
  assert.equal(resolved!.path, shippingAdapter);
});
