#!/usr/bin/env node
// @riptide/cli — postinstall binary downloader.
//
// Fetches the riptide-engine native binary for the user's platform from
// GitHub Releases and drops it at <package-root>/bin/riptide-engine with
// exec permissions. Verifies sha256 against a shipped per-target
// checksum manifest.
//
// Pattern: esbuild / @swc/core.
//
// Supported platforms:
// - linux x64 (x86_64-unknown-linux-gnu) — shipping
// Optional /
// - darwin x64 (x86_64-apple-darwin)
// - darwin arm64 (aarch64-apple-darwin)
// - win32 x64 (x86_64-pc-windows-msvc)

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, chmodSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const PKG_JSON = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const VERSION = PKG_JSON.version;
const START_MS = Date.now();

// Release base URL. Default points at the public GitHub repo. The env
// var lets us retarget at a pre-release mirror, a private org, or a
// local file:// URL for testing before a release is cut.
//
// Pre-publish era: the current GitHub Release has NOT been cut yet — it
// ships in the first public distribution pass. Running this script
// against the default URL during the pre-publish window 404s; the error
// path below guides the user at the build-from-source flow.
const DEFAULT_BASE = `https://github.com/riptidesim/riptide/releases/download/v${VERSION}`;
const BASE_URL = process.env.RIPTIDE_RELEASE_BASE_URL || DEFAULT_BASE;

// Target-triple map. Add entries as platforms get built in CI.
const TARGET_TRIPLES = {
  'linux-x64':   'x86_64-unknown-linux-gnu',
  // 'darwin-x64': 'x86_64-apple-darwin', //
  // 'darwin-arm64':'aarch64-apple-darwin', //
  // 'win32-x64': 'x86_64-pc-windows-msvc', //
};

// Per-target sha256. Edit this table at release-cut time by running
// sha256sum target/<triple>/release/riptide-engine
// and pasting the hex here. The postinstall verifies the download
// against these values and aborts on mismatch.
//
// Setting CHECKSUMS[key] = null explicitly skips verification — used
// only when RIPTIDE_RELEASE_BASE_URL points at a non-release URL for
// local testing.
const CHECKSUMS = {
  'x86_64-unknown-linux-gnu': '93231ddee0185841e0b6bfac27bc23be37b96dd2cd5590464ab7c8908bd50b19',
};

// ---------- cosmetic helpers ----------
// npm typically buffers postinstall output, so most users never see
// these lines. They surface with `npm install --foreground-scripts`,
// when this script is run directly, or on failure. We still want them
// on-brand when shown.
const STYLE_ON =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  !process.env.RIPTIDE_NO_BANNER &&
  !process.env.CI;

const STYLE = STYLE_ON
  ? {
      bold:  (s) => `\x1b[1m${s}\x1b[0m`,
      dim:   (s) => `\x1b[2m${s}\x1b[0m`,
      red:   (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow:(s) => `\x1b[33m${s}\x1b[0m`,
      cyan:  (s) => `\x1b[38;2;83;213;209m${s}\x1b[0m`,
    }
  : {
      bold:  (s) => s,
      dim:   (s) => s,
      red:   (s) => s,
      green: (s) => s,
      yellow:(s) => s,
      cyan:  (s) => s,
    };

function printBanner() {
  if (!STYLE_ON) return;
  const lines = [
    '.......   ...   ......    .......  ...   .......   .......',
    '..   ..   ...   ..   ..     ..     ...   ..   ...  ...    ',
    '.......   ...   ..  ...     ..     ...   ..   ...  .......',
    '..  ..    ...   ..          ..     ...   ..   ...  ...    ',
    '..   ..   ...   ..          ..     ...   .......   .......',
  ];
  process.stdout.write('\n');
  for (const line of lines) {
    process.stdout.write(`  ${STYLE.cyan(line)}\n`);
  }
  process.stdout.write(`\n  ${STYLE.dim('Riptide engine · postinstall')}\n\n`);
}

function step(msg) { process.stdout.write(`\n${STYLE.cyan('→')} ${STYLE.bold(msg)}\n`); }
function ok(msg)   { process.stdout.write(`  ${STYLE.green('✓')} ${msg}\n`); }
function info(msg) { process.stdout.write(`  ${STYLE.dim('·')} ${STYLE.dim(msg)}\n`); }

function fail(msg) {
  process.stderr.write(`\n  ${STYLE.red('✗')} ${STYLE.bold(STYLE.red('riptide postinstall:'))} ${msg}\n`);
  process.exit(1);
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function platformKey() {
  const p = process.platform;
  const a = process.arch;
  return `${p}-${a}`;
}

function binaryName(triple) {
  return triple.includes('windows') ? 'riptide-engine.exe' : 'riptide-engine';
}

// Follow-redirects fetch. node:https / node:http give us no-dep
// predictability and work in the postinstall context where network
// access is allowed but adding a dependency would bloat the package.
// Production traffic is https-only; http support is here so the local
// smoke-test harness and RIPTIDE_RELEASE_BASE_URL overrides pointed
// at a local server work without extra tooling.
function requestFor(url) {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return httpsRequest;
  if (parsed.protocol === 'http:') return httpRequest;
  throw new Error(`unsupported protocol "${parsed.protocol}" in ${url}`);
}

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((ok, ko) => {
    let request;
    try { request = requestFor(url); } catch (e) { return ko(e); }
    const req = request(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return ko(new Error(`too many redirects from ${url}`));
        res.resume();
        return ok(download(res.headers.location, destPath, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return ko(new Error(`GET ${url} → ${res.statusCode}`));
      }
      const file = createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => ok()));
      file.on('error', ko);
    });
    req.on('error', ko);
    req.end();
  });
}

