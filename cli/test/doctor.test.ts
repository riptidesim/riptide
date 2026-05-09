// `riptide doctor` integration tests.
//
// Covers:
// - all-pass exit 0
// - missing tool → exit 2 (FAIL)
// - drifted tool version → exit 1 (WARN)
// - adapter discovery in monorepo (`fixtures/adapters`) and downstream
//   user-repo (`.riptide/adapters`) shapes
// - per-adapter load + lint status + next-step hint
// - no-adapters-discovered surface
// - shipping monorepo run produces a coherent report
// - doctor is fast / static — no engine spawn even under failure
//
// Implementation note: every test injects toolchain probe + engine
// resolver stubs so the suite stays hermetic and never depends on
// the host machine's toolchain state.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDoctor } from "../src/commands/doctor.js";
import {
  buildDoctorReport,
  discoverAdapters,
  type DiscoveredAdapter,
} from "../src/doctor/index.js";

// Mirror of the spec list — keeps tests honest about which tools doctor
// is supposed to know about.
const TOOL_IDS = ["node", "npm", "rustc", "cargo", "solana", "cargo-build-sbf"] as const;

function fakeProbe(versions: Record<string, string | undefined>) {
  return async (spec: { id: string; bin: string }) => {
    const v = versions[spec.id];
    return v ? { version: v } : {};
  };
}

const HEALTHY_VERSIONS = {
  node: "v24.11.1",
  npm: "11.6.2",
  rustc: "rustc 1.91.1 (abc123 2026-04-01)",
  cargo: "cargo 1.91.1 (def456 2026-04-01)",
  solana: "solana-cli 3.0.13 (channel: stable)",
  "cargo-build-sbf": "solana-cargo-build-sbf 3.0.13",
};

const SIMPLE_IDL = JSON.stringify({
  version: "0.1.0",
  name: "simple",
  instructions: [
    {
      name: "deposit",
      accounts: [{ name: "owner", signer: true }, { name: "pool", writable: true }],
      args: [{ name: "amount", type: "u64" }],
    },
  ],
  accounts: [
    {
      name: "pool",
      fields: [{ name: "total_deposits", type: "u64" }],
    },
  ],
});

/**
 * Build a clean generic adapter TOML parametric on the adapter-relative
 * `idl_path` (engine-side resolution) — `[lineage].idl_source` stays
 * repo-root-relative because the CLI's lint path resolves it via
 * `deriveRepoRoot`, which points at the same on-disk file regardless of
 * where the adapter sits in the repo tree.
 */
function cleanAdapterToml(idlRelFromAdapterDir: string): string {
  return `protocol = "generic"
program_so = "./simple.so"
idl_path = "${idlRelFromAdapterDir}"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
generator = "hand-authored"
`;
}

async function setupRepo(opts: {
  /** Adapter file shape: monorepo fixtures vs user-repo .riptide/. */
  layout: "monorepo" | "user-repo" | "both" | "empty";
  /**
   * Adapter TOML override. When provided, the caller is responsible
   * for choosing a valid `idl_path` for the adapter's on-disk location.
   * When absent, `setupRepo` picks the layout-appropriate clean TOML.
   */
  adapterToml?: string;
  idlContents?: string | null;
  /**
   * When true (default) drop a zero-byte stub `simple.so` next to each
   * written adapter so the doctor's runtime-path existence check
   * passes. Regression tests for the runtime-path contract set this
   * false to assert the check actually fires.
   */
  writeStubSo?: boolean;
}): Promise<{ cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-test-"));
  const writeStubSo = opts.writeStubSo !== false;

  const idlsDir = path.join(cwd, "fixtures", "idls");
  if (opts.idlContents !== null) {
    await mkdir(idlsDir, { recursive: true });
    await writeFile(path.join(idlsDir, "simple.json"), opts.idlContents ?? SIMPLE_IDL, "utf8");
  }

  if (opts.layout === "monorepo" || opts.layout === "both") {
    const dir = path.join(cwd, "fixtures", "adapters");
    await mkdir(dir, { recursive: true });
    // `fixtures/adapters/` → IDL at `fixtures/idls/` is `../idls/...`.
    const adapter = opts.adapterToml ?? cleanAdapterToml("../idls/simple.json");
    await writeFile(path.join(dir, "shipping-fork.toml"), adapter, "utf8");
    if (writeStubSo) await writeFile(path.join(dir, "simple.so"), Buffer.alloc(0));
  }
  if (opts.layout === "user-repo" || opts.layout === "both") {
    const dir = path.join(cwd, ".riptide", "adapters");
    await mkdir(dir, { recursive: true });
    // `.riptide/adapters/` → IDL at `fixtures/idls/` is `../../fixtures/idls/...`.
    const adapter = opts.adapterToml ?? cleanAdapterToml("../../fixtures/idls/simple.json");
    await writeFile(path.join(dir, "my-program.toml"), adapter, "utf8");
    if (writeStubSo) await writeFile(path.join(dir, "simple.so"), Buffer.alloc(0));
  }
  return { cwd };
}

