// `riptide init` scaffolding tests.
//
// These exercise the command's public contract (R1.1–R1.5):
// - creates .riptide/ with four top-level items in a fresh dir
// - exits 2 when .riptide/ already exists, exits 0 with --force
// - Anchor.toml present → inferred program name flows into filename + content
// - Anchor.toml absent → placeholder name
// - Anchor.toml malformed → falls back cleanly without crashing
// - 3–5 personas copied with non-empty TOML bodies
// - GETTING-STARTED.md contains "riptide run"
//
// Uses mkdtemp for hermetic test isolation and injects personasSourceDir
// via deps so the tests never depend on the bundled-asset resolver.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runInit } from "../src/commands/init.js";
import {
  inferProgramName,
  renderAdapterStub,
  renderBaselineRunConfig,
  renderGettingStarted,
  scaffold
} from "../src/init/index.js";

// Locate the bundled starter-persona directory relative to this test
// file. Tests compile into <repo>/cli/dist/test/init.test.js, and the
// build mirrors <cli>/assets/ → <cli>/dist/assets/, so three dirname
// steps land on <cli>/dist/ where `assets/init-personas/` lives.
function personasSrcForTests(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  // dist/test/ → dist/ → <cli>/dist/assets/init-personas
  const bundled = path.resolve(here, "..", "assets", "init-personas");
  if (existsSync(bundled)) return bundled;
  // Fall back to the monorepo source copy for dev environments where
  // the build hasn't been run but the test harness runs directly.
  const monorepoRoot = path.resolve(here, "..", "..", "..");
  const src = path.join(monorepoRoot, "cli", "assets", "init-personas");
  if (existsSync(src)) return src;
  throw new Error(
    `could not locate bundled init-personas at ${bundled} or ${src} — test harness layout changed?`
  );
}

async function mkTempRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "riptide-init-test-"));
}

test("init: fresh temp dir creates the expected .riptide/ tree", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(exit, 0);

  const riptideDir = path.join(cwd, ".riptide");
  assert.ok(existsSync(riptideDir), ".riptide/ must exist");
  assert.ok(
    existsSync(path.join(riptideDir, "adapters")),
    ".riptide/adapters/ must exist"
  );
  assert.ok(
    existsSync(path.join(riptideDir, "personas")),
    ".riptide/personas/ must exist"
  );
  assert.ok(
    existsSync(path.join(riptideDir, "scenarios", "baseline", "run-config.json")),
    ".riptide/scenarios/baseline/run-config.json must exist"
  );
  assert.ok(
    existsSync(path.join(riptideDir, "GETTING-STARTED.md")),
    ".riptide/GETTING-STARTED.md must exist"
  );

  const runConfigRaw = await readFile(
    path.join(riptideDir, "scenarios", "baseline", "run-config.json"),
    "utf8"
  );
  const parsed = JSON.parse(runConfigRaw);
  assert.equal(parsed.seed, 42);
  assert.equal(parsed.agents, 10);
  assert.equal(parsed.ticks, 30);
  assert.equal(parsed.scenario, "baseline");
  assert.ok(Array.isArray(parsed.personas));
  // Generic adapters carry their persona roster inline in the adapter
  // TOML; the scaffolded run-config leaves personas empty to delegate
  // roster shape to the adapter. Do not regress this to a non-empty
  // list — the CLI's policy fallback only knows 5 hardcoded ids.
  assert.equal(parsed.personas.length, 0);
});

