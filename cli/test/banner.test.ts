import test from "node:test";
import assert from "node:assert/strict";

import {
  bannerDecision,
  cliPackageVersion,
  printBanner,
  printInitBanner,
  renderBanner,
  renderInitBanner,
  shouldPrintBanner
} from "../src/banner.js";

test("banner suppresses when stdout is not a TTY", () => {
  assert.equal(shouldPrintBanner({ env: {}, flags: {}, isTTY: false }), false);
});

test("banner suppresses for json output", () => {
  assert.equal(shouldPrintBanner({ env: {}, flags: { json: true }, isTTY: true }), false);
  assert.equal(shouldPrintBanner({ env: {}, flags: { format: "json" }, isTTY: true }), false);
});

test("banner suppresses for quiet output", () => {
  assert.equal(shouldPrintBanner({ env: {}, flags: { quiet: true }, isTTY: true }), false);
});

test("banner suppresses when CI is truthy", () => {
  assert.equal(shouldPrintBanner({ env: { CI: "1" }, flags: {}, isTTY: true }), false);
  assert.equal(shouldPrintBanner({ env: { CI: "false" }, flags: {}, isTTY: true }), true);
});

test("banner prints without color when NO_COLOR is present", () => {
  const decision = bannerDecision({ env: { NO_COLOR: "1" }, flags: {}, isTTY: true });
  assert.deepEqual(decision, { print: true, color: false });
  const rendered = renderBanner("0.7.0", decision.color);
  assert.match(rendered, /RIPTIDE/);
  assert.match(rendered, /Riptide v0\.7\.0/);
  assert.doesNotMatch(rendered, /\x1b\[/);
});

test("banner suppresses when RIPTIDE_NO_BANNER is truthy", () => {
  assert.equal(
    shouldPrintBanner({ env: { RIPTIDE_NO_BANNER: "1" }, flags: {}, isTTY: true }),
    false
  );
});

test("rendered banner is compact and reads version from package.json", () => {
  const version = cliPackageVersion();
  assert.equal(version, "0.9.1");
  const rendered = renderBanner(version, false);
  assert.equal(rendered.split("\n").length, 5);
  assert.equal(rendered.endsWith("\n\n"), true);
  assert.match(rendered, /RIPTIDE/);
  assert.match(rendered, /Riptide v0\.9\.1/);
  assert.match(rendered, /Deterministic Solana simulation evidence\./);
});

test("printBanner writes exactly once when allowed", () => {
  const writes: string[] = [];
  printBanner({
    env: {},
    flags: {},
    isTTY: true,
    version: "0.7.0",
    stdoutWrite: (chunk) => writes.push(chunk)
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /RIPTIDE/);
});

test("init banner renders ASCII wordmark with tagline", () => {
  const rendered = renderInitBanner("0.7.0", false);
  assert.doesNotMatch(rendered, /\x1b\[/);
  // Dotted ASCII wordmark + spacing + tagline expand past the stub form.
  assert.ok(rendered.split("\n").length >= 8);
  assert.match(rendered, /\.\.\.\.\.\.\./);
  assert.match(rendered, /Riptide v0\.7\.0/);
  assert.match(rendered, /Deterministic Solana simulation evidence\./);
  assert.equal(rendered.endsWith("\n\n"), true);
});

test("printInitBanner respects suppression flags", () => {
  const writesQuiet: string[] = [];
  printInitBanner({
    env: {},
    flags: { quiet: true },
    isTTY: true,
    version: "0.7.0",
    stdoutWrite: (chunk) => writesQuiet.push(chunk)
  });
  assert.equal(writesQuiet.length, 0);

  const writesAllowed: string[] = [];
  printInitBanner({
    env: {},
    flags: {},
    isTTY: true,
    version: "0.7.0",
    stdoutWrite: (chunk) => writesAllowed.push(chunk)
  });
  assert.equal(writesAllowed.length, 1);
  assert.match(writesAllowed[0]!, /\.\.\.\.\.\.\./);
});
