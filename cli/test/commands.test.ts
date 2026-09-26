import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
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
  assert.doesNotMatch(stdout, /Start here:/);
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

test("init: completes without input while stdin stays open", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-init-cli-"));
  await writeFile(
    path.join(cwd, "Anchor.toml"),
    '[programs.localnet]\nwidget_factory = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"\n',
    "utf8"
  );

  // stdin is a pipe that is never written to or closed: any prompt would hang.
  const child = spawn(process.execPath, [cliEntrypoint, "init", "--no-skills"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" }
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("riptide init waited for input"));
    }, 15_000);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  assert.equal(code, 0);
  assert.equal(stdout, "");
  assert.ok(existsSync(path.join(cwd, ".riptide", "adapters", "widget-factory.toml")));
  assert.ok(existsSync(path.join(cwd, ".riptide", ".gitignore")));
});

test("init: the interactive wizard is not available", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-init-cli-"));
  let stderr = "";
  let code: number | string | undefined;
  try {
    await execFileAsync(process.execPath, [cliEntrypoint, "init", "--wizard"], { cwd });
  } catch (err) {
    const execErr = err as { stderr?: string; code?: number | string };
    stderr = execErr.stderr ?? "";
    code = execErr.code;
  }
  assert.equal(code, 1);
  assert.match(stderr, /unknown option '--wizard'/);
  assert.equal(existsSync(path.join(cwd, ".riptide")), false);
});
