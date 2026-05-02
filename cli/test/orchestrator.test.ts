import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runOrchestrator, type Spawner, type SpawnResult } from "../src/orchestrator/index.js";
import type { RunConfig } from "../src/compiler/schema.js";

async function resolveFixturePath(name: string): Promise<string> {
  const candidates = [
    fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url))
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidates[candidates.length - 1]!;
}

async function loadFixtureRaw(): Promise<string> {
  return readFile(await resolveFixturePath("simulation-result.sample.json"), "utf8");
}

// Lay out <root>/target/release/riptide-engine so the walk-up discovery
// resolves without needing RIPTIDE_ENGINE_BIN. Returns the root plus a
// nested subdir to simulate running from inside the cli/ folder.
async function makeFakeEngineRoot(): Promise<{ root: string; nestedCwd: string; enginePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-orch-test-"));
  const enginePath = path.join(root, "target", "release", "riptide-engine");
  await mkdir(path.dirname(enginePath), { recursive: true });
  await writeFile(enginePath, "#!/bin/sh\nexit 0\n");
  await chmod(enginePath, 0o755);
  const nestedCwd = path.join(root, "cli");
  await mkdir(nestedCwd, { recursive: true });
  return { root, nestedCwd, enginePath };
}

function baseRunConfig(): RunConfig {
  return {
    agents: 3,
    ticks: 5,
    scenario: "baseline",
    seed: 42,
    personas: ["cautious-yield-farmer"],
    validator_url: "http://127.0.0.1:8899",
    output_path: path.join(os.tmpdir(), "riptide-orch-out")
  };
}

interface Call {
  bin: string;
  args: string[];
}

function successSpawner(log: Call[], fixtureRaw: string): Spawner {
  return async (bin, args) => {
    log.push({ bin, args });
    if (
      bin === "cargo" &&
      (args[0] === "build" || (args[0]?.startsWith("+") && args[1] === "build"))
    ) {
      return { code: 0, stderrTail: "" };
    }
    const outPath = args[args.indexOf("--output") + 1]!;
    await access(args[args.indexOf("--config") + 1]!);
    await access(args[args.indexOf("--policies") + 1]!);
    await writeFile(outPath, fixtureRaw);
    return { code: 0, stderrTail: "" };
  };
}

test("orchestrator constructs engine args and returns validated result", async () => {
  const { root, enginePath } = await makeFakeEngineRoot();
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];

  const result = await runOrchestrator(baseRunConfig(), {
    cwd: root,
    env: { PATH: process.env.PATH },
    spawner: successSpawner(log, fixture),
    moduleRoot: null
  });

  assert.equal(log.length, 1);
  const call = log[0]!;
  assert.equal(call.bin, enginePath);
  assert.ok(call.args.includes("--config"));
  assert.ok(call.args.includes("--policies"));
  assert.ok(call.args.includes("--output"));
  assert.ok(!call.args.includes("--payer"));
  assert.ok(!call.args.includes("--allow-nonlocal-rpc"));
  assert.equal(typeof result.total_ticks, "number");
  assert.ok(Array.isArray(result.events));
});

test("orchestrator does not compile fallback policies for generic inline personas", async () => {
  const { root } = await makeFakeEngineRoot();
  const fixture = await loadFixtureRaw();
  const adapterPath = path.join(root, "adapter.toml");
  await writeFile(
    adapterPath,
    `protocol = "generic"
program_so = "./program.so"
idl_path = "./idl.json"

[accounts.state]
kind = "shared"
space = 8

[instructions.swap]
action = "swap"
amount = "amount"

[state_mapping]
"state.amount" = "state.amount"

[actions.swap]
label = "Swap"
takes = ["amount"]

[observations]
"state.amount" = "uint"

[personas.swapper]
label = "Swapper"
action_rate_multiplier = 1.0
action_weights = { swap = 1.0 }
triggers = []
`
  );
  let policiesRaw = "";
  const spawner: Spawner = async (_bin, args) => {
    policiesRaw = await readFile(args[args.indexOf("--policies") + 1]!, "utf8");
    const outPath = args[args.indexOf("--output") + 1]!;
    await writeFile(outPath, fixture);
    return { code: 0, stderrTail: "" };
  };
  const runConfig = { ...baseRunConfig(), personas: ["swapper"] };

  await runOrchestrator(runConfig, {
    cwd: root,
    env: { PATH: process.env.PATH },
    spawner,
    moduleRoot: null,
    adapterPath
  });

  assert.deepEqual(JSON.parse(policiesRaw), []);
});

