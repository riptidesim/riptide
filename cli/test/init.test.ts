// `riptide init` scaffolding tests.
//
// Public contract:
// - empty dirs fail by default instead of creating a fake `my-program`
// - `--blank --name <program>` explicitly opts into a manual stub
// - Anchor.toml or matching target artifacts identify the adapter name
// - plain init never opens the questionnaire
// - the --wizard path collects program name, protocol,
//   inline personas, agents, ticks, seeds; defaults reproduce the non-interactive output
// - non-interactive runs (--yes, no-TTY, --quiet) scaffold only the adapter,
//   GETTING-STARTED.md, and .gitignore entries; no scenarios or personas are generated.
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
import {
  detectProgram,
  detectPrograms,
  inferProgramName,
  renderAdapterStub,
  renderGettingStarted,
  renderInvariantsSection,
  renderRunConfig,
  renderSemanticsSection,
  scaffold
} from "../src/init/index.js";
import { validateAdapter } from "../src/schemas/adapter.js";
import type { WizardAnswers } from "../src/init/wizard.js";
import {
  invariantChoicesFor,
  invariantConfigFromCatalog,
  type InitInvariantConfig
} from "../src/init/invariants-catalog.js";

async function mkTempRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "riptide-init-test-"));
}

async function writeAnchor(cwd: string, body: string): Promise<void> {
  await writeFile(path.join(cwd, "Anchor.toml"), body, "utf8");
}

const SINGLE_ANCHOR = `[programs.localnet]
widget_factory = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
`;

function initInvariant(protocol: "lending", name: string): InitInvariantConfig {
  const entry = invariantChoicesFor(protocol).find((choice) => choice.name === name);
  assert.ok(entry, `expected invariant catalog entry ${name}`);
  return invariantConfigFromCatalog(entry);
}

function countOccurrences(body: string, needle: string): number {
  return body.split(needle).length - 1;
}

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
  assert.ok(existsSync(path.join(riptideDir, "GETTING-STARTED.md")));
  assert.ok(!existsSync(path.join(riptideDir, "personas")));
  assert.ok(!existsSync(path.join(riptideDir, "scenarios", "baseline", "run-config.json")));

  const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
  assert.match(gitignore, /\.riptide\/runs\//);
  assert.match(gitignore, /\.riptide\/last-run\.json/);
});

test("init: plain TTY init does not call the wizard", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);

  let wizardCalled = false;
  const stderr = await captureStderr(async () => {
    const exit = await runInit(
      { force: false, dir: cwd },
      {
        isTTY: true,
        promptWizard: async () => {
          wizardCalled = true;
          throw new Error("plain init should not run the wizard");
        }
      }
    );
    assert.equal(exit, 0);
  });

  assert.equal(wizardCalled, false);
  assert.match(stderr, /Invoke \/riptide-config/);
  assert.ok(!existsSync(path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json")));
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

test("init: existing .riptide fails before interactive wizard", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);
  assert.equal(await runInit({ force: false, dir: cwd }), 0);

  let wizardCalled = false;
  const exit = await runInit(
    { force: false, dir: cwd },
    {
      isTTY: true,
      promptWizard: async () => {
        wizardCalled = true;
        throw new Error("wizard should not run when .riptide already exists");
      }
    }
  );
  assert.equal(exit, 2);
  assert.equal(wizardCalled, false);
});