function sha256OfFile(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

async function main() {
  printBanner();

  const key = platformKey();
  const triple = TARGET_TRIPLES[key];
  if (!triple) {
    fail(
      `no prebuilt riptide-engine binary for platform "${key}". ` +
      `Supported: ${Object.keys(TARGET_TRIPLES).join(', ')}. ` +
      `Build from source: clone https://github.com/riptidesim/riptide and run ./install.sh, ` +
      `or build the repo's Dockerfile locally (docker build -t riptide .). ` +
      `Track platform support at https://github.com/riptidesim/riptide/issues.`
    );
  }

  const binName = binaryName(triple);
  const url = `${BASE_URL}/riptide-engine-${triple}`;
  const destDir = join(PKG_ROOT, 'bin');
  const destPath = join(destDir, binName);

  if (existsSync(destPath)) {
    // Idempotent — let repeat installs be no-ops.
    info(`engine already present at ${destPath}, skipping download`);
    return;
  }

  mkdirSync(destDir, { recursive: true });

  step(`fetching engine for ${triple}`);
  info(url);
  try {
    await download(url, destPath);
  } catch (e) {
    // Clean partial file so a retry starts fresh.
    if (existsSync(destPath)) { try { unlinkSync(destPath); } catch {} }
    fail(
      `failed to download ${url}: ${e.message}. ` +
      `The v${VERSION} release may not be cut yet — during the pre-publish window, ` +
      `build from source: clone https://github.com/riptidesim/riptide and run ./install.sh. ` +
      `For pre-release mirrors, set RIPTIDE_RELEASE_BASE_URL to an alternate endpoint.`
    );
  }
  let sizeText = '';
  try { sizeText = humanSize(statSync(destPath).size); } catch {}
  ok(sizeText ? `downloaded (${sizeText})` : 'downloaded');

  const expected = CHECKSUMS[triple];
  if (expected === undefined) {
    fail(`no sha256 recorded for ${triple} in install-binary.js — refusing to install unverified binary`);
  }
  step('verifying sha256');
  if (expected !== null) {
    const actual = sha256OfFile(destPath);
    if (actual !== expected) {
      try { unlinkSync(destPath); } catch {}
      fail(`sha256 mismatch for ${triple}: expected ${expected}, got ${actual}`);
    }
    ok(`checksum matches (${actual.slice(0, 12)}…)`);
  } else {
    info(`sha256 verification skipped (CHECKSUMS[${triple}] = null)`);
  }

  if (!triple.includes('windows')) {
    chmodSync(destPath, 0o755);
  }

  ok(`engine installed at ${destPath}`);

  if (STYLE_ON) {
    const elapsed = Math.max(0, Math.round((Date.now() - START_MS) / 1000));
    process.stdout.write(
      `\n  ${STYLE.green('✓')} ${STYLE.bold('Riptide engine ready')} ${STYLE.dim(`(${elapsed}s)`)}\n`
    );
    process.stdout.write(`  ${STYLE.dim('next:')} ${STYLE.cyan('riptide doctor')} ${STYLE.dim('then')} ${STYLE.cyan('riptide init')} ${STYLE.dim('in your program directory')}\n\n`);
  }
}

main().catch((e) => fail(e.stack || e.message));
