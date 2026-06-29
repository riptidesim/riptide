import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

test("root version matches package metadata", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--version"], {
    cwd: process.cwd()
  });
  const packageJson = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
  ) as { version: string };

  assert.equal(stdout.trim(), packageJson.version);
});

test("simulate command is not registered", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--help"], {
    cwd: process.cwd()
  });
  assert.doesNotMatch(stdout, /^\s+simulate\b/m);

  let stderr = "";
  let code: number | string | undefined;
  try {
    await execFileAsync(process.execPath, [cliEntrypoint, "simulate"], {
      cwd: process.cwd()
    });
  } catch (err) {
    const execErr = err as { stderr?: string; code?: number | string };
    stderr = execErr.stderr ?? "";
    code = execErr.code;
  }

  assert.equal(code, 1);
  assert.match(stderr, /unknown command 'simulate'/);
});

test("retired generic commands are not registered", async () => {
  for (const command of ["campaign", "run", "scenarios", "adapt", "replay", "harness", "lint"]) {
    let stderr = "";
    let code: number | string | undefined;
    try {
      await execFileAsync(process.execPath, [cliEntrypoint, command], { cwd: process.cwd() });
    } catch (err) {
      const execErr = err as { stderr?: string; code?: number | string };
      stderr = execErr.stderr ?? "";
      code = execErr.code;
    }
    assert.equal(code, 1, `${command} should be unknown`);
    assert.match(stderr, new RegExp(`unknown command '${command}'`));
  }
});

test("commands: root help is compact and lists the guided-sim core surface", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--help"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /Deterministic Solana guided simulations and reviewer-ready evidence\./);
  assert.match(stdout, /First assessment:/);
  assert.match(stdout, /riptide-assess/);
  assert.match(stdout, /Reports are simulation evidence over declared inputs, not audit signoff\./);
  assert.match(stdout, /Start here:/);
  assert.match(stdout, /Examples:/);
  assert.match(stdout, /# First assessment: use the riptide-assess agent skill from your protocol repo/);
  assert.match(stdout, /riptide sim run \.riptide\/sim --flows 8/);
  assert.match(stdout, /riptide <command> --help/);
  assert.doesNotMatch(stdout, /complete protocol safety/i);
  // Generic-path commands are gone from the surface.
  assert.doesNotMatch(stdout, /^\s+campaign\b/m);
  assert.doesNotMatch(stdout, /^\s+run\b/m);

  const ordered = ["init", "readiness", "sim", "review", "assess", "doctor"].map((command) => {
    const index = stdout.indexOf(`  ${command}`);
    assert.notEqual(index, -1, `${command} missing from root help:\n${stdout}`);
    return index;
  });
  assert.deepEqual([...ordered].sort((a, b) => a - b), ordered);

  assert.ok(stdout.split("\n").length < 80, stdout);
});