test("init: missing Solana program fails before interactive wizard", async () => {
  const cwd = await mkTempRepo();

  let wizardCalled = false;
  const exit = await runInit(
    { force: false, dir: cwd },
    {
      isTTY: true,
      promptWizard: async () => {
        wizardCalled = true;
        throw new Error("wizard should not run without a detected program");
      }
    }
  );
  assert.equal(exit, 2);
  assert.equal(wizardCalled, false);
  assert.equal(existsSync(path.join(cwd, ".riptide")), false);
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

  let wizardCalled = false;
  const stderr = await captureStderr(async () => {
    const exit = await runInit(
      { force: false, dir: cwd },
      {
        isTTY: true,
        promptWizard: async () => {
          wizardCalled = true;
          throw new Error("default init must never prompt");
        }
      }
    );
    assert.equal(exit, 0);
  });

  assert.equal(wizardCalled, false);
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
  const gettingStarted = await readFile(
    path.join(cwd, ".riptide", "GETTING-STARTED.md"),
    "utf8"
  );

  for (const banned of [/\baudit\b/i, /\bverified safe\b/i, /no vulnerabilities/i, /\bsecure\b/i]) {
    assert.doesNotMatch(body, banned);
    assert.doesNotMatch(stderr, banned);
    assert.doesNotMatch(gettingStarted, banned);
  }

  // Each surface self-labels what a run over these defaults actually is.
  assert.match(body, /simulation evidence over the\n# inputs declared here/);
  assert.match(stderr, /simulation evidence over the inputs they declare/);
  assert.match(gettingStarted, /simulation evidence over the inputs your adapter declares/);

  // No planning vocabulary leaks into the repo surface.
  for (const surface of [body, gettingStarted]) {
    assert.doesNotMatch(surface, /\bRT-\d{3}\b/);
    assert.doesNotMatch(surface, /\bSprint\b/);
  }
});

test("init: getting-started keeps multi-program sims in separate crate directories", async () => {
  const cwd = await mkMultiProgramRepo();
  assert.equal(await runInit({ force: false, dir: cwd }), 0);

  const gettingStarted = await readFile(
    path.join(cwd, ".riptide", "GETTING-STARTED.md"),
    "utf8"
  );
  // `sim generate` defaults to .riptide/sim, so a shared directory would
  // have the second program silently clobber the first.
  assert.match(gettingStarted, /--dir \.riptide\/sim\/token-vault/);
  assert.match(gettingStarted, /--dir \.riptide\/sim\/widget-factory/);
  assert.match(gettingStarted, /riptide sim run \.riptide\/sim\/token-vault --flows 8/);
  assert.doesNotMatch(gettingStarted, /riptide sim run \.riptide\/sim --flows 8/);
});

test("init: a single defaulted program keeps the plain .riptide/sim path", async () => {
  const cwd = await mkMultiProgramRepo();
  assert.equal(await runInit({ force: false, dir: cwd, program: "token-vault" }), 0);

  const gettingStarted = await readFile(
    path.join(cwd, ".riptide", "GETTING-STARTED.md"),
    "utf8"
  );
  assert.match(gettingStarted, /riptide sim run \.riptide\/sim --flows 8/);
  assert.doesNotMatch(gettingStarted, /--dir \.riptide\/sim\//);
});

test("detectProgram: matching target artifacts identify a non-Anchor program", async () => {
  const cwd = await mkTempRepo();
  await mkdir(path.join(cwd, "target", "deploy"), { recursive: true });
  await mkdir(path.join(cwd, "target", "idl"), { recursive: true });
  await writeFile(path.join(cwd, "target", "deploy", "raw_program.so"), "so", "utf8");
  await writeFile(path.join(cwd, "target", "idl", "raw_program.json"), "{}", "utf8");

  const detected = detectProgram(cwd);
  assert.equal(detected.programName, "raw-program");
  assert.equal(detected.source, "artifacts");
});

test("scaffold: wizard init prefills compact IDL-backed adapter hints", async () => {
  const cwd = await mkTempRepo();
  await mkdir(path.join(cwd, "target", "deploy"), { recursive: true });
  await mkdir(path.join(cwd, "target", "idl"), { recursive: true });
  await writeFile(path.join(cwd, "target", "deploy", "raw_program.so"), "so", "utf8");
  await writeFile(
    path.join(cwd, "target", "idl", "raw_program.json"),
    JSON.stringify({
      instructions: [
        { name: "mine", args: [{ name: "amount", type: "u64" }] },
        {
          name: "swap",
          args: [
            { name: "amount_in", type: "u64" },
            { name: "min_out", type: "u64" },
          ],
        },
      ],
      accounts: [
        {
          name: "pool",
          size: 64,
          type: {
            fields: [
              { name: "reserve_a", type: "u64" },
              { name: "active", type: "bool" },
            ],
          },
        },
      ],
    }),
    "utf8"
  );

  const result = await scaffold({
    cwd,
    force: false,
    protocol: "custom",
    mode: "wizard"
  });

  assert.equal(result.programName, "raw-program");
  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "raw-program.toml"), "utf8");
  assert.match(adapterBody, /^\[accounts\.pool\]$/m);
  assert.match(adapterBody, /^space = "auto"$/m);
  assert.match(adapterBody, /^\[instructions\.mine\.bindings\]$/m);
  assert.match(adapterBody, /^amount = "@runtime\.amount"$/m);
  assert.match(adapterBody, /^\[actions\.mine\]$/m);
  assert.match(adapterBody, /^\[observations\.auto\]$/m);
  assert.match(adapterBody, /^accounts = \["pool"\]$/m);
  assert.match(adapterBody, /# \[instructions\.swap\]/);
});

test("init: --profile aliases --protocol for non-interactive scaffolds", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({
    force: false,
    dir: cwd,
    blank: true,
    name: "profile-program",
    profile: "amm",
    yes: true
  });
  assert.equal(exit, 0);

  const adapterBody = await readFile(
    path.join(cwd, ".riptide", "adapters", "profile-program.toml"),
    "utf8"
  );
  assert.match(adapterBody, /Adapter profile hint: amm/);
  assert.doesNotMatch(adapterBody, /Selected adapter type: amm/);
});