test("init: refuses (exit 2) when .riptide/ exists; --force overwrites (exit 0)", async () => {
  const cwd = await mkTempRepo();
  const first = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(first, 0);

  const second = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(second, 2, "second init without --force must exit 2");

  const forced = await runInit(
    { force: true, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(forced, 0, "--force must overwrite cleanly");
  assert.ok(existsSync(path.join(cwd, ".riptide", "GETTING-STARTED.md")));
});

test("init: Anchor.toml present → inferred program name flows into adapter filename + content", async () => {
  const cwd = await mkTempRepo();
  await writeFile(
    path.join(cwd, "Anchor.toml"),
    `[toolchain]\n\n[features]\nresolution = true\n\n[programs.localnet]\nwidget_factory = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"\n\n[registry]\nurl = "https://api.apr.dev"\n`,
    "utf8"
  );

  const exit = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(exit, 0);

  const expectedAdapter = path.join(cwd, ".riptide", "adapters", "widget-factory.toml");
  assert.ok(
    existsSync(expectedAdapter),
    `expected adapter file at ${expectedAdapter}`
  );
  const body = await readFile(expectedAdapter, "utf8");
  assert.ok(body.includes("widget_factory.so"), "adapter must reference widget_factory.so");
  assert.ok(body.includes("widget_factory.json"), "adapter must reference widget_factory.json");
});

test("init: Anchor.toml absent → placeholder name, scaffold succeeds", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(exit, 0);

  assert.ok(
    existsSync(path.join(cwd, ".riptide", "adapters", "my-program.toml")),
    "placeholder adapter filename must be my-program.toml"
  );
});

test("init: Anchor.toml malformed → falls back to placeholder without crashing", async () => {
  const cwd = await mkTempRepo();
  await writeFile(
    path.join(cwd, "Anchor.toml"),
    "this is not valid TOML { [ malformed },,,,\n",
    "utf8"
  );

  const exit = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(exit, 0, "malformed Anchor.toml must not crash init");
  assert.ok(
    existsSync(path.join(cwd, ".riptide", "adapters", "my-program.toml")),
    "fallback should produce the placeholder filename"
  );
});

test("init: 3–5 personas copied with real non-empty TOML bodies", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(exit, 0);

  const personasDir = path.join(cwd, ".riptide", "personas");
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(personasDir);
  const tomlEntries = entries.filter((e) => e.endsWith(".toml"));
  assert.ok(
    tomlEntries.length >= 3 && tomlEntries.length <= 5,
    `expected 3–5 personas, got ${tomlEntries.length}: ${tomlEntries.join(", ")}`
  );

  for (const entry of tomlEntries) {
    const st = await stat(path.join(personasDir, entry));
    assert.ok(st.size > 50, `persona ${entry} should be non-trivial (> 50 bytes)`);
    const body = await readFile(path.join(personasDir, entry), "utf8");
    assert.ok(
      body.includes("[") || body.includes("persona"),
      `persona ${entry} should look like real TOML`
    );
  }
});

test("init: GETTING-STARTED.md names `riptide run` as the next action", async () => {
  const cwd = await mkTempRepo();
  const exit = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(exit, 0);

  const body = await readFile(
    path.join(cwd, ".riptide", "GETTING-STARTED.md"),
    "utf8"
  );
  assert.ok(body.includes("riptide run"), "GETTING-STARTED.md must reference `riptide run`");
  // Pin the fully-resolved invocation so the doc stays in sync with the
  // CLI that actually ships today — bare `riptide run` becomes valid
  // once scenario discovery + adapter auto-resolution land downstream,
  // and at that point this test should be relaxed intentionally.
  assert.ok(
    body.includes(".riptide/scenarios/baseline/run-config.json"),
    "GETTING-STARTED.md must point at the scaffolded run-config path"
  );
  assert.ok(
    body.includes("--adapter .riptide/adapters/my-program.toml"),
    "GETTING-STARTED.md must point at the scaffolded adapter path"
  );
});

// --- pure-function unit tests ---

test("inferProgramName: no Anchor.toml → placeholder", async () => {
  const cwd = await mkTempRepo();
  assert.equal(inferProgramName(cwd), "my-program");
});

test("inferProgramName: programs.localnet key → dashified program name", async () => {
  const cwd = await mkTempRepo();
  await writeFile(
    path.join(cwd, "Anchor.toml"),
    `[programs.localnet]\nhello_world = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"\n`,
    "utf8"
  );
  assert.equal(inferProgramName(cwd), "hello-world");
});

