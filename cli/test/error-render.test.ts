// T04 — top-level CLI error rendering tests.
//
// Covers:
// - default surface is message-first; no `Error:` prefix or stack
// - RIPTIDE_DEBUG=1 restores the stack trace
// - non-Error throws never collapse to `[object Object]`
// - existing structured messages (file + field + expected + actual +
//   next step) carry through unchanged.

import test from "node:test";
import assert from "node:assert/strict";

import { renderCliError, shouldShowStack } from "../src/errors/render.js";

test("renderCliError: default hides stack and prefixes with `riptide:`", () => {
  const err = new Error("adapter not found at /tmp/x.toml");
  const out = renderCliError(err, { env: {}, color: false });
  assert.match(out, /riptide: adapter not found at \/tmp\/x\.toml/);
  assert.doesNotMatch(out, /at Object\./); // no stack frames
  assert.doesNotMatch(out, /Error:/); // no `Error: ` noise prefix
  assert.match(out, /set RIPTIDE_DEBUG=1/);
});

test("renderCliError: RIPTIDE_DEBUG=1 includes the stack", () => {
  const err = new Error("kaboom");
  const out = renderCliError(err, { env: { RIPTIDE_DEBUG: "1" }, color: false });
  assert.match(out, /riptide: kaboom/);
  assert.match(out, /--- stack trace/);
  // the stack should mention this test file
  assert.match(out, /error-render\.test/);
});

test("renderCliError: RIPTIDE_DEBUG=0 still hides the stack", () => {
  const err = new Error("muted");
  const out = renderCliError(err, { env: { RIPTIDE_DEBUG: "0" }, color: false });
  assert.match(out, /riptide: muted/);
  // Allow the hint line "(set RIPTIDE_DEBUG=1 for the full stack trace)";
  // the actual stack-trace banner is what should be absent.
  assert.doesNotMatch(out, /--- stack trace/);
  // And no actual stack frames either.
  assert.doesNotMatch(out, /at Object\./);
});

test("renderCliError: object thrown does not collapse to [object Object]", () => {
  const out = renderCliError(
    { code: "EWEIRD", note: "thrown as object" },
    { env: {}, color: false }
  );
  assert.doesNotMatch(out, /\[object Object\]/);
  assert.match(out, /EWEIRD/);
  assert.match(out, /thrown as object/);
});

test("renderCliError: null throw is safely labelled", () => {
  const out = renderCliError(null, { env: {}, color: false });
  assert.match(out, /null thrown/);
  assert.doesNotMatch(out, /\[object Object\]/);
});

test("renderCliError: multi-line message preserves structure (file + hint lines)", () => {
  const err = new Error(
    "replay-config not found at fixtures/x.json\n" +
      "  expected: a JSON file shaped { adapter, trajectory_dir }\n" +
      "  next: see examples/replays/* for both shapes."
  );
  const out = renderCliError(err, { env: {}, color: false });
  assert.match(out, /riptide: replay-config not found at fixtures\/x\.json/);
  assert.match(out, /expected: a JSON file/);
  assert.match(out, /next: see examples\/replays/);
});

test("renderCliError: circular-ref object thrown does not collapse to [object Object]", () => {
  // Review regression: JSON.stringify throws on cyclic structures, and
  // the old fallback returned Object.prototype.toString.call(err),
  // which renders as `[object Object]` for plain objects — defeating
  // the no-`[object Object]` contract the renderer exists to enforce.
  const cyclic: { code: string; self?: unknown } = { code: "ECYCLE" };
  cyclic.self = cyclic;
  const out = renderCliError(cyclic, { env: {}, color: false });
  assert.doesNotMatch(out, /\[object Object\]/);
  // The best-effort fallback should still surface SOMETHING useful —
  // either the class name or the key list — so the operator has a
  // toehold. `code` was one of the top-level keys.
  assert.match(out, /code/);
});

test("renderCliError: cyclic class instance surfaces class name, not [object Object]", () => {
  class OddError {
    code: string;
    next?: OddError;
    constructor(code: string) {
      this.code = code;
    }
  }
  const a = new OddError("ECYCLE_B");
  const b = new OddError("ECYCLE_A");
  a.next = b;
  b.next = a;
  const out = renderCliError(a, { env: {}, color: false });
  assert.doesNotMatch(out, /\[object Object\]/);
  assert.match(out, /OddError/);
});

// Review regression: JSON.stringify returns `undefined` (not throws)
// for Symbols, functions, and certain collapse-to-undefined objects.
// The old fallback only fired on throws, so the downstream
// `message.split("\n")` crashed trying to split an undefined. These
// assertions pin the fix: the renderer must never throw, never emit
// `[object Object]`, and always hand back a usable one-liner.
test("renderCliError: Symbol throw renders as a Symbol line, no crash", () => {
  const sym = Symbol("ESYMBOL");
  const out = renderCliError(sym, { env: {}, color: false });
  assert.match(out, /Symbol/);
  assert.match(out, /ESYMBOL/);
  assert.doesNotMatch(out, /\[object Object\]/);
  assert.ok(out.startsWith("riptide:"), `expected message-first surface, got:\n${out}`);
});

test("renderCliError: bare function throw renders as a function line, no crash", () => {
  function boom() {}
  const out = renderCliError(boom, { env: {}, color: false });
  assert.match(out, /function thrown/);
  assert.match(out, /boom/);
  assert.doesNotMatch(out, /\[object Object\]/);
  assert.ok(out.startsWith("riptide:"), `expected message-first surface, got:\n${out}`);
});

test("renderCliError: anonymous function throw renders with an anonymous label", () => {
  const out = renderCliError(() => undefined, { env: {}, color: false });
  assert.match(out, /function thrown: anonymous/);
  assert.doesNotMatch(out, /\[object Object\]/);
});

test("renderCliError: object whose JSON.stringify collapses to undefined does not crash", () => {
  // `toJSON: () => undefined` makes JSON.stringify return undefined
  // (not throw). The old fallback never fired and the renderer went
  // on to split `undefined`, crashing the CLI catch path.
  const nasty = {
    code: "EUNSERIALIZABLE",
    toJSON: () => undefined,
  };
  const out = renderCliError(nasty, { env: {}, color: false });
  assert.doesNotMatch(out, /\[object Object\]/);
  assert.ok(
    /non-serializable/.test(out) || /EUNSERIALIZABLE/.test(out),
    `expected non-serializable fallback or visible class/keys, got:\n${out}`
  );
});

test("renderCliError: bigint throw renders safely", () => {
  const out = renderCliError(42n, { env: {}, color: false });
  assert.match(out, /42/);
  assert.doesNotMatch(out, /\[object Object\]/);
});

test("shouldShowStack: defaults off; toggles on for non-zero / non-false RIPTIDE_DEBUG", () => {
  assert.equal(shouldShowStack({}), false);
  assert.equal(shouldShowStack({ RIPTIDE_DEBUG: "" }), false);
  assert.equal(shouldShowStack({ RIPTIDE_DEBUG: "0" }), false);
  assert.equal(shouldShowStack({ RIPTIDE_DEBUG: "false" }), false);
  assert.equal(shouldShowStack({ RIPTIDE_DEBUG: "1" }), true);
  assert.equal(shouldShowStack({ RIPTIDE_DEBUG: "true" }), true);
  assert.equal(shouldShowStack({ RIPTIDE_DEBUG: "verbose" }), true);
});
