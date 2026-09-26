// `riptide init` scaffolding tests.
//
// Public contract:
// - empty dirs fail by default instead of creating a fake `my-program`
// - `--blank --name <program>` explicitly opts into a manual stub
// - Anchor.toml or matching target artifacts identify the adapter name
// - init never prompts; it writes the adapters and the Workspace ignore
//   file, and no getting-started file, scenarios or personas
// - every program in a workspace gets its own adapter; --program narrows to one
// - an adapter backed by a readable IDL comes out with real entries and a
//   [lineage] residual record instead of TODO prose.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import TOML from "toml";

import { runInit } from "../src/commands/init.js";
import { detectPrograms, renderAdapterStub, scaffold } from "../src/init/index.js";
import { validateAdapter } from "../src/schemas/adapter.js";

async function mkTempRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "riptide-init-test-"));
}

async function writeAnchor(cwd: string, body: string): Promise<void> {
  await writeFile(path.join(cwd, "Anchor.toml"), body, "utf8");
}

const SINGLE_ANCHOR = `[programs.localnet]
widget_factory = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
`;

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return stderr;
}

test("init: empty temp dir fails by default", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({ force: false, dir: cwd });
  assert.equal(exit, 2);
  assert.equal(existsSync(path.join(cwd, ".riptide")), false);
});

test("init: --blank --name creates the minimal manual scaffold (no personas or scenarios)", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({ force: false, dir: cwd, blank: true, name: "manual-program" });
  assert.equal(exit, 0);

  const riptideDir = path.join(cwd, ".riptide");
  assert.ok(existsSync(path.join(riptideDir, "adapters", "manual-program.toml")));
  assert.ok(!existsSync(path.join(riptideDir, "personas")));
  assert.ok(!existsSync(path.join(riptideDir, "scenarios")));
  assert.ok(existsSync(path.join(riptideDir, ".gitignore")));
});

test("init: writes the Workspace ignore file and leaves the repo's own .gitignore alone", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");

  assert.equal(await runInit({ force: false, dir: cwd }), 0);

  const workspaceIgnore = await readFile(path.join(cwd, ".riptide", ".gitignore"), "utf8");
  const rules = workspaceIgnore.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(rules, ["target/", "runs/", "last-run.json"]);
  assert.equal(await readFile(path.join(cwd, ".gitignore"), "utf8"), "node_modules/\n");
});

test("init: writes no getting-started file into the Workspace", async () => {
  const cwd = await mkMultiProgramRepo();
  assert.equal(await runInit({ force: false, dir: cwd }), 0);
  assert.ok(!existsSync(path.join(cwd, ".riptide", "GETTING-STARTED.md")));
});

test("init: Anchor.toml present → inferred program name flows into adapter filename + content", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);

  const exit = await runInit({ force: false, dir: cwd });
  assert.equal(exit, 0);

  const expectedAdapter = path.join(cwd, ".riptide", "adapters", "widget-factory.toml");
  assert.ok(existsSync(expectedAdapter), `expected adapter file at ${expectedAdapter}`);
  const body = await readFile(expectedAdapter, "utf8");
  assert.ok(body.includes("widget_factory.so"), "adapter must reference widget_factory.so");
  assert.ok(body.includes("widget_factory.json"), "adapter must reference widget_factory.json");
});

test("init: refuses existing .riptide unless --force is passed", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);
  assert.equal(await runInit({ force: false, dir: cwd }), 0);
  assert.equal(await runInit({ force: false, dir: cwd }), 2);
  assert.equal(await runInit({ force: true, dir: cwd }), 0);
});

test("init: malformed Anchor.toml fails instead of guessing my-program", async () => {
  const malformed = await mkTempRepo();
  await writeAnchor(malformed, "this is not valid TOML { [ malformed },,,,\n");
  assert.equal(await runInit({ force: false, dir: malformed }), 2);
  assert.equal(existsSync(path.join(malformed, ".riptide")), false);
});

// ---------------------------------------------------------------------------
// Multi-program detection + fully-defaulted adapters
// ---------------------------------------------------------------------------

const MULTI_ANCHOR = `[programs.localnet]
widget_factory = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
token_vault = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnT"
`;