test("inferProgramName: Anchor.toml names one program, otherwise null", async () => {
  const empty = await mkTempRepo();
  assert.equal(inferProgramName(empty), null);

  const anchor = await mkTempRepo();
  await writeAnchor(anchor, SINGLE_ANCHOR);
  assert.equal(inferProgramName(anchor), "widget-factory");

  const ambiguous = await mkTempRepo();
  await writeAnchor(
    ambiguous,
    `[programs.localnet]
alpha = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
beta = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnT"
`
  );
  assert.equal(inferProgramName(ambiguous), null);
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
});

test("renderAdapterStub: protocol arg drives the protocol field + intent comment", () => {
  const lendingBody = renderAdapterStub("foo-bar", "lending");
  assert.ok(lendingBody.includes('protocol = "lending"'));
  assert.ok(lendingBody.includes("Selected adapter type: lending"));
  assert.ok(!lendingBody.includes('program_so = "target/deploy/foo_bar.so"'));
  assert.ok(!lendingBody.includes('idl_path = "target/idl/foo_bar.json"'));
  assert.ok(!lendingBody.includes("\n[accounts]\n"));
  assert.ok(lendingBody.includes("[actions.deposit]"));
  assert.ok(lendingBody.includes('deposit   = { action = "deposit"'));
  assert.equal(validateAdapter(TOML.parse(lendingBody), "lending.toml").protocol, "lending");

  const ammBody = renderAdapterStub("foo-bar", "amm");
  assert.ok(ammBody.includes('protocol = "generic"'), "non-lending protocols use the generic engine path");
  assert.ok(ammBody.includes("Selected adapter type: amm"));
  assert.ok(ammBody.includes('AMM currently uses protocol = "generic"'));

  const customBody = renderAdapterStub("foo-bar", "custom");
  assert.ok(customBody.includes('protocol = "generic"'));
  assert.ok(!customBody.includes("Selected adapter type:"));
});