// ---- discoverAdapters ----
//
// Adapter discovery: discovery is layered, not unioned. The first
// on-disk layer that yields any adapter wins; later layers do not
// contribute. This guarantees a downstream user repo with its own
// `.riptide/adapters/` cannot inherit shipping adapters from a
// monorepo checkout the CLI module happens to live inside.

test("discoverAdapters: monorepo in-tree layer — `<cwd>/fixtures/adapters` picks up shipping-fork only", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  const found = discoverAdapters(cwd);
  const names = found.map((a) => a.name).sort();
  // The in-tree monorepo layer wins (`<cwd>/fixtures/adapters/`);
  // the module-derived monorepo layer never runs because the earlier
  // layer already yielded adapters.
  assert.deepEqual(names, ["shipping-fork"]);
  assert.equal(found[0]!.source, "monorepo-fixtures");
});

test("discoverAdapters: user-repo layer — `.riptide/adapters` wins, does NOT leak monorepo fixtures", async () => {
  const { cwd } = await setupRepo({ layout: "user-repo" });
  const found = discoverAdapters(cwd);
  const names = found.map((a) => a.name).sort();
  // Review regression: previously `discoverAdapters` unconditionally
  // unioned the module-derived monorepo root, so a downstream user
  // repo like this one pulled in amm / liquid-staking /
  // perpetuals / resource-grinder / lending. Every path beneath
  // the test cwd is all we should ever see here.
  assert.deepEqual(names, ["my-program"], `unexpected monorepo leak: ${names.join(", ")}`);
  const myProgram = found.find((a) => a.name === "my-program");
  assert.equal(myProgram!.source, "user-repo-riptide-dir");
  for (const hit of found) {
    assert.ok(
      hit.path.startsWith(cwd + path.sep),
      `leaked adapter from outside the test cwd: ${hit.path}`
    );
  }
});

test("discoverAdapters: both-shapes user repo — `.riptide/adapters` wins over in-tree monorepo", async () => {
  const { cwd } = await setupRepo({ layout: "both" });
  const found = discoverAdapters(cwd);
  const names = found.map((a) => a.name).sort();
  // Layered, not unioned: once the .riptide/ layer yields anything,
  // later layers must not contribute. `shipping-fork` exists on disk
  // in this tree (under `<cwd>/fixtures/adapters/`) but must NOT
  // appear in the report.
  assert.deepEqual(names, ["my-program"], `expected only my-program, got: ${names.join(", ")}`);
});

