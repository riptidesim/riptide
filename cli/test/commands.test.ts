import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

test("simulate help prints usage", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "simulate", "--help"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /Usage: riptide simulate/);
  assert.match(stdout, /Compile personas and run a Riptide simulation/);
});

test("scenarios prints the stub list", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "scenarios"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /baseline/);
  assert.match(stdout, /price-shock/);
});
