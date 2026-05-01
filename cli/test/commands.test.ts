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

test("scenarios prints the stub list", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "scenarios"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /baseline/);
  assert.match(stdout, /price-shock/);
});