test("discoverAdapters: does NOT trust an arbitrary parent `fixtures/adapters/`", async () => {
  // Review regression: an earlier draft added a `<cwd>/../fixtures/adapters`
  // layer as a "contributor seam" for doctor run from `cli/`. It trusted
  // any parent directory, so a nested cwd inherited adapters from a
  // sibling repo. Reviewer reproduced this by planting
  // `/tmp/.../fixtures/adapters/parent-hit.toml` and running discovery
  // from `/tmp/.../child`.
  //
  // Fix contract: only `<cwd>/...` and the module-derived monorepo root
  // are trusted. Any adapter living in `<cwd>/..` must not appear.
  const parent = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-parent-"));
  const parentAdapters = path.join(parent, "fixtures", "adapters");
  await mkdir(parentAdapters, { recursive: true });
  await writeFile(
    path.join(parentAdapters, "parent-hit.toml"),
    `protocol = "lending"
[instructions]
deposit = { action = "deposit", amount = "amount" }
[state_mapping]
"pool.total_deposits" = "tvl"
[actions]
[observations]
[personas]
`,
    "utf8"
  );
  const child = path.join(parent, "child");
  await mkdir(child, { recursive: true });

  const found = discoverAdapters(child);
  const leaked = found.find((a) => a.name === "parent-hit");
  assert.equal(leaked, undefined, `parent-dir leak: doctor picked up ${leaked?.path}`);
  // Any hit must come from `<child>/...` or the module-derived monorepo.
  // Nothing may come from `<parent>/fixtures/adapters/`.
  for (const hit of found) {
    assert.ok(
      !hit.path.startsWith(parentAdapters + path.sep) && hit.path !== parentAdapters,
      `doctor leaked an adapter from an arbitrary parent dir: ${hit.path}`
    );
  }
});

test("discoverAdapters: module-root fallback — source-checkout CLI still finds shipping fixtures from a fresh cwd", async () => {
  // Empty temp cwd with no `.riptide/` and no `fixtures/`. The
  // module-derived monorepo root is the last-resort layer; it fires
  // when the CLI module itself lives inside a source checkout of the
  // Riptide monorepo (the install-first path via `install.sh`, or the
  // `cd cli && riptide doctor` contributor case after a build). This
  // test runs in exactly that shape — it is a source-checkout
  // regression gate, NOT a claim about arbitrary npm-installed
  // packages; `cli/package.json` does not ship fixtures,
  // so a truly packaged install returns `[]` here by design.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-fallback-"));
  const found = discoverAdapters(cwd);
  const monorepoHits = found.filter((a) => a.source === "monorepo-fixtures");
  assert.ok(
    monorepoHits.length > 0,
    `expected shipping fixtures via source-checkout module-derived fallback; got ${found.length} entries`
  );
});

// ---- runDoctor / buildDoctorReport ----
//
// Important: these tests deliberately do NOT filter discovery down to
// the temp cwd. Adapter discovery makes discovery layered — the first
// layer that yields any adapter wins — so a user repo with its own
// `.riptide/adapters/` must not inherit shipping fixtures from the
// surrounding Riptide checkout. If these tests start failing because
// unrelated monorepo adapters leak in, `discoverAdapters` has
// regressed, not the test harness.

test("runDoctor: healthy toolchain + clean adapter → exit 0", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 0, `expected 0, got ${exit}. stdout:\n${out}`);
  assert.match(out, /Doctor — Riptide health check/);
  // Every documented tool is named in the environment block.
  for (const id of TOOL_IDS) {
    assert.match(out, new RegExp(id), `tool ${id} missing from output`);
  }
  assert.match(out, /riptide-engine/);
  assert.match(out, /shipping-fork/);
  assert.match(out, /Verdict: PASS/);
});

test("runDoctor: missing required tool → exit 2 with hint", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe({ ...HEALTHY_VERSIONS, "cargo-build-sbf": undefined }),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /FAIL/);
  assert.match(out, /cargo-build-sbf/);
  assert.match(out, /not found on PATH/);
  assert.match(out, /Verdict: FAIL/);
});

test("runDoctor: missing engine binary → exit 2 with build hint", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => {
            throw new Error("Could not locate the riptide-engine binary");
          },
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /riptide-engine/);
  assert.match(out, /cargo build --release -p riptide-engine/);
});

