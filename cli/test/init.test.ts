// `riptide init` scaffolding tests.
//
// Public contract:
// - empty dirs fail by default instead of creating a fake `my-program`
// - `--blank --name <program>` explicitly opts into a manual stub
// - Anchor.toml or matching target artifacts identify the adapter name
// - the wizard (when run) collects program name, protocol, setup harness,
//   inline personas, agents, ticks, seeds; defaults reproduce the non-interactive output
// - non-interactive runs (--yes, no-TTY, --quiet) scaffold the adapter,
//   GETTING-STARTED.md, baseline scenario, and .gitignore entries; no
//   personas/ directory is copied because personas live inline in the adapter.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import TOML from "toml";

import { runInit } from "../src/commands/init.js";
import {
  detectProgram,
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

const INIT_ADAPT_E2E_ENABLED = process.env.RIPTIDE_INIT_ADAPT_E2E === "1";
const CLI_ENTRYPOINT = path.resolve(process.cwd(), "dist/src/index.js");

function initInvariant(protocol: "lending", name: string): InitInvariantConfig {
  const entry = invariantChoicesFor(protocol).find((choice) => choice.name === name);
  assert.ok(entry, `expected invariant catalog entry ${name}`);
  return invariantConfigFromCatalog(entry);
}

function countOccurrences(body: string, needle: string): number {
  return body.split(needle).length - 1;
}

async function runCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? ""
    };
    if (process.env.RIPTIDE_ENGINE_BIN) {
      env.RIPTIDE_ENGINE_BIN = process.env.RIPTIDE_ENGINE_BIN;
    }
    const child = spawn(process.execPath, [CLI_ENTRYPOINT, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
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

test("init: --blank --name creates the minimal manual scaffold (no personas, baseline scenario)", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit({ force: false, dir: cwd, blank: true, name: "manual-program" });
  assert.equal(exit, 0);

  const riptideDir = path.join(cwd, ".riptide");
  assert.ok(existsSync(path.join(riptideDir, "adapters", "manual-program.toml")));
  assert.ok(existsSync(path.join(riptideDir, "GETTING-STARTED.md")));
  // Default protocol is "custom" → no persona presets are copied.
  assert.ok(!existsSync(path.join(riptideDir, "personas")));
  // Baseline scenario is always scaffolded so the user has a runnable starting point.
  assert.ok(existsSync(path.join(riptideDir, "scenarios", "baseline", "run-config.json")));

  const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
  assert.match(gitignore, /\.riptide\/runs\//);
  assert.match(gitignore, /\.riptide\/last-run\.json/);
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

test("init: malformed or ambiguous Anchor.toml fails instead of guessing my-program", async () => {
  const malformed = await mkTempRepo();
  await writeAnchor(malformed, "this is not valid TOML { [ malformed },,,,\n");
  assert.equal(await runInit({ force: false, dir: malformed }), 2);
  assert.equal(existsSync(path.join(malformed, ".riptide")), false);

  const ambiguous = await mkTempRepo();
  await writeAnchor(
    ambiguous,
    `[programs.localnet]
alpha = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
beta = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnT"
`
  );
  assert.equal(await runInit({ force: false, dir: ambiguous }), 2);
  assert.equal(existsSync(path.join(ambiguous, ".riptide")), false);
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
    protocol: "amm"
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

test("renderGettingStarted: harnessed repos promote one-seed harness smoke", () => {
  const body = renderGettingStarted("anchor-uniswap-v2", {
    scenarios: ["baseline"],
    harnessCreated: true,
    seeds: 50,
    protocol: "amm"
  });

  assert.match(
    body,
    /riptide run --adapter \.riptide\/adapters\/anchor-uniswap-v2\.toml --harness \.riptide\/harness --seeds 1 --seed-root 1337/
  );
  assert.doesNotMatch(body, /bare `riptide run` executes a 50-seed sweep/);
  assert.match(body, /AMM currently uses `protocol = "generic"`/);
});

test("init: harnessed next steps recommend one-seed run before full sweep", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, `[programs.localnet]
anchor_uniswap_v2 = "11111111111111111111111111111111"
`);

  const stderr = await captureStderr(async () => {
    const exit = await runInit(
      { force: false, dir: cwd },
      {
        isTTY: true,
        promptWizard: async () => ({
          programName: "anchor-uniswap-v2",
          protocol: "amm",
          harnessMode: "todo",
          seeds: 50,
          personas: [],
          scenarios: [
            {
              name: "baseline",
              scenario: "baseline",
              agents: 10,
              ticks: 5,
              personas: []
            }
          ],
          invariants: [],
          agents: 10,
          ticks: 5
        })
      }
    );
    assert.equal(exit, 0);
  });

  const smoke =
    "riptide run --adapter .riptide/adapters/anchor-uniswap-v2.toml --harness .riptide/harness --seeds 1 --seed-root 1337";
  const full =
    "riptide run --adapter .riptide/adapters/anchor-uniswap-v2.toml --harness .riptide/harness";
  assert.match(stderr, /1\. riptide lint anchor-uniswap-v2/);
  assert.match(stderr, /2\. \.riptide\/harness\/src\/main\.rs/);
  assert.ok(stderr.includes(smoke), stderr);
  assert.match(stderr, /4\. riptide run --adapter \.riptide\/adapters\/anchor-uniswap-v2\.toml --harness \.riptide\/harness/);
  assert.ok(stderr.indexOf(smoke) < stderr.lastIndexOf(full), stderr);
  assert.match(stderr, /Optional adapter-only smoke/);
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
      ".gitignore",
      ".riptide/GETTING-STARTED.md",
      ".riptide/adapters/manual-program.toml",
      ".riptide/scenarios/baseline/run-config.json"
    ].sort()
  );
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
    ticks: 25
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
    personas: string[];
  };
  assert.equal(runConfig.agents, 15);
  assert.equal(runConfig.ticks, 25);
  assert.deepEqual(runConfig.personas, ["swapper", "arbitrageur"]);

  // Created list does not include duplicate persona files.
  assert.equal(result.created.some((rel) => rel.startsWith(".riptide/personas/")), false);

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "amm-program.toml"), "utf8");
  assert.ok(adapterBody.includes("[personas.swapper]"));
  assert.ok(adapterBody.includes("[personas.arbitrageur]"));
});

