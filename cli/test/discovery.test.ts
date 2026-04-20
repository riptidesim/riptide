// Scenario-discovery tests.
//
// Covers:
// - recursive walk at varying depths
// - sort stability + lexicographic ordering
// - name derivation (no `.json`, `/` separator preserved)
// - empty `.riptide/scenarios/` → ok with empty list
// - missing `.riptide/` → kind: "missing"
// - malformed run-config.json emits warning, good files still returned
// - `runList` exit codes + stdout/stderr shape

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverScenarios } from "../src/discovery/index.js";
import { runList } from "../src/commands/list.js";

const GOOD_RUN_CONFIG = JSON.stringify({
  agents: 1,
  ticks: 1,
  scenario: "x",
  seed: 1,
  personas: []
});

async function makeScenario(
  root: string,
  name: string,
  body: string = GOOD_RUN_CONFIG
): Promise<string> {
  const dir = path.join(root, ".riptide", "scenarios", ...name.split("/"));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "run-config.json");
  await writeFile(file, body, "utf8");
  return file;
}

async function makeEmptyRiptide(root: string): Promise<void> {
  await mkdir(path.join(root, ".riptide", "scenarios"), { recursive: true });
}

async function tmpRoot(label: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), `riptide-discovery-${label}-`));
}

test("discovery: walks recursively at varying depths", async () => {
  const root = await tmpRoot("recursive");
  await makeScenario(root, "foo");
  await makeScenario(root, "a/b/c");
  await makeScenario(root, "hero-grid/w25-s40");

  const result = await discoverScenarios({ cwd: root });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;

  const names = result.scenarios.map((s) => s.name);
  assert.deepEqual(names, ["a/b/c", "foo", "hero-grid/w25-s40"]);
  for (const scenario of result.scenarios) {
    assert.ok(
      path.isAbsolute(scenario.runConfigPath),
      `expected absolute path, got ${scenario.runConfigPath}`
    );
    assert.ok(scenario.runConfigPath.endsWith("run-config.json"));
  }
});

test("discovery: sort is stable across reruns (lexicographic)", async () => {
  const root = await tmpRoot("sort");
  await makeScenario(root, "c");
  await makeScenario(root, "b/d");
  await makeScenario(root, "b/c");
  await makeScenario(root, "a");

  const first = await discoverScenarios({ cwd: root });
  const second = await discoverScenarios({ cwd: root });
  assert.equal(first.kind, "ok");
  assert.equal(second.kind, "ok");
  if (first.kind !== "ok" || second.kind !== "ok") return;

  const firstNames = first.scenarios.map((s) => s.name);
  const secondNames = second.scenarios.map((s) => s.name);
  assert.deepEqual(firstNames, secondNames);
  assert.deepEqual(firstNames, ["a", "b/c", "b/d", "c"]);
});

test("discovery: sort is plain lexicographic (w100- comes before w25-)", async () => {
  const root = await tmpRoot("lex");
  await makeScenario(root, "w25-s20");
  await makeScenario(root, "w100-s20");

  const result = await discoverScenarios({ cwd: root });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  const names = result.scenarios.map((s) => s.name);
  // Documenting plain lex behavior: '1' < '2' as string chars.
  assert.deepEqual(names, ["w100-s20", "w25-s20"]);
});

test("discovery: scenario names use `/` separator and no .json extension", async () => {
  const root = await tmpRoot("names");
  await makeScenario(root, "hero-grid/w25-s40");

  const result = await discoverScenarios({ cwd: root });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;

  assert.equal(result.scenarios.length, 1);
  const scenario = result.scenarios[0]!;
  assert.equal(scenario.name, "hero-grid/w25-s40");
  assert.ok(!scenario.name.includes("\\"));
  assert.ok(!scenario.name.endsWith(".json"));
});

test("discovery: empty .riptide/scenarios/ → ok, empty list", async () => {
  const root = await tmpRoot("empty");
  await makeEmptyRiptide(root);

  const result = await discoverScenarios({ cwd: root });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.scenarios, []);
  assert.deepEqual(result.warnings, []);
});

test("discovery: missing .riptide/ → kind: missing", async () => {
  const root = await tmpRoot("missing");
  const result = await discoverScenarios({ cwd: root });
  assert.equal(result.kind, "missing");
  if (result.kind !== "missing") return;
  assert.match(result.message, /\.riptide/);
});

test("discovery: malformed JSON → warning emitted, good scenarios still returned", async () => {
  const root = await tmpRoot("malformed");
  await makeScenario(root, "good-one");
  await makeScenario(root, "bad-one", "{ this is not valid json");
  await makeScenario(root, "another-good");

  const result = await discoverScenarios({ cwd: root });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;

  const names = result.scenarios.map((s) => s.name);
  assert.deepEqual(names, ["another-good", "good-one"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /bad-one/);
  assert.match(result.warnings[0]!, /malformed JSON/);
});

test("discovery: .riptide/ without scenarios subdir → ok, empty list", async () => {
  const root = await tmpRoot("noscenarios");
  await mkdir(path.join(root, ".riptide"), { recursive: true });

  const result = await discoverScenarios({ cwd: root });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.scenarios, []);
});

// --- runList exit codes ---

test("runList: missing .riptide/ → exit 2", async () => {
  const root = await tmpRoot("list-missing");
  const exit = await runList({ dir: root });
  assert.equal(exit, 2);
});

test("runList: empty scenarios → exit 0 with no output", async () => {
  const root = await tmpRoot("list-empty");
  await makeEmptyRiptide(root);

  // Capture stdout writes via a stub dependency.
  const writes: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await runList({ dir: root });
    assert.equal(exit, 0);
    assert.deepEqual(writes, []);
  } finally {
    process.stdout.write = origWrite;
  }
});

test("runList: happy path → exit 0 with sorted names on stdout", async () => {
  const root = await tmpRoot("list-happy");
  await makeScenario(root, "foo/bar");
  await makeScenario(root, "hero-grid/w25-s40");
  await makeScenario(root, "alpha");

  const writes: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    const exit = await runList({ dir: root });
    assert.equal(exit, 0);
    assert.deepEqual(writes, [
      "alpha\n",
      "foo/bar\n",
      "hero-grid/w25-s40\n"
    ]);
  } finally {
    process.stdout.write = origWrite;
  }
});