test("scaffold: Anchor anchor_uniswap_v2 AMM repos use generic runtime paths", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, `[programs.localnet]
anchor_uniswap_v2 = "11111111111111111111111111111111"
`);

  const result = await scaffold({
    cwd,
    force: false,
    protocol: "amm",
    mode: "wizard"
  });

  assert.equal(result.programName, "anchor-uniswap-v2");
  assert.ok(result.created.includes(".riptide/adapters/anchor-uniswap-v2.toml"));
  assert.ok(result.created.includes(".riptide/scenarios/baseline/run-config.json"));
  assert.ok(!existsSync(path.join(cwd, ".riptide", "personas")));
  assert.match(result.warnings.join("\n"), /target\/deploy\/anchor_uniswap_v2\.so not found/);
  assert.match(result.warnings.join("\n"), /target\/idl\/anchor_uniswap_v2\.json not found/);

  const adapterBody = await readFile(
    path.join(cwd, ".riptide", "adapters", "anchor-uniswap-v2.toml"),
    "utf8"
  );
  assert.match(adapterBody, /Selected adapter type: amm/);
  assert.match(adapterBody, /^protocol = "generic"$/m);
  assert.match(adapterBody, /^program_so = "target\/deploy\/anchor_uniswap_v2\.so"$/m);
  assert.match(adapterBody, /^idl_path = "target\/idl\/anchor_uniswap_v2\.json"$/m);
  assert.match(adapterBody, /AMM currently uses protocol = "generic"/);

  const runConfig = JSON.parse(
    await readFile(
      path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json"),
      "utf8"
    )
  ) as { agents: number; ticks: number; seeds: number; personas: string[] };
  assert.equal(runConfig.agents, 100);
  assert.equal(runConfig.ticks, 30);
  assert.equal(runConfig.seeds, 50);
  assert.deepEqual(runConfig.personas, []);
});

test("renderGettingStarted: guided-sim commands and amm runtime note", () => {
  const body = renderGettingStarted("anchor-uniswap-v2", {
    scenarios: ["baseline"],
    seeds: 50,
    protocol: "amm",
    mode: "wizard"
  });

  assert.match(
    body,
    /riptide sim generate --adapter \.riptide\/adapters\/anchor-uniswap-v2\.toml/
  );
  assert.match(body, /riptide sim run \.riptide\/sim --flows 8/);
  assert.match(body, /riptide assess <guided-sim-root>/);
  assert.match(body, /AMM currently uses `protocol = "generic"`/);
  assert.doesNotMatch(body, /riptide run/);
  assert.doesNotMatch(body, /--harness/);
  assert.doesNotMatch(body, /riptide campaign/);
});

test("init: next steps point at riptide-config by default", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, `[programs.localnet]
anchor_uniswap_v2 = "11111111111111111111111111111111"
`);

  let wizardCalled = false;
  const stderr = await captureStderr(async () => {
    const exit = await runInit(
      { force: false, dir: cwd },
      {
        isTTY: true,
        promptWizard: async () => {
          wizardCalled = true;
          throw new Error("plain init should not run the wizard");
        }
      }
    );
    assert.equal(exit, 0);
  });

  assert.equal(wizardCalled, false);
  assert.match(stderr, /Next steps:/);
  assert.match(stderr, /1\. Invoke \/riptide-config/);
  assert.match(stderr, /riptide sim generate --adapter \.riptide\/adapters\/anchor-uniswap-v2\.toml/);
  assert.match(stderr, /riptide sim run \.riptide\/sim --flows 8/);
  assert.match(stderr, /riptide assess <guided-sim-root>/);
  assert.match(stderr, /Advanced: run riptide init --wizard --force/);
  assert.match(stderr, /replace this thin scaffold with questionnaire-selected starter files/);
  assert.match(stderr, /More detail: \.riptide\/GETTING-STARTED\.md/);
  assert.doesNotMatch(stderr, /riptide campaign/);
  assert.doesNotMatch(stderr, /riptide review/);
  assert.ok(!existsSync(path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json")));
});

