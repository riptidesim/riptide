import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");

test("sim command is registered in advanced support help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "--help"], {
    cwd: process.cwd()
  });

  assert.match(stdout, /^\s+sim\b/m);
  assert.match(stdout, /Generate, refresh, and run guided Rust\s+simulations/);
});

test("sim generate CLI writes expected files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-sim-cli-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");
  const outDir = path.join(root, ".riptide", "sim");

  const generated = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "sim", "generate", "--adapter", adapter, "--dir", outDir],
    { cwd: root }
  );

  assert.match(generated.stderr, /generated guided Rust simulation/);
  assert.match(generated.stderr, /bootstrap .*Riptide\.toml/);
  assert.match(await readFile(path.join(outDir, "src", "types.rs"), "utf8"), /SwapBuilder/);
  assert.match(await readFile(path.join(outDir, "src", "services", "oracle.rs"), "utf8"), /impl Service for OracleService/);
  assert.match(await readFile(path.join(outDir, "Riptide.toml"), "utf8"), /\[\[sim\.accounts\]\]/);
});