test("orchestrator forwards explicit state-pack path to the engine", async () => {
  const { root } = await makeFakeEngineRoot();
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];
  const statePack = path.join(root, ".riptide", "state-packs", "orca");

  await runOrchestrator(baseRunConfig(), {
    cwd: root,
    env: { PATH: process.env.PATH },
    spawner: successSpawner(log, fixture),
    moduleRoot: null,
    statePackPath: statePack
  });

  const call = log[0]!;
  assert.equal(call.args[call.args.indexOf("--state-pack") + 1], statePack);
});

test("orchestrator builds harness once and runs the release binary directly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-harness-orch-"));
  const harnessDir = path.join(root, ".riptide", "harness");
  const manifest = path.join(harnessDir, "Cargo.toml");
  await mkdir(harnessDir, { recursive: true });
  await writeFile(manifest, "[package]\nname = \"h\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  const binary = path.join(harnessDir, "target", "release", "h");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o755);
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];
  const adapterPath = path.join(root, ".riptide", "adapters", "demo.toml");

  await runOrchestrator(baseRunConfig(), {
    cwd: root,
    env: { PATH: process.env.PATH },
    spawner: successSpawner(log, fixture),
    moduleRoot: null,
    adapterPath,
    harnessPath: harnessDir
  });

  assert.equal(log.length, 2);
  const build = log[0]!;
  assert.equal(build.bin, "cargo");
  assert.deepEqual(build.args, [
    "build",
    "--release",
    "--quiet",
    "--manifest-path",
    manifest
  ]);
  const run = log[1]!;
  assert.equal(run.bin, binary);
  assert.equal(run.args[run.args.indexOf("--adapter") + 1], adapterPath);
});

test("orchestrator honors generated harness rust-toolchain pin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-harness-toolchain-"));
  const harnessDir = path.join(root, ".riptide", "harness");
  const manifest = path.join(harnessDir, "Cargo.toml");
  await mkdir(harnessDir, { recursive: true });
  await writeFile(manifest, "[package]\nname = \"h\"\nversion = \"0.1.0\"\nedition = \"2021\"\n");
  await writeFile(path.join(harnessDir, "rust-toolchain.toml"), "[toolchain]\nchannel = \"1.91.1\"\n");
  const binary = path.join(harnessDir, "target", "release", "h");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o755);
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];
  const adapterPath = path.join(root, ".riptide", "adapters", "demo.toml");

  await runOrchestrator(baseRunConfig(), {
    cwd: root,
    env: { PATH: process.env.PATH },
    spawner: successSpawner(log, fixture),
    moduleRoot: null,
    adapterPath,
    harnessPath: harnessDir
  });

  assert.equal(log[0]!.bin, "cargo");
  assert.deepEqual(log[0]!.args, [
    "+1.91.1",
    "build",
    "--release",
    "--quiet",
    "--manifest-path",
    manifest
  ]);
});

test("orchestrator resolves engine from cli/ subdir via cwd/../target/release", async () => {
  const { nestedCwd, enginePath } = await makeFakeEngineRoot();
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];

  await runOrchestrator(baseRunConfig(), {
    cwd: nestedCwd,
    env: { PATH: process.env.PATH },
    spawner: successSpawner(log, fixture),
    moduleRoot: null
  });

  assert.equal(log[0]!.bin, enginePath);
});

test("orchestrator does NOT walk up past the allowed candidates (security)", async () => {
  // Layout: /tmp/<outer>/target/release/riptide-engine exists, but cwd is
  // /tmp/<outer>/a/b/c — two levels too deep. A walk-up implementation
  // would happily execute the outer binary; the explicit-candidate list
  // must refuse it.
  const outer = await mkdtemp(path.join(os.tmpdir(), "riptide-attack-"));
  const attackerEngine = path.join(outer, "target", "release", "riptide-engine");
  await mkdir(path.dirname(attackerEngine), { recursive: true });
  await writeFile(attackerEngine, "#!/bin/sh\nexit 0\n");
  await chmod(attackerEngine, 0o755);
  const deepCwd = path.join(outer, "a", "b", "c");
  await mkdir(deepCwd, { recursive: true });

  await assert.rejects(
    () =>
      runOrchestrator(baseRunConfig(), {
        cwd: deepCwd,
        env: { PATH: "/nonexistent-path-12345" },
        spawner: async () => ({ code: 0, stderrTail: "" }),
        moduleRoot: null
      }),
    /Could not locate the riptide-engine binary/
  );
});