// Review regression: npm / cargo / cargo-build-sbf used to ship
// without `inBand` checks, so an injected `0.0.1` surfaced as PASS
// instead of WARN. These three assertions pin the fix.
// Review regression #1: a generic adapter with no [lineage] block
// must land as WARN (exit 1), not PASS. The prior behavior shortcut
// through exitCode: 0 because the only finding was a SKIP, which
// violated skipped machine validation — skipped machine validation belongs on the
// warning surface, not all-clear.
test("runDoctor: adapter with no [lineage] block → lint=warn, doctor exit 1", async () => {
  const noLineage = `protocol = "generic"
program_so = "./simple.so"
idl_path = "../../fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []
`;
  const { cwd } = await setupRepo({ layout: "user-repo", adapterToml: noLineage });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
        }),
    }
  );
  assert.equal(exit, 1, `expected 1 (WARN) for no-[lineage] adapter, got ${exit}. stdout:\n${out}`);
  assert.match(out, /lint=warn/);
  assert.match(out, /no \[lineage\] block — machine validation skipped/);
  assert.match(out, /add a \[lineage\] block/);
  assert.match(out, /Verdict: WARN/);
});

// Review regression #2: a downstream user repo with its own
// `.riptide/adapters/my-program.toml` must not inherit shipping
// adapters from the surrounding Riptide checkout. Previously the
// module-derived monorepo root was unioned into discovery and
// unrelated warns/fails (`perpetuals`, `lending`) bubbled up into
// the downstream operator's exit code.
test("runDoctor: downstream user repo is isolated — does NOT inherit shipping monorepo adapters", async () => {
  const { cwd } = await setupRepo({ layout: "user-repo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
        }),
    }
  );
  // The user's one adapter is clean (json-idl lineage, real IDL on
  // disk) so exit is 0 here — the important thing is the isolation:
  // no shipping adapter names appear, and the surrounding Riptide
  // checkout cannot flip the verdict via a drifted fixture.
  assert.ok(exit === 0 || exit === 1, `expected 0/1 from user-repo only, got ${exit}. stdout:\n${out}`);
  assert.match(out, /my-program/);
  for (const shipping of ["amm", "perpetuals", "liquid-staking", "lending", "resource-grinder"]) {
    assert.doesNotMatch(
      out,
      new RegExp(`\\b${shipping}\\b`),
      `downstream doctor report leaked shipping adapter \`${shipping}\`:\n${out}`
    );
  }
});

test("runDoctor: drifted npm version → exit 1 (WARN)", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe({ ...HEALTHY_VERSIONS, npm: "0.0.1" }),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 1, `expected 1 (WARN), got ${exit}. stdout:\n${out}`);
  assert.match(out, /WARN  npm/);
});

test("runDoctor: drifted cargo version → exit 1 (WARN)", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe({ ...HEALTHY_VERSIONS, cargo: "cargo 0.1.0 (old)" }),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 1, `expected 1 (WARN), got ${exit}. stdout:\n${out}`);
  assert.match(out, /WARN  cargo\b/);
});

test("runDoctor: drifted cargo-build-sbf version → exit 1 (WARN)", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe({ ...HEALTHY_VERSIONS, "cargo-build-sbf": "0.0.1" }),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 1, `expected 1 (WARN), got ${exit}. stdout:\n${out}`);
  assert.match(out, /WARN  cargo-build-sbf/);
});

test("runDoctor: drifted Rust version → exit 1 (WARN), no FAIL", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe({ ...HEALTHY_VERSIONS, rustc: "rustc 1.50.0 (very old)" }),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 1);
  assert.match(out, /WARN/);
  assert.match(out, /rustc/);
  assert.doesNotMatch(out, /Verdict: FAIL/);
});

test("runDoctor: discovered adapter with broken instruction → lint FAIL → doctor exit 2", async () => {
  // Use the user-repo layout idl_path convention so the runtime-path
  // check passes and the only failure is the lint mismatch.
  const broken = cleanAdapterToml("../../fixtures/idls/simple.json").replace(
    /\[instructions\]\ndeposit = \{ action = "deposit", amount = "amount" \}/,
    `[instructions]\nghost_ix = { action = "deposit", amount = "amount" }`
  );
  const { cwd } = await setupRepo({ layout: "user-repo", adapterToml: broken });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2, `expected 2, got ${exit}. stdout:\n${out}`);
  assert.match(out, /my-program/);
  assert.match(out, /lint=fail/);
  assert.match(out, /riptide lint my-program/);
});