test("renderAdapterStub: selected persona blocks are embedded in the adapter", () => {
  const body = renderAdapterStub("foo-bar", "custom", {
    personaBlocks: [
      `[personas.swapper]
label = "Swapper"
action_rate_multiplier = 1.0
action_weights = { swap = 1.0 }
triggers = []
`
    ]
  });
  assert.ok(body.includes("Personas selected during `riptide init`"));
  assert.ok(body.includes("[personas.swapper]"));
  assert.ok(!body.includes("[personas.example]"));
});

test("renderInvariantsSection: empty selection emits no top-level header", () => {
  assert.equal(renderInvariantsSection([]), "");
});

test("renderSemanticsSection: only lending emits a semantics block", () => {
  const semantic = initInvariant("lending", "health_factor_positive");
  assert.equal(renderSemanticsSection([semantic], "perpetuals"), "");

  const lending = renderSemanticsSection([semantic], "lending");
  assert.match(lending, /^\[semantics\]/m);
  assert.match(lending, /^class = "lending\.v1"$/m);
  assert.match(lending, /^\[\[semantics\.invariants\]\]$/m);
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
      ".claude/skills/riptide-config",
      ".gitignore",
      ".riptide/GETTING-STARTED.md",
      ".riptide/adapters/manual-program.toml"
    ].sort()
  );
  assert.deepEqual(result.scenarios, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /blank scaffold requested/);
});

test("scaffold: protocol + personas → matching persona blocks are inlined in the adapter", async () => {
  const cwd = await mkTempRepo();
  const result = await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "amm-program",
    protocol: "amm",
    personas: ["swapper", "arbitrageur"],
    agents: 15,
    ticks: 25,
    mode: "wizard"
  });

  const personasDir = path.join(cwd, ".riptide", "personas");
  assert.ok(!existsSync(personasDir), "init must not scaffold a duplicate personas/ directory");

  // Scenario reflects wizard answers.
  const runConfigBody = await readFile(
    path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json"),
    "utf8"
  );
  const runConfig = JSON.parse(runConfigBody) as {
    agents: number;
    ticks: number;
    personas: Record<string, number>;
  };
  assert.equal(runConfig.agents, 15);
  assert.equal(runConfig.ticks, 25);
  assert.deepEqual(runConfig.personas, { swapper: 8, arbitrageur: 7 });

  // Created list does not include duplicate persona files.
  assert.equal(result.created.some((rel) => rel.startsWith(".riptide/personas/")), false);

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "amm-program.toml"), "utf8");
  assert.ok(adapterBody.includes("[personas.swapper]"));
  assert.ok(adapterBody.includes("[personas.arbitrageur]"));
});

test("scaffold: one seed writes a seeded run-config and never scaffolds a Rust harness", async () => {
  const cwd = await mkTempRepo();
  const result = await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "amm-program",
    protocol: "amm",
    personas: ["swapper"],
    agents: 100,
    ticks: 10,
    seeds: 1,
    mode: "wizard"
  });

  assert.equal(result.seeds, 1);
  assert.equal(result.created.some((rel) => rel.startsWith(".riptide/harness")), false);
  assert.ok(!existsSync(path.join(cwd, ".riptide", "harness")));

  const runConfig = JSON.parse(
    await readFile(
      path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json"),
      "utf8"
    )
  ) as { seed?: number; seeds?: number; agents: number; ticks: number };
  assert.equal(runConfig.seed, 1337);
  assert.equal(runConfig.seeds, undefined);
  assert.equal(runConfig.agents, 100);
  assert.equal(runConfig.ticks, 10);

  const gettingStarted = await readFile(path.join(cwd, ".riptide", "GETTING-STARTED.md"), "utf8");
  assert.match(gettingStarted, /riptide sim run \.riptide\/sim --flows 8/);
  assert.doesNotMatch(gettingStarted, /--harness/);
  assert.doesNotMatch(gettingStarted, /riptide-engine/);
});