test("orchestrator cleans up temp dir on success", async () => {
  const { root } = await makeFakeEngineRoot();
  const fixture = await loadFixtureRaw();
  let capturedConfigPath = "";

  const spawner: Spawner = async (_bin, args) => {
    capturedConfigPath = args[args.indexOf("--config") + 1]!;
    const outPath = args[args.indexOf("--output") + 1]!;
    await writeFile(outPath, fixture);
    return { code: 0, stderrTail: "" };
  };

  await runOrchestrator(baseRunConfig(), {
    cwd: root,
    env: { PATH: process.env.PATH },
    spawner
  });

  await assert.rejects(() => access(capturedConfigPath));
});

test("orchestrator surfaces engine stderr tail on non-zero exit", async () => {
  const { root } = await makeFakeEngineRoot();
  let capturedConfigPath = "";
  const engineStderr =
    "riptide-engine: loaded 5 policies, agents=3, ticks=5\n" +
    "deploying lending_pool.so ...\n" +
    "error: rent pool: RPC request failed: connection refused (http://127.0.0.1:8899)";

  const spawner: Spawner = async (_bin, args) => {
    capturedConfigPath = args[args.indexOf("--config") + 1]!;
    return { code: 1, stderrTail: engineStderr };
  };

  await assert.rejects(
    () =>
      runOrchestrator(baseRunConfig(), {
        cwd: root,
        env: { PATH: process.env.PATH },
        spawner
      }),
    (err: Error) => {
      assert.match(err.message, /exited with code 1/);
      assert.match(err.message, /engine stderr \(tail\)/);
      assert.match(err.message, /rent pool: RPC request failed/);
      assert.match(err.message, /connection refused/);
      return true;
    }
  );

  // temp dir still cleaned up on failure
  await assert.rejects(() => access(capturedConfigPath));
});

test("orchestrator handles empty stderr on failure without a bogus tail section", async () => {
  const { root } = await makeFakeEngineRoot();
  const spawner: Spawner = async () => ({ code: 2, stderrTail: "" });

  await assert.rejects(
    () =>
      runOrchestrator(baseRunConfig(), {
        cwd: root,
        env: { PATH: process.env.PATH },
        spawner
      }),
    (err: Error) => {
      assert.match(err.message, /exited with code 2/);
      assert.ok(!/engine stderr/.test(err.message));
      return true;
    }
  );
});

test("orchestrator reports every lookup attempt when engine binary missing", async () => {
  const emptyCwd = await mkdtemp(path.join(os.tmpdir(), "riptide-empty-"));
  await assert.rejects(
    () =>
      runOrchestrator(baseRunConfig(), {
        cwd: emptyCwd,
        env: { PATH: "/nonexistent-path-12345" },
        spawner: async () => ({ code: 0, stderrTail: "" }),
        moduleRoot: null
      }),
    (err: Error) => {
      assert.match(err.message, /Could not locate the riptide-engine binary/);
      assert.match(err.message, /RIPTIDE_ENGINE_BIN/);
      assert.match(err.message, /target\/release\/riptide-engine/);
      assert.match(err.message, /\$PATH lookup/);
      assert.ok(!/walk-up/.test(err.message));
      return true;
    }
  );
});

test("orchestrator resolves engine from moduleRoot regardless of cwd", async () => {
  // The "any session / zero setup" fix: when the CLI is invoked from a
  // cwd that is NOT inside the monorepo (e.g. `/tmp` during a Claude
  // Code skill run), the module-root derivation should find the engine
  // in the monorepo this CLI was built from.
  const { root: moduleRoot, enginePath } = await makeFakeEngineRoot();
  const outsideCwd = await mkdtemp(path.join(os.tmpdir(), "riptide-outside-"));
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];

  await runOrchestrator(baseRunConfig(), {
    cwd: outsideCwd,
    env: { PATH: "/nonexistent-path-12345" },
    spawner: successSpawner(log, fixture),
    moduleRoot
  });

  assert.equal(log[0]!.bin, enginePath);
});

test("orchestrator honors RIPTIDE_ENGINE_BIN override", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "riptide-enginebin-"));
  const enginePath = path.join(tmp, "my-engine");
  await writeFile(enginePath, "#!/bin/sh\nexit 0\n");
  await chmod(enginePath, 0o755);
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];

  await runOrchestrator(baseRunConfig(), {
    cwd: "/nonexistent-cwd",
    env: {
      RIPTIDE_ENGINE_BIN: enginePath,
      PATH: ""
    },
    spawner: successSpawner(log, fixture)
  });

  assert.equal(log[0]!.bin, enginePath);
});