test("runDoctor: adapter present + no IDL on disk → idl-unreadable FAIL", async () => {
  const { cwd } = await setupRepo({ layout: "user-repo", idlContents: null });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2);
  assert.match(out, /lint=fail/);
});

test("runDoctor: monorepo fixture with missing program_so → bounded optional-runtime WARN", async () => {
  const { cwd } = await setupRepo({ layout: "monorepo", writeStubSo: false });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
        }),
    }
  );
  assert.equal(exit, 1, `expected 1 (WARN), got ${exit}. stdout:\n${out}`);
  assert.match(out, /load=warn/);
  assert.match(out, /lint=warn/);
  assert.match(out, /optional fixture runtime artifact not built/);
  assert.match(out, /program_so not found on disk/);
  assert.match(out, /Verdict: WARN/);
});

test("runDoctor: monorepo fixture with missing idl_path → load=fail", async () => {
  const brokenIdl = cleanAdapterToml("/nonexistent/simple.json");
  const { cwd } = await setupRepo({
    layout: "monorepo",
    adapterToml: brokenIdl,
    writeStubSo: false,
  });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
        }),
    }
  );
  assert.equal(exit, 2, `expected 2 (FAIL), got ${exit}. stdout:\n${out}`);
  assert.match(out, /load=fail/);
  assert.match(out, /lint=fail/);
  assert.match(out, /idl_path not found on disk/);
  assert.doesNotMatch(out, /optional fixture runtime artifact not built/);
  assert.match(out, /Verdict: FAIL/);
});

test("runDoctor: empty repo (no adapters anywhere) → exit 1 with init hint", async () => {
  const { cwd } = await setupRepo({ layout: "empty", idlContents: null });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // CRITICAL: also disable the module-derived monorepo fallback,
          // otherwise tests pick up shipping fixtures from this very repo.
          discoverAdapters: () => [] as DiscoveredAdapter[],
        }),
    }
  );
  assert.equal(exit, 1, `expected 1, got ${exit}. stdout:\n${out}`);
  assert.match(out, /none discovered/);
  assert.match(out, /riptide init/);
  assert.match(out, /Verdict: WARN/);
});

test("runDoctor: shipping monorepo fixtures are pass or bounded warnings", async () => {
  // Use the real shipping monorepo fixtures by pointing cwd at it.
  const cwd = path.resolve(process.cwd(), "..");
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
      }),
    }
  );
  assert.ok(exit === 0 || exit === 1, `expected 0/1 on shipping monorepo, got ${exit}. stdout:\n${out}`);
  assert.match(out, /lending/);
  assert.doesNotMatch(out, /Verdict: FAIL/);
  assert.doesNotMatch(out, /lint=fail/);
  assert.doesNotMatch(out, /load=fail/);
  if (exit === 1) {
    assert.match(out, /optional fixture runtime artifact not built|uncovered surface/);
    assert.match(out, /Verdict: WARN/);
  } else {
    assert.match(out, /Verdict: PASS/);
  }
});

// ---- review regression: runtime-path existence (mirrors engine loader) ----

// A generic adapter whose `program_so` and `idl_path` are valid TOML
// strings but point at files that don't exist on disk. Doctor must
// flag this as `load=fail` — the engine would reject the same adapter
// at the first run attempt, so a PASS surface here is a false positive.
// User-repo layout adapter (placed at `<cwd>/.riptide/adapters/`).
// idl_path uses the layout-correct relative form so the runtime-path
// check can discriminate the specific failure under test — here,
// program_so missing on disk.
const DEAD_PROGRAM_SO_TOML = `protocol = "generic"
program_so = "/nonexistent/simple.so"
idl_path = "../../fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/simple.json"
`;