test("scaffold: one seed and harness mode create seeded run-config plus TODO harness", async () => {
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
    harnessMode: "todo"
  });

  assert.equal(result.harnessCreated, true);
  assert.equal(result.seeds, 1);
  assert.ok(result.created.includes(".riptide/harness/Cargo.toml"));
  assert.ok(result.created.includes(".riptide/harness/src/main.rs"));
  assert.ok(result.created.includes(".riptide/harness/README.md"));

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

  const harnessMain = await readFile(
    path.join(cwd, ".riptide", "harness", "src", "main.rs"),
    "utf8"
  );
  assert.match(harnessMain, /impl RiptideHarness for ProjectHarness/);
  assert.match(harnessMain, /spl_token_account/);

  const gettingStarted = await readFile(path.join(cwd, ".riptide", "GETTING-STARTED.md"), "utf8");
  assert.match(gettingStarted, /"seed": 1337/);
  assert.match(gettingStarted, /--harness \.riptide\/harness/);
  assert.match(gettingStarted, /--seeds 1 --seed-root 1337/);

  const harnessReadme = await readFile(path.join(cwd, ".riptide", "harness", "README.md"), "utf8");
  assert.match(harnessReadme, /--harness \.riptide\/harness --seeds 1 --seed-root 1337/);
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
  ) as { agents: number; ticks: number; scenario: string; personas: string[] };
  assert.equal(baseline.scenario, "baseline");
  assert.equal(baseline.agents, 12);
  assert.equal(baseline.ticks, 34);
  assert.deepEqual(baseline.personas, ["steady-lp"]);

  const oracleShock = JSON.parse(
    await readFile(
      path.join(cwd, ".riptide", "scenarios", "oracle-price-shock", "run-config.json"),
      "utf8"
    )
  ) as { agents: number; ticks: number; scenario: string; personas: string[] };
  assert.equal(oracleShock.scenario, "price-shock");
  assert.equal(oracleShock.agents, 50);
  assert.equal(oracleShock.ticks, 60);
  assert.deepEqual(oracleShock.personas, ["steady-lp", "panic-whale", "degen-borrower"]);
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
    scenarios: []
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
    personas: ["swapper", "whale"]
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
    personas: []
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
    ticks: 30
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
  ) as { agents: number; ticks: number; personas: string[] };
  assert.equal(runConfig.agents, 1000);
  assert.equal(runConfig.ticks, 30);
  assert.deepEqual(runConfig.personas, ["steady-lp", "whale"]);
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

