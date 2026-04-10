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
    env: { RIPTIDE_PAYER: "/tmp/fake-payer.json", PATH: process.env.PATH },
    spawner: successSpawner(log, fixture)
  });

  assert.equal(log.length, 1);
  const call = log[0]!;
  assert.equal(call.bin, enginePath);
  assert.ok(call.args.includes("--config"));
  assert.ok(call.args.includes("--policies"));
  assert.ok(call.args.includes("--output"));
  assert.equal(call.args[call.args.indexOf("--payer") + 1], "/tmp/fake-payer.json");
  assert.ok(!call.args.includes("--allow-nonlocal-rpc"));
  assert.equal(typeof result.total_ticks, "number");
  assert.ok(Array.isArray(result.events));
});

test("orchestrator resolves engine from cli/ subdir via cwd/../target/release", async () => {
  const { nestedCwd, enginePath } = await makeFakeEngineRoot();
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];

  await runOrchestrator(baseRunConfig(), {
    cwd: nestedCwd,
    env: { RIPTIDE_PAYER: "/tmp/fake-payer.json", PATH: process.env.PATH },
    spawner: successSpawner(log, fixture)
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
        env: { RIPTIDE_PAYER: "/tmp/fake-payer.json", PATH: "/nonexistent-path-12345" },
        spawner: async () => ({ code: 0, stderrTail: "" })
      }),
    /Could not locate the riptide-engine binary/
  );
});

test("orchestrator propagates --allow-nonlocal-rpc when env flag set", async () => {
  const { root } = await makeFakeEngineRoot();
  const fixture = await loadFixtureRaw();
  const log: Call[] = [];

  await runOrchestrator(baseRunConfig(), {
    cwd: root,
    env: {
      RIPTIDE_PAYER: "/tmp/fake-payer.json",
      RIPTIDE_ALLOW_NONLOCAL_RPC: "1",
      PATH: process.env.PATH
    },
    spawner: successSpawner(log, fixture)
  });

  assert.ok(log[0]!.args.includes("--allow-nonlocal-rpc"));
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
    env: { RIPTIDE_PAYER: "/tmp/fake-payer.json", PATH: process.env.PATH },
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
        env: { RIPTIDE_PAYER: "/tmp/fake-payer.json", PATH: process.env.PATH },
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
        env: { RIPTIDE_PAYER: "/tmp/fake-payer.json", PATH: process.env.PATH },
        spawner
      }),
    (err: Error) => {
      assert.match(err.message, /exited with code 2/);
      assert.ok(!/engine stderr/.test(err.message));
      return true;
    }
  );
});

test("orchestrator rejects when RIPTIDE_PAYER is unset", async () => {
  await assert.rejects(
    () =>
      runOrchestrator(baseRunConfig(), {
        env: { PATH: process.env.PATH },
        spawner: async () => ({ code: 0, stderrTail: "" })
      }),
    /RIPTIDE_PAYER is not set/
  );
});

test("orchestrator reports every lookup attempt when engine binary missing", async () => {
  const emptyCwd = await mkdtemp(path.join(os.tmpdir(), "riptide-empty-"));
  await assert.rejects(
    () =>
      runOrchestrator(baseRunConfig(), {
        cwd: emptyCwd,
        env: { RIPTIDE_PAYER: "/tmp/fake-payer.json", PATH: "/nonexistent-path-12345" },
        spawner: async () => ({ code: 0, stderrTail: "" })
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
      RIPTIDE_PAYER: "/tmp/fake-payer.json",
      RIPTIDE_ENGINE_BIN: enginePath,
      PATH: ""
    },
    spawner: successSpawner(log, fixture)
  });

  assert.equal(log[0]!.bin, enginePath);
});