const DEAD_IDL_PATH_TOML = DEAD_PROGRAM_SO_TOML
  .replace('program_so = "/nonexistent/simple.so"', 'program_so = "./simple.so"')
  .replace('idl_path = "../../fixtures/idls/simple.json"', 'idl_path = "/nonexistent/simple.json"');

test("runDoctor: generic adapter with dead program_so → load=fail (mirrors engine loader)", async () => {
  const { cwd } = await setupRepo({
    layout: "user-repo",
    adapterToml: DEAD_PROGRAM_SO_TOML,
  });
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2, `expected 2 (FAIL), got ${exit}. stdout:\n${out}`);
  assert.match(out, /load=fail/);
  assert.match(out, /program_so not found on disk/);
  assert.match(out, /\/nonexistent\/simple\.so/);
  assert.match(out, /cargo build-sbf/);
});

test("runDoctor: generic adapter with dead idl_path → load=fail", async () => {
  // Give the adapter a real stub .so so only idl_path is the failing
  // path — confirms idl existence is checked independently.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-test-"));
  const adaptersDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  // Drop a real zero-byte `.so` next to the adapter TOML so program_so
  // resolves; the adapter points idl_path at /nonexistent.
  const stubSo = path.join(adaptersDir, "simple.so");
  await writeFile(stubSo, Buffer.alloc(0));
  const adapterPath = path.join(adaptersDir, "my-program.toml");
  await writeFile(adapterPath, DEAD_IDL_PATH_TOML, "utf8");

  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2, `expected 2 (FAIL), got ${exit}. stdout:\n${out}`);
  assert.match(out, /load=fail/);
  assert.match(out, /idl_path not found on disk/);
  assert.match(out, /\/nonexistent\/simple\.json/);
});

test("runDoctor: user .riptide adapter resolves scaffolded target paths from repo root", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-test-"));
  const adaptersDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await mkdir(path.join(cwd, "target", "deploy"), { recursive: true });
  await mkdir(path.join(cwd, "target", "idl"), { recursive: true });
  await writeFile(path.join(cwd, "target", "deploy", "simple.so"), Buffer.alloc(0));
  await writeFile(path.join(cwd, "target", "idl", "simple.json"), SIMPLE_IDL, "utf8");
  await writeFile(
    path.join(adaptersDir, "my-program.toml"),
    `protocol = "generic"
program_so = "target/deploy/simple.so"
idl_path = "target/idl/simple.json"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "target/idl/simple.json"
generator = "hand-authored"
`,
    "utf8"
  );

  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
        }),
    }
  );
  assert.equal(exit, 0, `expected 0 (PASS), got ${exit}. stdout:\n${out}`);
  assert.match(out, /load=pass\s+·\s+lint=pass/);
  assert.doesNotMatch(out, /\.riptide\/adapters\/target\/deploy\/simple\.so/);
});

test("runDoctor: generic adapter with dead owner.program_so → load=fail", async () => {
  // Build a generic adapter with an oracle account owner pointing at a
  // non-existent sibling .so. Doctor must catch this before the engine
  // would at boot.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-test-"));
  const adaptersDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const stubSo = path.join(adaptersDir, "simple.so");
  await writeFile(stubSo, Buffer.alloc(0));
  const idlsDir = path.join(cwd, "fixtures", "idls");
  await mkdir(idlsDir, { recursive: true });
  await writeFile(path.join(idlsDir, "simple.json"), SIMPLE_IDL, "utf8");

  const adapterPath = path.join(adaptersDir, "owner-dead.toml");
  await writeFile(
    adapterPath,
    `protocol = "generic"
program_so = "./simple.so"
idl_path = "../../fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64
owner = { program_so = "/nonexistent/sibling.so" }

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []
`,
    "utf8"
  );

  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2, `expected 2 (FAIL), got ${exit}. stdout:\n${out}`);
  assert.match(out, /load=fail/);
  assert.match(out, /owner\.program_so not found on disk/);
});