test("renderGettingStarted: references scaffolded scenarios; no-personas variant stays terse", () => {
  const withBoth = renderGettingStarted("my-program", {
    scenarios: ["baseline", "oracle-price-shock"]
  });
  assert.ok(withBoth.includes("my-program"));
  assert.ok(withBoth.includes("scenarios/baseline/run-config.json"));
  assert.ok(withBoth.includes("scenarios/oracle-price-shock/run-config.json"));
  assert.ok(withBoth.includes("riptide run --adapter .riptide/adapters/my-program.toml"));
  assert.ok(withBoth.includes("adapters/my-program.toml` `[personas.*]"));
  assert.ok(withBoth.includes('"seeds": 50'));
  assert.ok(withBoth.includes("50-seed sweep"));
  assert.ok(!withBoth.includes("personas/*.toml"));
  assert.ok(!withBoth.includes("amm.v1"));

  const withHarness = renderGettingStarted("my-program", {
    scenarios: ["baseline"],
    harnessCreated: true,
    seeds: 1
  });
  assert.ok(withHarness.includes("harness/"));
  assert.ok(withHarness.includes("--harness .riptide/harness"));
  assert.ok(withHarness.includes('"seed": 1337'));

  const minimal = renderGettingStarted("my-program");
  assert.ok(minimal.includes("adapters/my-program.toml` `[personas.*]"));
  assert.ok(!minimal.includes("personas/*.toml"));
  assert.ok(!minimal.includes("scenarios/baseline/run-config.json"));
});

test("init: wizard answers thread into scaffold output (injected promptWizard)", async () => {
  const cwd = await mkTempRepo();
  await writeAnchor(cwd, SINGLE_ANCHOR);

  const fakeAnswers: WizardAnswers = {
    programName: "widget-factory",
    protocol: "amm",
    harnessMode: "none",
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
    { force: false, dir: cwd },
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
  ) as { agents: number; ticks: number; personas: string[] };
  assert.equal(runConfig.agents, 7);
  assert.equal(runConfig.ticks, 12);
  assert.deepEqual(runConfig.personas, ["swapper"]);
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

test("init: --yes with lending protocol scaffolds required plus recommended scenarios", async () => {
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
  assert.ok(existsSync(baselinePath));
  assert.ok(existsSync(oracleShockPath));
  assert.ok(!existsSync(path.join(cwd, ".riptide", "scenarios", "bank-run", "run-config.json")));

  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as {
    agents: number;
    ticks: number;
    scenario: string;
  };
  assert.equal(baseline.scenario, "baseline");
  assert.equal(baseline.agents, 50);
  assert.equal(baseline.ticks, 60);

  const oracleShock = JSON.parse(await readFile(oracleShockPath, "utf8")) as {
    scenario: string;
    personas: string[];
  };
  assert.equal(oracleShock.scenario, "price-shock");
  assert.deepEqual(oracleShock.personas, ["steady-lp", "panic-whale", "degen-borrower"]);

  const adapterBody = await readFile(path.join(cwd, ".riptide", "adapters", "lending.toml"), "utf8");
  assert.match(adapterBody, /^\[\[invariants\]\]$/m);
  assert.match(adapterBody, /^name = "no_bad_debt"$/m);
  assert.match(adapterBody, /^field = "cumulative_bad_debt"$/m);
  assert.match(adapterBody, /^\[semantics\]$/m);
  assert.match(adapterBody, /^class = "lending\.v1"$/m);
  assert.equal(countOccurrences(adapterBody, "[[semantics.invariants]]"), 3);

  const adapter = validateAdapter(TOML.parse(adapterBody), "lending.toml");
  assert.equal(adapter.invariants.some((invariant) => invariant.field === "cumulative_bad_debt"), true);
  assert.equal(adapter.semantics?.class, "lending.v1");
  assert.deepEqual(Object.keys(adapter.semantics?.roles ?? {}).sort(), [
    "liquidation_config",
    "oracle",
    "position",
    "reserve"
  ]);
  assert.deepEqual(adapter.semantics?.invariants.map((invariant) => invariant.name).sort(), [
    "debt_below_collateral",
    "debt_below_max_borrow",
    "health_factor_positive"
  ]);
});

test("init: --yes with non-lending protocol emits only commented invariant templates", async () => {
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
  assert.match(adapterBody, /^# \[\[invariants\]\]$/m);
  assert.doesNotMatch(adapterBody, /^\[semantics\]$/m);

  const parsed = TOML.parse(adapterBody) as Record<string, unknown>;
  assert.equal("invariants" in parsed, false);
  assert.equal("semantics" in parsed, false);
});

test(
  "init: generated lending adapter passes adapt smoke",
  { skip: !INIT_ADAPT_E2E_ENABLED, timeout: 180_000 },
  async () => {
    const cwd = await mkTempRepo();
    const exit = await runInit({
      force: false,
      dir: cwd,
      blank: true,
      name: "foo",
      protocol: "lending",
      yes: true
    });
    assert.equal(exit, 0);

    const smoke = await runCli(["adapt", "--adapter", ".riptide/adapters/foo.toml"], cwd);
    assert.equal(
      smoke.code,
      0,
      `adapt smoke failed\nstdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}`
    );
  }
);
