// Better Error Ergonomics for Loader Failures (CLI side).
//
// Drives the three first-run failure modes that surface inside the
// TypeScript CLI (not the engine binary):
//
// - Missing adapter TOML (handled in `buildSimulateOptions`).
// - Malformed adapter TOML (TOML parse error).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSimulateOptions } from "../src/config.js";

test("buildSimulateOptions: missing adapter TOML names file and suggests shipped examples", () => {
  assert.throws(
    () =>
      buildSimulateOptions({
        seed: 42,
        adapter: "/nonexistent/riptide/adapter.toml",
      }),
    (err: Error) => {
      assert.match(err.message, /adapter TOML not found/);
      assert.match(err.message, /\/nonexistent\/riptide\/adapter\.toml/);
      assert.match(err.message, /fixtures\/adapters\/lending\.toml/);
      return true;
    }
  );
});

test("buildSimulateOptions: malformed adapter TOML hints at brackets and quotes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-t03-toml-"));
  const adapterPath = path.join(dir, "busted.toml");
  await writeFile(adapterPath, 'protocol = "lending"\n[instructions\n');

  assert.throws(
    () =>
      buildSimulateOptions({
        seed: 42,
        adapter: adapterPath,
      }),
    (err: Error) => {
      assert.match(err.message, /TOML parse failed/);
      assert.match(err.message, /busted\.toml/);
      assert.match(err.message, /unclosed bracket/);
      assert.match(err.message, /missing quote/);
      return true;
    }
  );
});