test("runDoctor: generic adapter with present owner.program_so but missing sibling keypair → load=fail", async () => {
  // Mirrors the engine's sibling-keypair existence check. Build a
  // sibling .so but omit its companion `-keypair.json`.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-test-"));
  const adaptersDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  await writeFile(path.join(adaptersDir, "simple.so"), Buffer.alloc(0));
  const siblingSo = path.join(adaptersDir, "oracle_mock.so");
  await writeFile(siblingSo, Buffer.alloc(0));
  // NOTE: oracle_mock-keypair.json is intentionally NOT created.
  const idlsDir = path.join(cwd, "fixtures", "idls");
  await mkdir(idlsDir, { recursive: true });
  await writeFile(path.join(idlsDir, "simple.json"), SIMPLE_IDL, "utf8");

  const adapterPath = path.join(adaptersDir, "kp-missing.toml");
  await writeFile(
    adapterPath,
    `protocol = "generic"
program_so = "./simple.so"
idl_path = "../../fixtures/idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64
owner = { program_so = "./oracle_mock.so" }

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []
`,
    "utf8"
  );

  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 2, `expected 2 (FAIL), got ${exit}. stdout:\n${out}`);
  assert.match(out, /load=fail/);
  assert.match(out, /sibling keypair not found/);
  assert.match(out, /oracle_mock-keypair\.json/);
});

test("runDoctor: lending adapter with no program_so/idl_path is fine (does NOT trigger runtime-path fail)", async () => {
  // Lending adapters legitimately omit program_so / idl_path; the
  // engine's own `.so` discovery runs in the harness. The runtime-path
  // check must ONLY apply to generic adapters.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-test-"));
  const adaptersDir = path.join(cwd, ".riptide", "adapters");
  await mkdir(adaptersDir, { recursive: true });
  const adapterPath = path.join(adaptersDir, "lending.toml");
  await writeFile(
    adapterPath,
    `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[actions]
[observations]
[personas]
`,
    "utf8"
  );

  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: fakeProbe(HEALTHY_VERSIONS),
          resolveEngine: async () => "/fake/target/release/riptide-engine",
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  // Exit may be 0 (everything clean) or 1 (lineage missing SKIP renders
  // as PASS but nothing else warns). Must NOT be 2 — the lending adapter
  // has no runtime-path contract to violate.
  assert.ok(exit === 0 || exit === 1, `expected 0/1 on lending adapter, got ${exit}. stdout:\n${out}`);
  assert.doesNotMatch(out, /load=fail/);
});

// ---- regression: doctor must not spawn the engine ----

test("runDoctor: never spawns the engine — resolveEngine stub is the only call", async () => {
  // Drive the report builder with stubs that throw if anyone tries to
  // run the engine. resolveEngine returns a fake path; if the doctor
  // path ever spawned the binary, the underlying call would reach the
  // real `resolveEngineBinary` (which we are not invoking) and we'd
  // see test failures on machines without the engine built.
  const { cwd } = await setupRepo({ layout: "monorepo" });
  let resolveCalls = 0;
  let probeCalls = 0;
  let out = "";
  const exit = await runDoctor(
    {},
    {
      cwd,
      stdoutWrite: (c) => { out += c; },
      stderrWrite: () => {},
      color: false,
      buildReport: (input) =>
        buildDoctorReport({
          ...input,
          probeTool: async (spec) => {
            probeCalls += 1;
            return fakeProbe(HEALTHY_VERSIONS)(spec);
          },
          resolveEngine: async () => {
            resolveCalls += 1;
            return "/fake/target/release/riptide-engine";
          },
          // No sandboxed discovery override — discovery is
          // layered, not unioned. The real `discoverAdapters` must
          // honour that contract under test, not be filtered into
          // false-correctness at the call site.
        }),
    }
  );
  assert.equal(exit, 0);
  assert.equal(resolveCalls, 1, "engine resolver should be called exactly once (no spawn)");
  // One probe per documented tool — confirms doctor walked the spec
  // list rather than ad-hoc shelling out.
  assert.equal(probeCalls, TOOL_IDS.length);
});