test("scaffold: explicit scenario battery writes each run-config with scenario-specific sizing", async () => {
  const cwd = await mkTempRepo();
  const result = await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "lending",
    protocol: "lending",
    personas: ["steady-lp"],
    mode: "wizard",
    scenarios: [
      {
        name: "baseline",
        scenario: "baseline",
        agents: 12,
        ticks: 34,
        personas: ["steady-lp"]
      },
      {
        name: "oracle-price-shock",
        scenario: "price-shock",
        agents: 50,
        ticks: 60,
        personas: ["steady-lp", "panic-whale", "degen-borrower"]
      }
    ]
  });

  const baseline = JSON.parse(
    await readFile(
      path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json"),
      "utf8"
    )
  ) as { agents: number; ticks: number; scenario: string; personas: Record<string, number> };
  assert.equal(baseline.scenario, "baseline");
  assert.equal(baseline.agents, 12);
  assert.equal(baseline.ticks, 34);
  assert.deepEqual(baseline.personas, { "steady-lp": 12 });

  const oracleShock = JSON.parse(
    await readFile(
      path.join(cwd, ".riptide", "scenarios", "oracle-price-shock", "run-config.json"),
      "utf8"
    )
  ) as { agents: number; ticks: number; scenario: string; personas: Record<string, number> };
  assert.equal(oracleShock.scenario, "price-shock");
  assert.equal(oracleShock.agents, 50);
  assert.equal(oracleShock.ticks, 60);
  assert.deepEqual(oracleShock.personas, {
    "steady-lp": 17,
    "panic-whale": 17,
    "degen-borrower": 16
  });
  assert.equal("validator_url" in oracleShock, false);

  assert.ok(result.created.includes(".riptide/scenarios/baseline/run-config.json"));
  assert.ok(result.created.includes(".riptide/scenarios/oracle-price-shock/run-config.json"));
  assert.equal(result.created.some((rel) => rel.startsWith(".riptide/personas/")), false);
  assert.ok(!existsSync(path.join(cwd, ".riptide", "personas")));

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "lending.toml"), "utf8");
  assert.ok(adapterBody.includes("[personas.panic-whale]"));
  assert.ok(adapterBody.includes("[personas.degen-borrower]"));
});

test("scaffold: required catalog scenarios are retained when caller passes an empty selection", async () => {
  const cwd = await mkTempRepo();
  await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "lending",
    protocol: "lending",
    personas: [],
    scenarios: [],
    mode: "wizard"
  });

  assert.ok(existsSync(path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json")));
  assert.ok(!existsSync(path.join(cwd, ".riptide", "scenarios", "oracle-price-shock", "run-config.json")));
});

test("scaffold: required invariants are retained and explicit duplicates are uniqued", async () => {
  const cwd = await mkTempRepo();
  await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "lending",
    protocol: "lending",
    mode: "wizard",
    invariants: [
      initInvariant("lending", "no_bad_debt"),
      initInvariant("lending", "health_factor_positive"),
      initInvariant("lending", "health_factor_positive")
    ]
  });

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "lending.toml"), "utf8");
  assert.equal(countOccurrences(adapterBody, 'name = "no_bad_debt"'), 1);
  assert.equal(countOccurrences(adapterBody, 'name = "active_agents_survive"'), 1);
  assert.equal(countOccurrences(adapterBody, 'name = "health_factor_positive"'), 1);
});

test("scaffold: custom protocol inlines generic personas from the custom bucket", async () => {
  const cwd = await mkTempRepo();
  await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "manual-program",
    protocol: "custom",
    personas: ["swapper", "whale"],
    mode: "wizard"
  });
  assert.ok(!existsSync(path.join(cwd, ".riptide", "personas")));
  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "manual-program.toml"), "utf8");
  assert.ok(adapterBody.includes("[personas.swapper]"));
  assert.ok(adapterBody.includes("[personas.whale]"));
});

