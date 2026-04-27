import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliEntrypoint = path.resolve(process.cwd(), "dist/src/index.js");
const __dirname = path.resolve(process.cwd(), "test");
const packPath = path.resolve(__dirname, "../../fixtures/replays/lending-whale-bad-debt/");

test("review validates the lending whale replay pack and emits markdown", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntrypoint, "review", packPath], {
    cwd: process.cwd(),
  });

  assert.equal(stderr, "");
  assert.match(stdout, /# Pack: lending-whale-bad-debt/);
  assert.match(stdout, /\*\*Proof level 3 - Failure-shape replay\*\*/);
  assert.match(stdout, /Canonical hash: `6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1`/);
  assert.match(stdout, /Raw output SHA256: `05c4a616f6deb5195f8e38242082e0995a8cc71d90ebf6ae3d480703d28b78bd`/);
  assert.match(stdout, /no_bad_debt/);
  assert.match(stdout, /rerun\.sh` is present and `sh -n` parseable; it was not executed/);
});

test("review --json emits validation, invariant, digest, canonical hash, and raw sha256 fields", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "review", packPath, "--json"], {
    cwd: process.cwd(),
  });

  const payload = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal((payload.pack as Record<string, unknown>).slug, "lending-whale-bad-debt");
  assert.equal((payload.hash as Record<string, unknown>).ok, true);
  assert.equal((payload.hash as Record<string, unknown>).observed, "6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1");
  assert.equal((payload.hash as Record<string, unknown>).raw_sha256, "05c4a616f6deb5195f8e38242082e0995a8cc71d90ebf6ae3d480703d28b78bd");
  assert.equal(Array.isArray(payload.validation), true);
  assert.equal(Array.isArray(payload.invariant_fires), true);
  assert.match(String((payload.manifest as Record<string, unknown>).digest), /^[a-f0-9]{64}$/);
});

test("review ignores invariant evidence from fields excluded from the canonical hash", async () => {
  const copied = await copyPack("riptide-review-unhashed-invariants-");
  const resultPath = path.join(copied, "riptide-output", "replays", "lending-whale-bad-debt", "simulation-result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
  const summary = result.summary as Record<string, unknown>;
  summary.expression_invariants = [
    {
      name: "fake_semantic_fire",
      expr: "fake == true",
      firing_count: 1,
      first_tick: 1,
      observed: [{ tick: 1, values: { fake: true } }],
    },
  ];
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  const manifestPath = path.join(copied, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.invariant_firings = [
    {
      name: "fake_manifest_fire",
      firings: 1,
      first_tick: 1,
      field: "fake",
      op: "==",
      value: true,
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const { stdout } = await execFileAsync(process.execPath, [cliEntrypoint, "review", copied, "--json"], {
    cwd: process.cwd(),
  });

  const payload = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal((payload.hash as Record<string, unknown>).ok, true);
  assert.equal((payload.hash as Record<string, unknown>).observed, "6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1");
  const fires = payload.invariant_fires as Array<Record<string, unknown>>;
  assert.deepEqual(fires.map((fire) => fire.name), ["no_bad_debt"]);
});

test("review derives What Broke from hash-covered evidence when summary.md is tampered", async () => {
  const copied = await copyPack("riptide-review-unhashed-summary-");
  await writeFile(
    path.join(copied, "summary.md"),
    [
      "# Run summary - tampered",
      "",
      "- **Outcome:** No invariant fired; all checks stayed clean.",
      "",
    ].join("\n"),
    "utf8"
  );

  const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
    cwd: process.cwd(),
  });

  assert.equal(stderr, "");
  assert.match(stdout, /Hash verification: passed/);
  assert.match(
    stdout,
    /## What Broke\s+no_bad_debt fired first at tick 4, indicating the declared proof condition was violated in this pack\./
  );
  assert.doesNotMatch(stdout, /No invariant fired; all checks stayed clean/);
});

test("review --out writes markdown and prints a short success line", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "riptide-review-out-"));
  const outPath = path.join(tmp, "review.md");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [cliEntrypoint, "review", packPath, "--out", outPath],
    { cwd: process.cwd() }
  );

  assert.equal(stderr, "");
  assert.match(stdout, /wrote review markdown:/);
  const markdown = await readFile(outPath, "utf8");
  assert.match(markdown, /# Pack: lending-whale-bad-debt/);
  assert.match(markdown, /What This Proof Does Not Claim/);
});

test("review validates an unchanged pack copied outside the checkout", async () => {
  const copied = await copyPack("riptide-review-copied-");
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
    cwd: process.cwd(),
  });

  assert.equal(stderr, "");
  assert.match(stdout, /# Pack: lending-whale-bad-debt/);
  assert.match(stdout, /Hash verification: passed/);
});

test("review exits 2 when an indexed path is absolute", async () => {
  const copied = await copyPack("riptide-review-absolute-index-");
  await writeFile(
    path.join(copied, "inputs", "paths.json"),
    JSON.stringify({ adapter: path.join(copied, "adapter.toml"), config: "config.json" }, null, 2) + "\n",
    "utf8"
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /absolute indexed paths are not allowed/);
      assert.match(err.stderr ?? "", /field: inputs\.adapter/);
      return true;
    }
  );
});

test("review exits 2 when an indexed path escapes the pack root", async () => {
  const copied = await copyPack("riptide-review-escaping-index-");
  await writeFile(path.join(path.dirname(copied), "outside-adapter.toml"), "# outside pack\n", "utf8");
  await writeFile(
    path.join(copied, "inputs", "paths.json"),
    JSON.stringify({ adapter: "../outside-adapter.toml", config: "config.json" }, null, 2) + "\n",
    "utf8"
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /indexed path escapes pack root/);
      assert.match(err.stderr ?? "", /field: inputs\.adapter/);
      return true;
    }
  );
});

test("review exits 2 when an indexed path symlink canonicalizes outside the pack root", async () => {
  const copied = await copyPack("riptide-review-symlink-index-");
  const outsideResult = path.join(packPath, "riptide-output", "replays", "lending-whale-bad-debt", "simulation-result.json");
  const symlinkPath = path.join(copied, "outputs", "simulation-result-link.json");
  await symlink(outsideResult, symlinkPath);
  await writeFile(
    path.join(copied, "outputs", "paths.json"),
    JSON.stringify({ simulation_result: "outputs/simulation-result-link.json" }, null, 2) + "\n",
    "utf8"
  );

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied, "--json"], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /canonicalizes outside it/);
      assert.match(err.stderr ?? "", /field: outputs\.simulation_result/);
      return true;
    }
  );
});

test("review exits 2 when default simulation-result fallback symlink canonicalizes outside the pack root", async () => {
  const copied = await copyPack("riptide-review-symlink-default-result-");
  const outsideResult = path.join(packPath, "riptide-output", "replays", "lending-whale-bad-debt", "simulation-result.json");
  const symlinkPath = path.join(copied, "outputs", "simulation-result.json");
  const manifestPath = path.join(copied, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

  delete manifest.outputs;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(path.join(copied, "outputs", "paths.json"), "{}\n", "utf8");
  await symlink(outsideResult, symlinkPath);

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied, "--json"], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /canonicalizes outside it/);
      assert.match(err.stderr ?? "", /field: outputs\.simulation_result/);
      return true;
    }
  );
});

test("review exits 2 on malformed manifest", async () => {
  const copied = await copyPack("riptide-review-malformed-");
  await writeFile(path.join(copied, "manifest.json"), "{ nope", "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /malformed manifest\.json/);
      return true;
    }
  );
});

test("review exits 2 on canonical hash mismatch", async () => {
  const copied = await copyPack("riptide-review-hash-");
  const manifestPath = path.join(copied, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.canonical_hash = "0".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliEntrypoint, "review", copied], {
      cwd: process.cwd(),
    }),
    (error: unknown) => {
      const err = error as { code?: number; stderr?: string };
      assert.equal(err.code, 2);
      assert.match(err.stderr ?? "", /canonical hash mismatch/);
      assert.match(err.stderr ?? "", /expected: 0000000000000000000000000000000000000000000000000000000000000000/);
      assert.match(err.stderr ?? "", /observed: 6c59db5ebf916c8cc068c8fea8727d4edf26d244f288f6dadd7e9ae47d16c4a1/);
      return true;
    }
  );
});

async function copyPack(prefix: string): Promise<string> {
  const tmpParent = await mkdtemp(path.join(os.tmpdir(), prefix));
  const copied = path.join(tmpParent, "lending-whale-bad-debt");
  await cp(packPath, copied, { recursive: true });
  return copied;
}
