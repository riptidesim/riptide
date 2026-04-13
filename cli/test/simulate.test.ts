import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSimulateCommand } from "../src/commands/simulate.js";

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

interface Captured {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

async function runSimulate(args: string[], env: NodeJS.ProcessEnv): Promise<Captured> {
  const captured: Captured = { stdout: "", stderr: "", exitCode: undefined };

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalEnv = { ...process.env };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  for (const key of Object.keys(env)) {
    process.env[key] = env[key];
  }

  try {
    const cmd = createSimulateCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: "user" });
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.env = originalEnv;
  }

  return captured;
}

test("simulate command runs end-to-end with a faked engine binary", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "riptide-simulate-test-"));
  const fixturePath = await resolveFixturePath("simulation-result.sample.json");
  const fixtureRaw = await readFile(fixturePath, "utf8");

  // Fake engine: parses --output from argv, writes fixture, exits 0.
  const fakeEngine = path.join(tmp, "fake-engine");
  const fakeEngineSrc = [
    "#!/usr/bin/env node",
    `const fs = require("fs");`,
    `const args = process.argv.slice(2);`,
    `const i = args.indexOf("--output");`,
    `const out = args[i + 1];`,
    `fs.writeFileSync(out, ${JSON.stringify(fixtureRaw)});`,
    `process.exit(0);`
  ].join("\n");
  await writeFile(fakeEngine, fakeEngineSrc);
  await chmod(fakeEngine, 0o755);

  const outputDir = path.join(tmp, "run-out");

  const captured = await runSimulate(
    [
      "--agents",
      "3",
      "--ticks",
      "5",
      "--seed",
      "42",
      "--scenario",
      "baseline",
      "--personas",
      "cautious-yield-farmer",
      "--output",
      outputDir
    ],
    {
      RIPTIDE_ENGINE_BIN: fakeEngine
    }
  );

  assert.match(captured.stderr, /riptide simulate:/);
  assert.match(captured.stderr, /agents=3/);
  assert.match(captured.stdout, /Riptide Simulation Summary/);
  assert.match(captured.stdout, /Final TVL:/);
  assert.match(captured.stdout, /T0/);

  const artifact = path.join(outputDir, "simulation-result.json");
  const artifactRaw = await readFile(artifact, "utf8");
  assert.match(artifactRaw, /simulation_boundaries/);
});
