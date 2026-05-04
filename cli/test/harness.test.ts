import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateHarness } from "../src/commands/harness.js";

const CLI_ENTRYPOINT = path.resolve(process.cwd(), "dist/src/index.js");
const HARNESSED_USER_FLOW_SMOKE = process.env.RIPTIDE_HARNESSED_USER_FLOW_SMOKE === "1";

async function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
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
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("harness generate writes a Rust crate with adapter account hints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-setup-gen-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");

  const result = await generateHarness(root, {
    adapter,
    dir: ".riptide/harness",
    name: "demo-harness"
  });

  const cargoToml = await readFile(result.manifestPath, "utf8");
  const mainRs = await readFile(path.join(result.dir, "src", "main.rs"), "utf8");
  const rustToolchain = await readFile(path.join(result.dir, "rust-toolchain.toml"), "utf8");

  assert.match(cargoToml, /name = "demo-harness"/);
  assert.match(cargoToml, /riptide-engine = /);
  assert.match(cargoToml, /riptide-engine = \{ path = /);
  assert.match(rustToolchain, /channel = "1\.91\.1"/);
  assert.match(mainRs, /impl RiptideHarness for ProjectHarness/);
  assert.match(mainRs, /ctx\.require_declared_account\("pool"\)\?/);
  assert.match(mainRs, /ctx\.require_declared_account\("lp_position"\)\?/);
  assert.match(mainRs, /deterministic\s+pre-tick-0 bytes/);
  assert.match(mainRs, /ctx\.set_shared_account_data\("oracle", oracle_program, oracle_bytes\)\?/);
  assert.match(mainRs, /ctx\.set_raw_account\(custom_pubkey, owner_program, account_bytes, None\)\?/);
  assert.doesNotMatch(mainRs, /Replace zeroed generic\s+bootstrap accounts/);

  const readme = await readFile(path.join(result.dir, "README.md"), "utf8");
  assert.match(readme, /`\/riptide-config` should complete this file/);
  assert.match(readme, /riptide run --adapter .* --harness \. --seeds 1 --seed-root 1337/);
});

test("harness generate rejects non-generic adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-setup-lending-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "lending.toml");

  await assert.rejects(
    () => generateHarness(root, { adapter, dir: ".riptide/harness" }),
    /generic SBF\/IDL adapters/
  );
});

test("harness generate CLI output recommends one-seed smoke", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-setup-cli-"));
  const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");
  const harnessDir = path.join(root, ".riptide", "harness");

  const generated = await runCommand(
    process.execPath,
    [CLI_ENTRYPOINT, "harness", "generate", "--adapter", adapter, "--dir", harnessDir],
    root
  );

  assert.equal(generated.code, 0, generated.stderr);
  assert.match(generated.stderr, /complete deterministic setup/);
  assert.match(generated.stderr, /--harness .* --seeds 1 --seed-root 1337/);
});

test(
  "harnessed generic scaffold compiles before deterministic setup is filled",
  { skip: !HARNESSED_USER_FLOW_SMOKE, timeout: 300_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "riptide-setup-flow-"));
    const adapter = path.resolve(process.cwd(), "..", "fixtures", "adapters", "amm.toml");
    const harnessDir = path.join(root, ".riptide", "harness");
    const scenarioDir = path.join(root, ".riptide", "scenarios", "baseline");
    await mkdir(scenarioDir, { recursive: true });
    await writeFile(
      path.join(scenarioDir, "run-config.json"),
      JSON.stringify(
        {
          agents: 1,
          ticks: 1,
          seed: 1337,
          scenario: "baseline",
          personas: [],
          output_path: ".riptide/runs/baseline"
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const generated = await runCommand(
      process.execPath,
      [CLI_ENTRYPOINT, "harness", "generate", "--adapter", adapter, "--dir", harnessDir],
      root
    );
    assert.equal(generated.code, 0, generated.stderr);
    assert.match(generated.stderr, /--harness .* --seeds 1 --seed-root 1337/);

    const built = await runCommand(
      "cargo",
      ["build", "--release", "--quiet", "--manifest-path", path.join(harnessDir, "Cargo.toml")],
      root
    );
    assert.equal(built.code, 0, built.stderr);
  }
);