const WIDGET_FACTORY_IDL = {
  address: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
  instructions: [
    {
      name: "mine",
      discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
      accounts: [
        { name: "authority", signer: true },
        { name: "player", writable: true },
        { name: "system_program" }
      ],
      args: [{ name: "amount", type: "u64" }]
    },
    {
      name: "craft",
      discriminator: [2, 3, 4, 5, 6, 7, 8, 9],
      accounts: [
        { name: "authority", signer: true },
        { name: "player", writable: true }
      ],
      args: []
    },
    {
      // Two runtime args: Riptide would have to invent the second literal.
      name: "swap",
      discriminator: [3, 4, 5, 6, 7, 8, 9, 10],
      accounts: [
        { name: "authority", signer: true },
        { name: "player", writable: true }
      ],
      args: [
        { name: "amount_in", type: "u64" },
        { name: "min_out", type: "u64" }
      ]
    },
    {
      // Touches a dynamically-sized account: space is not derivable.
      name: "list_for_sale",
      discriminator: [4, 5, 6, 7, 8, 9, 10, 11],
      accounts: [
        { name: "authority", signer: true },
        { name: "marketplace", writable: true }
      ],
      args: [{ name: "amount", type: "u64" }]
    }
  ],
  accounts: [
    { name: "Player", discriminator: [10, 11, 12, 13, 14, 15, 16, 17] },
    { name: "Marketplace", discriminator: [20, 21, 22, 23, 24, 25, 26, 27] }
  ],
  types: [
    {
      name: "Player",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "pubkey" },
          { name: "gold", type: "u64" },
          { name: "wood", type: "u64" }
        ]
      }
    },
    {
      name: "Marketplace",
      type: {
        kind: "struct",
        fields: [{ name: "listings", type: { vec: "u64" } }]
      }
    }
  ]
};

const TOKEN_VAULT_IDL = {
  address: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnT",
  instructions: [
    {
      name: "deposit",
      discriminator: [5, 6, 7, 8, 9, 10, 11, 12],
      accounts: [
        { name: "authority", signer: true },
        { name: "vault", writable: true }
      ],
      args: [{ name: "amount", type: "u64" }]
    },
    {
      name: "withdraw",
      discriminator: [6, 7, 8, 9, 10, 11, 12, 13],
      accounts: [
        { name: "authority", signer: true },
        { name: "vault", writable: true }
      ],
      args: [{ name: "amount", type: "u64" }]
    }
  ],
  accounts: [{ name: "Vault", discriminator: [30, 31, 32, 33, 34, 35, 36, 37] }],
  types: [
    {
      name: "Vault",
      type: {
        kind: "struct",
        fields: [
          { name: "authority", type: "pubkey" },
          { name: "balance", type: "u64" },
          { name: "frozen", type: "bool" }
        ]
      }
    }
  ]
};

async function writeArtifacts(
  cwd: string,
  programs: Array<{ soName: string; idl?: unknown }>
): Promise<void> {
  await mkdir(path.join(cwd, "target", "deploy"), { recursive: true });
  await mkdir(path.join(cwd, "target", "idl"), { recursive: true });
  for (const program of programs) {
    await writeFile(path.join(cwd, "target", "deploy", `${program.soName}.so`), "so", "utf8");
    if (program.idl !== undefined) {
      await writeFile(
        path.join(cwd, "target", "idl", `${program.soName}.json`),
        JSON.stringify(program.idl, null, 2),
        "utf8"
      );
    }
  }
}

async function mkMultiProgramRepo(): Promise<string> {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, MULTI_ANCHOR);
  await writeArtifacts(cwd, [
    { soName: "widget_factory", idl: WIDGET_FACTORY_IDL },
    { soName: "token_vault", idl: TOKEN_VAULT_IDL }
  ]);
  return cwd;
}

async function readAdapter(cwd: string, programName: string): Promise<string> {
  return readFile(path.join(cwd, ".riptide", "adapters", `${programName}.toml`), "utf8");
}

function validateAdapterAt(cwd: string, programName: string, body: string) {
  return validateAdapter(
    TOML.parse(body),
    path.join(cwd, ".riptide", "adapters", `${programName}.toml`)
  );
}

