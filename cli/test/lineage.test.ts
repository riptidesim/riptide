// `riptide lineage` command tests.
//
// Covers:
// - rendering an adapter that carries a `[lineage]` block (byte-for-byte
//   pinned output so a reviewer's forwarded output stays stable)
// - "no lineage recorded" path for adapters that pre-date the surface
// - adapter resolution against the shipping fixtures/adapters root
// - error surface when the adapter name cannot be resolved

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderLineage, runLineage } from "../src/commands/lineage.js";

const ADAPTER_WITH_LINEAGE = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[actions]

[observations]

[personas]

[lineage]
idl_source = "programs/lending_pool/src/state.rs"
generator = "hand-authored"
inferred_assumptions = [
  "Lending primitive supplies the dispatch table",
  "Oracle state managed by the primitive, not the adapter",
]
unsupported_fields = [
  "LendingInstructionData::InitializeOracle",
  "LendingInstructionData::SetOraclePrice",
]
`;

const ADAPTER_WITHOUT_LINEAGE = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[actions]

[observations]

[personas]
`;

async function writeTempAdapter(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-lineage-test-"));
  const file = path.join(dir, `${name}.toml`);
  await writeFile(file, contents, "utf8");
  return file;
}

test("renderLineage formats a block with headings, bullets, and IDL source", () => {
  const output = renderLineage("lending", {
    idl_source: "programs/lending_pool/src/state.rs",
    generator: "hand-authored",
    inferred_assumptions: [
      "Lending primitive supplies the dispatch table",
      "Oracle state managed by the primitive",
    ],
    unsupported_fields: [
      "LendingInstructionData::InitializeOracle",
      "LendingInstructionData::SetOraclePrice",
    ],
  });

  const expected = [
    "Lineage — lending",
    "",
    "IDL source:",
    "  programs/lending_pool/src/state.rs",
    "",
    "Generator:",
    "  hand-authored",
    "",
    "Inferred assumptions:",
    "  - Lending primitive supplies the dispatch table",
    "  - Oracle state managed by the primitive",
    "",
    "Unsupported fields:",
    "  - LendingInstructionData::InitializeOracle",
    "  - LendingInstructionData::SetOraclePrice",
    "",
    "Inspection only — no IDL fetch, no validation against IDL. The adapter linter consumes this metadata.",
    "",
  ].join("\n");

  assert.equal(output, expected);
});

test("renderLineage prints the 'no lineage recorded' line when absent", () => {
  const output = renderLineage("legacy-adapter", undefined);
  assert.equal(
    output,
    "no lineage recorded for `legacy-adapter`; pre-dates the lineage surface\n"
  );
});

test("runLineage round-trips an adapter with a lineage block", async () => {
  const adapterPath = await writeTempAdapter("with-lineage", ADAPTER_WITH_LINEAGE);
  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runLineage(
    adapterPath,
    {},
    {
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 0, `expected 0, got ${exit}. stderr: ${stderrBuf}`);
  assert.equal(stderrBuf, "");
  assert.match(stdoutBuf, /^Lineage — with-lineage\n/);
  assert.match(stdoutBuf, /IDL source:\n {2}programs\/lending_pool\/src\/state\.rs/);
  assert.match(stdoutBuf, /Generator:\n {2}hand-authored/);
  assert.match(
    stdoutBuf,
    / {2}- Lending primitive supplies the dispatch table/
  );
  assert.match(
    stdoutBuf,
    / {2}- LendingInstructionData::InitializeOracle/
  );
});

test("runLineage prints the no-lineage line for adapters without the block", async () => {
  const adapterPath = await writeTempAdapter("bare", ADAPTER_WITHOUT_LINEAGE);
  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runLineage(
    adapterPath,
    {},
    {
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 0, `expected 0, got ${exit}. stderr: ${stderrBuf}`);
  assert.equal(stderrBuf, "");
  assert.equal(
    stdoutBuf,
    "no lineage recorded for `bare`; pre-dates the lineage surface\n"
  );
});

test("runLineage resolves short adapter names against the fixtures root", async () => {
  const fixturesRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-lineage-fixtures-"));
  const adaptersDir = path.join(fixturesRoot, "adapters");
  await writeFile(path.join(fixturesRoot, ".keep"), "", "utf8");
  const adapterPath = path.join(adaptersDir, "shorthand.toml");
  // mkdir -p semantics: writeFile requires parent dir.
  await (await import("node:fs/promises")).mkdir(adaptersDir, { recursive: true });
  await writeFile(adapterPath, ADAPTER_WITH_LINEAGE, "utf8");

  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runLineage(
    "shorthand",
    {},
    {
      fixturesRoot,
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 0, `expected 0, got ${exit}. stderr: ${stderrBuf}`);
  assert.match(stdoutBuf, /^Lineage — shorthand\n/);
});

test("runLineage exits 2 when the adapter cannot be resolved", async () => {
  const fixturesRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-lineage-missing-"));

  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runLineage(
    "not-a-real-adapter",
    {},
    {
      fixturesRoot,
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 2);
  assert.equal(stdoutBuf, "");
  assert.match(stderrBuf, /adapter not found for `not-a-real-adapter`/);
});

test("runLineage renders the shipping lending adapter end-to-end", async () => {
  // Integration-style: resolve against the real repo fixtures and
  // assert key lines land. Pins lineage accuracy for the shipping
  // adapter. Exercised only when run from the monorepo where the
  // shipping TOMLs live.
  const fixturesRoot = path.resolve(process.cwd(), "..", "fixtures");
  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runLineage(
    "lending",
    {},
    {
      fixturesRoot,
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 0, `expected 0, got ${exit}. stderr: ${stderrBuf}`);
  assert.match(stdoutBuf, /^Lineage — lending\n/);
  assert.match(stdoutBuf, /Generator:\n {2}hand-authored/);
  assert.match(stdoutBuf, /programs\/lending_pool\/src\/state\.rs/);
  assert.match(stdoutBuf, /Inferred assumptions:/);
  assert.match(stdoutBuf, /Unsupported fields:/);
});