test("scaffold: empty persona list does not create a personas/ directory", async () => {
  const cwd = await mkTempRepo();
  await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "manual-program",
    protocol: "custom",
    personas: [],
    mode: "wizard"
  });
  assert.ok(!existsSync(path.join(cwd, ".riptide", "personas")));
});

test("scaffold: lending protocol embeds selected policy personas and starter actions", async () => {
  const cwd = await mkTempRepo();
  await scaffold({
    cwd,
    force: false,
    blank: true,
    programName: "lending",
    protocol: "lending",
    personas: ["steady-lp", "whale"],
    agents: 1000,
    ticks: 30,
    mode: "wizard"
  });

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "lending.toml"), "utf8");
  assert.ok(!adapterBody.includes('program_so = "target/deploy/lending.so"'));
  assert.ok(!adapterBody.includes('idl_path = "target/idl/lending.json"'));
  assert.ok(!adapterBody.includes("\n[accounts]\n"));
  assert.ok(adapterBody.includes("[actions.deposit]"));
  assert.ok(adapterBody.includes("[actions.borrow]"));
  assert.ok(adapterBody.includes("[personas.steady-lp]"));
  assert.ok(adapterBody.includes("[personas.whale]"));
  assert.ok(adapterBody.includes("action_weights = { deposit = 0.8"));
  assert.ok(adapterBody.includes("action_weights = { deposit = 0.3, borrow = 1"));

  const runConfig = JSON.parse(
    await readFile(
      path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json"),
      "utf8"
    )
  ) as { agents: number; ticks: number; personas: Record<string, number> };
  assert.equal(runConfig.agents, 1000);
  assert.equal(runConfig.ticks, 30);
  assert.deepEqual(runConfig.personas, { "steady-lp": 500, whale: 500 });
});

test("renderRunConfig: emits canonical seedless shape without validator_url", () => {
  const body = renderRunConfig({
    agents: 10,
    ticks: 30,
    scenario: "baseline",
    personas: [],
    outputPath: ".riptide/runs/baseline"
  });
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.agents, 10);
  assert.equal(parsed.ticks, 30);
  assert.equal(parsed.scenario, "baseline");
  assert.equal("seed" in parsed, false);
  assert.deepEqual(parsed.personas, []);
  assert.equal(parsed.output_path, ".riptide/runs/baseline");
  assert.equal("validator_url" in parsed, false);
});

test("renderRunConfig: one seed emits an explicit deterministic seed", () => {
  const body = renderRunConfig({
    agents: 10,
    ticks: 30,
    seeds: 1,
    scenario: "baseline",
    personas: [],
    outputPath: ".riptide/runs/baseline"
  });
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.seed, 1337);
  assert.equal("seeds" in parsed, false);
});

test("renderRunConfig: multiple seeds emits a sweep count", () => {
  const body = renderRunConfig({
    agents: 10,
    ticks: 30,
    seeds: 20,
    scenario: "baseline",
    personas: [],
    outputPath: ".riptide/runs/baseline"
  });
  const parsed = JSON.parse(body) as Record<string, unknown>;
  assert.equal(parsed.seeds, 20);
  assert.equal("seed" in parsed, false);
});