test("detectPrograms: every Anchor.toml program is detected, sorted", async () => {
  const cwd = await mkMultiProgramRepo();
  const detected = detectPrograms(cwd);
  assert.deepEqual(
    detected.map((entry) => entry.programName),
    ["token-vault", "widget-factory"]
  );
  assert.deepEqual(new Set(detected.map((entry) => entry.source)), new Set(["anchor"]));
  assert.deepEqual(detected.flatMap((entry) => entry.warnings), []);
});

test("detectPrograms: every matching artifact pair is detected when there is no Anchor.toml", async () => {
  const cwd = await mkTempRepo();
  await writeArtifacts(cwd, [
    { soName: "widget_factory", idl: WIDGET_FACTORY_IDL },
    { soName: "token_vault", idl: TOKEN_VAULT_IDL }
  ]);
  const detected = detectPrograms(cwd);
  assert.deepEqual(
    detected.map((entry) => entry.programName),
    ["token-vault", "widget-factory"]
  );
  assert.deepEqual(new Set(detected.map((entry) => entry.source)), new Set(["artifacts"]));
});

test("init: multi-program workspace scaffolds one adapter per program without prompting", async () => {
  const cwd = await mkMultiProgramRepo();

  const stderr = await captureStderr(async () => {
    assert.equal(await runInit({ force: false, dir: cwd }), 0);
  });

  assert.ok(existsSync(path.join(cwd, ".riptide", "adapters", "widget-factory.toml")));
  assert.ok(existsSync(path.join(cwd, ".riptide", "adapters", "token-vault.toml")));
  assert.match(stderr, /\.riptide\/adapters\/token-vault\.toml/);
  assert.match(stderr, /\.riptide\/adapters\/widget-factory\.toml/);
  assert.doesNotMatch(stderr, /could not infer exactly one program name/);
});

test("init: --program narrows a multi-program workspace to one adapter", async () => {
  const cwd = await mkMultiProgramRepo();
  const exit = await runInit({ force: false, dir: cwd, program: "token-vault" });
  assert.equal(exit, 0);

  assert.ok(existsSync(path.join(cwd, ".riptide", "adapters", "token-vault.toml")));
  assert.ok(!existsSync(path.join(cwd, ".riptide", "adapters", "widget-factory.toml")));
});

test("init: --program with an unknown name fails and names every detected program", async () => {
  const cwd = await mkMultiProgramRepo();
  const stderr = await captureStderr(async () => {
    const exit = await runInit({ force: false, dir: cwd, program: "nope" });
    assert.equal(exit, 2);
  });

  assert.match(stderr, /nope/);
  assert.match(stderr, /token-vault/);
  assert.match(stderr, /widget-factory/);
  assert.equal(existsSync(path.join(cwd, ".riptide")), false);
});

test("init: IDL-backed default adapter is runnable, not a TODO sheet", async () => {
  const cwd = await mkMultiProgramRepo();
  assert.equal(await runInit({ force: false, dir: cwd }), 0);

  const body = await readAdapter(cwd, "widget-factory");
  assert.doesNotMatch(body, /TODO/);

  const adapter = validateAdapterAt(cwd, "widget-factory", body);

  // Sized, IDL-derived account: 8-byte discriminator + pubkey + 2 * u64.
  assert.equal(adapter.accounts.player?.kind, "agent");
  assert.equal(adapter.accounts.player?.space, 56);
  // Dynamically-sized account is never given an invented byte count.
  assert.equal("marketplace" in adapter.accounts, false);

  // Only instructions whose accounts and args fully resolve are mapped.
  assert.deepEqual(Object.keys(adapter.instructions).sort(), ["craft", "mine"]);
  assert.equal(adapter.instructions.mine?.amount, "amount");
  assert.equal(adapter.instructions.craft?.amount, undefined);
  assert.deepEqual(adapter.actions.mine?.takes, ["amount"]);
  assert.deepEqual(adapter.actions.craft?.takes, []);

  // Observations come from the IDL account fields, via [observations.auto].
  assert.equal(adapter.observations["player.gold"], "uint");
  assert.equal(adapter.observations["player.wood"], "uint");
  assert.equal(adapter.observations["player.owner"], "pubkey");
  assert.equal(adapter.state_mapping["player.gold"], "player.gold");

  // At least one generic persona wired to the mapped actions.
  const personas = Object.values(adapter.personas);
  assert.ok(personas.length >= 1, "defaulted adapter must ship a runnable persona");
  assert.deepEqual(Object.keys(personas[0]!.action_weights).sort(), ["craft", "mine"]);

  // No invented protocol semantics or invariants in the deterministic tier.
  assert.equal(adapter.semantics, undefined);
  assert.deepEqual(adapter.invariants, []);
});