test("inferProgramName: multi-program workspace → placeholder (do not guess)", async () => {
  const cwd = await mkTempRepo();
  await writeFile(
    path.join(cwd, "Anchor.toml"),
    `[programs.localnet]\nalpha = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"\nbeta = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnT"\n`,
    "utf8"
  );
  assert.equal(
    inferProgramName(cwd),
    "my-program",
    "ambiguous multi-program workspace must fall back rather than guess"
  );
});

test("init: multi-program Anchor.toml → placeholder adapter filename", async () => {
  const cwd = await mkTempRepo();
  await writeFile(
    path.join(cwd, "Anchor.toml"),
    `[programs.localnet]\nalpha = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"\nbeta = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnT"\n`,
    "utf8"
  );
  const exit = await runInit(
    { force: false, dir: cwd },
    { personasSourceDir: personasSrcForTests() }
  );
  assert.equal(exit, 0);
  assert.ok(
    existsSync(path.join(cwd, ".riptide", "adapters", "my-program.toml")),
    "multi-program workspace should produce placeholder adapter filename"
  );
  assert.ok(
    !existsSync(path.join(cwd, ".riptide", "adapters", "alpha.toml")),
    "must not silently pick alpha"
  );
});

test("renderAdapterStub: contains program_so, idl_path, TODO comments, and every required block", () => {
  const body = renderAdapterStub("foo-bar");
  assert.ok(body.includes('program_so = "target/deploy/foo_bar.so"'));
  assert.ok(body.includes('idl_path = "target/idl/foo_bar.json"'));
  assert.ok(body.includes("# TODO:"), "stub must carry at least one TODO");
  assert.ok(body.includes("[accounts."));
  assert.ok(body.includes("[instructions]"));
  assert.ok(body.includes("[state_mapping]"));
  assert.ok(body.includes("[actions]"));
  assert.ok(body.includes("[observations]"));
  // Generic adapters declare personas inline; the scaffold ships with
  // at least one live [personas.*] block so a filled-in adapter runs
  // end-to-end without the caller also authoring a persona.
  assert.ok(body.includes("[personas."));
});

test("renderBaselineRunConfig: 10/30/42 shape with a personas array and output_path", () => {
  const cfg = renderBaselineRunConfig() as Record<string, unknown>;
  assert.equal(cfg.agents, 10);
  assert.equal(cfg.ticks, 30);
  assert.equal(cfg.seed, 42);
  assert.equal(cfg.scenario, "baseline");
  assert.ok(Array.isArray(cfg.personas));
  assert.equal(typeof cfg.output_path, "string");
  assert.equal(typeof cfg.validator_url, "string");
});

test("scaffold: bundled starter personas reachable with no personasSourceDir override (packaged layout)", async () => {
  // This exercises the resolver — proves the packaged install won't
  // break on `riptide init` because starter personas aren't shipping
  // in the CLI package. The build mirrors cli/assets/ into
  // cli/dist/assets/, so running from the dist layout must locate
  // the bundled dir without any hand-holding.
  const cwd = await mkTempRepo();
  const result = await scaffold({ cwd, force: false });
  const personasDir = path.join(cwd, ".riptide", "personas");
  assert.ok(existsSync(personasDir));
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(personasDir)).filter((e) => e.endsWith(".toml"));
  assert.ok(entries.length >= 3, `expected >= 3 personas, got ${entries.length}`);
  for (const entry of entries) {
    const st = await stat(path.join(personasDir, entry));
    assert.ok(st.size > 50, `persona ${entry} should be non-trivial`);
  }
  assert.equal(result.programName, "my-program");
});

test("renderGettingStarted: under ~50 lines, references programName, names `riptide run`", () => {
  const body = renderGettingStarted("my-program");
  const lines = body.split("\n");
  assert.ok(lines.length <= 60, `getting-started should fit on one screen (<= 60 lines), got ${lines.length}`);
  assert.ok(body.includes("my-program"), "must reference the program name");
  assert.ok(body.includes("riptide run"));
});