test("renderGettingStarted: guided-sim copy with no references to removed commands", () => {
  const withBoth = renderGettingStarted("my-program", {
    scenarios: ["baseline", "oracle-price-shock"],
    mode: "wizard"
  });
  assert.ok(withBoth.includes("my-program"));
  assert.ok(withBoth.includes("scenarios/baseline/run-config.json"));
  assert.ok(withBoth.includes("scenarios/oracle-price-shock/run-config.json"));
  assert.ok(withBoth.includes("riptide sim generate --adapter .riptide/adapters/my-program.toml"));
  assert.ok(withBoth.includes("riptide sim run .riptide/sim --flows 8"));
  assert.ok(withBoth.includes("riptide assess <guided-sim-root>"));
  assert.ok(withBoth.includes("adapters/my-program.toml` `[personas.*]"));
  assert.ok(withBoth.includes("## Skill-First Setup"));
  assert.ok(withBoth.includes("`/riptide-config`"));
  assert.ok(withBoth.includes("`riptide-narrative`"));
  assert.ok(!withBoth.includes("personas/*.toml"));
  assert.ok(!withBoth.includes("amm.v1"));
  assert.ok(!withBoth.includes("riptide run"));
  assert.ok(!withBoth.includes("riptide campaign"));
  assert.ok(!withBoth.includes("riptide lint"));
  assert.ok(!withBoth.includes("--harness"));
  assert.ok(!withBoth.includes("riptide-engine"));

  const minimal = renderGettingStarted("my-program");
  assert.ok(minimal.includes("/riptide-config"));
  assert.ok(minimal.includes("riptide sim generate --adapter .riptide/adapters/my-program.toml"));
  assert.ok(minimal.includes("riptide assess <guided-sim-root>"));
  assert.ok(!minimal.includes("adapters/my-program.toml` `[personas.*]"));
  assert.ok(!minimal.includes("personas/*.toml"));
  assert.ok(!minimal.includes("scenarios/baseline/run-config.json"));
});

test("init: wizard answers thread into scaffold output (injected promptWizard)", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);

  const fakeAnswers: WizardAnswers = {
    programName: "widget-factory",
    protocol: "amm",
    seeds: 50,
    personas: ["swapper"],
    scenarios: [
      {
        name: "baseline",
        scenario: "baseline",
        agents: 7,
        ticks: 12,
        personas: ["swapper"]
      }
    ],
    invariants: [],
    agents: 7,
    ticks: 12
  };
  const exit = await runInit(
    { force: false, dir: cwd, wizard: true },
    {
      isTTY: true,
      promptWizard: async () => fakeAnswers
    }
  );
  assert.equal(exit, 0);

  // Adapter reflects the chosen protocol.
  const adapterBody = await readFile(
    path.join(cwd, ".riptide", "adapters", "widget-factory.toml"),
    "utf8"
  );
  assert.ok(adapterBody.includes("Selected adapter type: amm"));

  // Only the adapter carries persona definitions; no duplicate persona files are written.
  assert.ok(!existsSync(path.join(cwd, ".riptide", "personas")));
  assert.ok(adapterBody.includes("[personas.swapper]"));
  assert.ok(!adapterBody.includes("[personas.arbitrageur]"));

  // Scenario carries the chosen agents/ticks/personas.
  const runConfig = JSON.parse(
    await readFile(
      path.join(cwd, ".riptide", "scenarios", "baseline", "run-config.json"),
      "utf8"
    )
  ) as { agents: number; ticks: number; personas: Record<string, number> };
  assert.equal(runConfig.agents, 7);
  assert.equal(runConfig.ticks, 12);
  assert.deepEqual(runConfig.personas, { swapper: 7 });
});

test("init: --yes skips the wizard even when isTTY is true", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);

  let wizardCalled = false;
  const exit = await runInit(
    { force: false, dir: cwd, yes: true },
    {
      isTTY: true,
      promptWizard: async () => {
        wizardCalled = true;
        throw new Error("wizard should not run under --yes");
      }
    }
  );
  assert.equal(exit, 0);
  assert.equal(wizardCalled, false);
});

test("init: --wizard requires an interactive TTY", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);

  const exit = await runInit(
    { force: false, dir: cwd, wizard: true },
    { isTTY: false }
  );
  assert.equal(exit, 2);
  assert.equal(existsSync(path.join(cwd, ".riptide")), false);
});

test("init: --yes with lending protocol stays minimal and records a profile hint", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({
    force: false,
    dir: cwd,
    blank: true,
    name: "lending",
    protocol: "lending",
    yes: true
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

test("init: --yes with non-lending protocol emits no invariant templates", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({
    force: false,
    dir: cwd,
    blank: true,
    name: "perps",
    protocol: "perpetuals",
    yes: true
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