test("init: residual gaps are recorded in [lineage], not as TODO prose", async () => {
  const cwd = await mkMultiProgramRepo();
  assert.equal(await runInit({ force: false, dir: cwd }), 0);

  const body = await readAdapter(cwd, "widget-factory");
  const adapter = validateAdapterAt(cwd, "widget-factory", body);
  const lineage = adapter.lineage;
  assert.ok(lineage, "defaulted adapter must record lineage");
  assert.equal(lineage.idl_source, "target/idl/widget_factory.json");
  assert.match(lineage.generator ?? "", /riptide init/);

  const unsupported = lineage.unsupported_fields.join("\n");
  assert.match(unsupported, /swap/, "multi-arg instruction must be recorded as unsupported");
  assert.match(unsupported, /list_for_sale/, "unresolvable-account instruction must be recorded");
  assert.match(unsupported, /marketplace/, "dynamically-sized account must be recorded");

  assert.ok(lineage.inferred_assumptions.length > 0, "kind/space inference must be disclosed");
});

test("init: every adapter in a multi-program workspace validates independently", async () => {
  const cwd = await mkMultiProgramRepo();
  assert.equal(await runInit({ force: false, dir: cwd }), 0);

  const vault = validateAdapterAt(cwd, "token-vault", await readAdapter(cwd, "token-vault"));
  assert.equal(vault.accounts.vault?.kind, "agent");
  assert.equal(vault.accounts.vault?.space, 49);
  assert.deepEqual(Object.keys(vault.instructions).sort(), ["deposit", "withdraw"]);
  assert.equal(vault.observations["vault.balance"], "uint");
  assert.equal(vault.observations["vault.frozen"], "bool");
  assert.equal(vault.program_so, "target/deploy/token_vault.so");
  assert.equal(vault.idl_path, "target/idl/token_vault.json");
});

test("init: a program with no IDL keeps the thin scaffold and says what is missing", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);
  await writeArtifacts(cwd, [{ soName: "widget_factory" }]);

  const stderr = await captureStderr(async () => {
    assert.equal(await runInit({ force: false, dir: cwd }), 0);
  });

  const body = await readAdapter(cwd, "widget-factory");
  assert.match(body, /thin default bootstrap/);
  assert.match(stderr, /target\/idl\/widget_factory\.json not found/);
  assert.match(stderr, /anchor build/);
});

test("init: defaulted adapter output stays inside the bounded-evidence claim", async () => {
  const cwd = await mkMultiProgramRepo();
  const stderr = await captureStderr(async () => {
    assert.equal(await runInit({ force: false, dir: cwd }), 0);
  });

  const body = await readAdapter(cwd, "widget-factory");

  for (const banned of [/\baudit\b/i, /\bverified safe\b/i, /no vulnerabilities/i, /\bsecure\b/i]) {
    assert.doesNotMatch(body, banned);
    assert.doesNotMatch(stderr, banned);
  }

  // The adapter self-labels what a run over these defaults actually is.
  assert.match(body, /simulation evidence over the\n# inputs declared here/);

  // No planning vocabulary leaks into the repo surface.
  assert.doesNotMatch(body, /\bRT-\d{3}\b/);
  assert.doesNotMatch(body, /\bSprint\b/);
});

test("detectPrograms: matching target artifacts identify a non-Anchor program", async () => {
  const cwd = await mkTempRepo();
  await mkdir(path.join(cwd, "target", "deploy"), { recursive: true });
  await mkdir(path.join(cwd, "target", "idl"), { recursive: true });
  await writeFile(path.join(cwd, "target", "deploy", "raw_program.so"), "so", "utf8");
  await writeFile(path.join(cwd, "target", "idl", "raw_program.json"), "{}", "utf8");

  const detected = detectPrograms(cwd);
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.programName, "raw-program");
  assert.equal(detected[0]!.source, "artifacts");
});

test("init: --profile aliases --protocol", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({
    force: false,
    dir: cwd,
    blank: true,
    name: "profile-program",
    profile: "amm"
  });
  assert.equal(exit, 0);

  const adapterBody = await readFile(
    path.join(cwd, ".riptide", "adapters", "profile-program.toml"),
    "utf8"
  );
  assert.match(adapterBody, /Adapter profile hint: amm/);
  assert.doesNotMatch(adapterBody, /Selected adapter type: amm/);
});

test("renderAdapterStub: contains artifact paths, empty TODO blocks, and no live persona", () => {
  const body = renderAdapterStub("foo-bar");
  assert.ok(body.includes('program_so = "target/deploy/foo_bar.so"'));
  assert.ok(body.includes('idl_path = "target/idl/foo_bar.json"'));
  assert.ok(body.includes("# TODO:"), "stub must carry TODO guidance");
  assert.ok(body.includes("[accounts]"));
  assert.ok(body.includes("[instructions]"));
  assert.ok(body.includes("[state_mapping]"));
  assert.ok(body.includes("[actions]"));
  assert.ok(body.includes("[observations]"));
  assert.ok(body.includes("[personas]"));
  assert.ok(!body.includes("\n[personas.example]"), "example persona must stay commented");
  assert.ok(body.includes("/riptide-assess"), "stub must route to the Skill");
  assert.ok(!body.includes("/riptide-config"), "stub must not name a removed skill");
});

test("renderAdapterStub: protocol arg is recorded as a hint on the generic runtime", () => {
  const lendingBody = renderAdapterStub("foo-bar", "lending");
  assert.ok(lendingBody.includes("# Adapter profile hint: lending"));
  assert.ok(lendingBody.includes('protocol = "generic"'));
  assert.ok(lendingBody.includes('program_so = "target/deploy/foo_bar.so"'));

  const ammBody = renderAdapterStub("foo-bar", "amm");
  assert.ok(ammBody.includes("# Adapter profile hint: amm"));
  assert.ok(ammBody.includes('AMM currently uses protocol = "generic"'));

  const customBody = renderAdapterStub("foo-bar", "custom");
  assert.ok(customBody.includes('protocol = "generic"'));
  assert.ok(!customBody.includes("Adapter profile hint:"));
});

test("scaffold: result records warnings for explicit blank scaffolds", async () => {
  const cwd = await mkTempRepo();
  const result = await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "manual-program"
  });
  assert.equal(result.programName, "manual-program");
  assert.deepEqual(
    result.created.sort(),
    [
      ".riptide/.gitignore",
      ".riptide/adapters/manual-program.toml"
    ].sort()
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /blank scaffold requested/);
});

test("init: lending protocol stays thin and records a profile hint", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({
    force: false,
    dir: cwd,
    blank: true,
    name: "lending",
    protocol: "lending"
  });
  assert.equal(exit, 0);

  const baselinePath = path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json");
  const oracleShockPath = path.join(
    cwd,
    ".riptide",
    "scenarios",
    "oracle-price-shock",
    "run-config.json"
  );
  assert.ok(!existsSync(baselinePath));
  assert.ok(!existsSync(oracleShockPath));
  assert.ok(!existsSync(path.join(cwd, ".riptide", "scenarios", "bank-run", "run-config.json")));

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "lending.toml"), "utf8");
  assert.match(adapterBody, /Adapter profile hint: lending/);
  assert.match(adapterBody, /^protocol = "generic"$/m);
  assert.match(adapterBody, /^program_so = "target\/deploy\/lending\.so"$/m);
  assert.match(adapterBody, /^idl_path = "target\/idl\/lending\.json"$/m);
  assert.doesNotMatch(adapterBody, /^\[\[invariants\]\]$/m);
  assert.doesNotMatch(adapterBody, /^\[semantics\]$/m);
});

test("init: non-lending protocol emits no invariant templates", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({
    force: false,
    dir: cwd,
    blank: true,
    name: "perps",
    protocol: "perpetuals"
  });
  assert.equal(exit, 0);

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "perps.toml"), "utf8");
  assert.doesNotMatch(adapterBody, /^\[\[invariants\]\]$/m);
  assert.doesNotMatch(adapterBody, /^# \[\[invariants\]\]$/m);
  assert.doesNotMatch(adapterBody, /^\[semantics\]$/m);

  const parsed = TOML.parse(adapterBody) as Record<string, unknown>;
  assert.equal("invariants" in parsed, false);
  assert.equal("semantics" in parsed, false);
});
