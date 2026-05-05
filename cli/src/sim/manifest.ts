import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import TOML from "toml";

export type SimManifestLevel = "pass" | "warn" | "fail";

export interface SimManifestFinding {
  level: SimManifestLevel;
  code: string;
  path: string;
  message: string;
  hint?: string;
}

export interface SimManifestLintReport {
  manifestPath: string;
  findings: SimManifestFinding[];
  exitCode: number;
}

interface EntryAddress {
  kind: "program" | "account" | "fork";
  path: string;
  address: string;
  key: string;
}

const TOP_LEVEL_KEYS = new Set(["sim"]);
const SIM_KEYS = new Set(["programs", "accounts", "fork", "metrics", "regression", "coverage"]);
const PROGRAM_KEYS = new Set(["address", "program", "loader"]);
const ACCOUNT_KEYS = new Set(["address", "filename"]);
const FORK_KEYS = new Set(["address", "cluster", "filename", "overwrite"]);
const METRICS_KEYS = new Set(["enabled", "filename"]);
const REGRESSION_KEYS = new Set(["enabled", "accounts", "state_hashes"]);
const COVERAGE_KEYS = new Set(["enabled"]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export async function lintSimManifest(targetPath: string, cwd = process.cwd()): Promise<SimManifestLintReport> {
  const manifestPath = resolveManifestPath(targetPath, cwd);
  const findings: SimManifestFinding[] = [];

  if (!existsSync(manifestPath)) {
    findings.push({
      level: "fail",
      code: "manifest-missing",
      path: "Riptide.toml",
      message: `sim manifest not found at ${manifestPath}`,
      hint: "Pass a simulation directory containing Riptide.toml or an explicit manifest path."
    });
    return report(manifestPath, findings);
  }

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    findings.push({
      level: "fail",
      code: "manifest-read-failed",
      path: "Riptide.toml",
      message: `could not read sim manifest: ${errMessage(err)}`
    });
    return report(manifestPath, findings);
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    findings.push({
      level: "fail",
      code: "manifest-parse-failed",
      path: "Riptide.toml",
      message: `could not parse sim manifest: ${errMessage(err)}`
    });
    return report(manifestPath, findings);
  }

  validateManifestObject(parsed, manifestPath, findings);
  if (!findings.some((finding) => finding.level === "fail")) {
    findings.push({
      level: "pass",
      code: "manifest-schema",
      path: "sim",
      message: "Riptide.toml parsed and all declared bootstrap inputs are statically valid"
    });
  }
  return report(manifestPath, findings);
}

export function renderSimManifestLintReport(report: SimManifestLintReport): string {
  const lines: string[] = [];
  lines.push(`Sim manifest lint - ${report.manifestPath}`);
  lines.push("");
  lines.push("Findings");

  for (const finding of report.findings) {
    lines.push(`  ${finding.level.toUpperCase()} [${finding.code}] ${finding.path}`);
    lines.push(`      ${finding.message}`);
    if (finding.hint) lines.push(`      hint: ${finding.hint}`);
  }

  const counts = countFindings(report.findings);
  lines.push("");
  lines.push("Summary");
  lines.push(`  PASS:${counts.pass}  WARN:${counts.warn}  FAIL:${counts.fail}`);
  lines.push(`  Verdict: ${verdict(report.exitCode)} (exit ${report.exitCode})`);
  lines.push("");
  lines.push("Static validation only: no build, no RPC fetch, no simulation.");
  lines.push("");
  return lines.join("\n");
}

function validateManifestObject(
  parsed: unknown,
  manifestPath: string,
  findings: SimManifestFinding[]
): void {
  if (!isRecord(parsed)) {
    findings.push({
      level: "fail",
      code: "manifest-shape",
      path: "Riptide.toml",
      message: "manifest root must be a TOML table"
    });
    return;
  }

  rejectUnknownKeys(parsed, TOP_LEVEL_KEYS, "Riptide.toml", findings);

  const sim = parsed["sim"];
  if (sim === undefined) {
    return;
  }
  if (!isRecord(sim)) {
    findings.push({
      level: "fail",
      code: "sim-shape",
      path: "sim",
      message: "sim must be a TOML table"
    });
    return;
  }

  rejectUnknownKeys(sim, SIM_KEYS, "sim", findings);
  const baseDir = path.dirname(manifestPath);
  const addresses: EntryAddress[] = [];

  validatePrograms(sim["programs"], baseDir, findings, addresses);
  validateAccounts(sim["accounts"], baseDir, findings, addresses);
  validateFork(sim["fork"], baseDir, findings, addresses);
  validateMetrics(sim["metrics"], findings);
  validateRegression(sim["regression"], findings);
  validateCoverage(sim["coverage"], findings);
  validateDuplicateBootstrapAddresses(addresses, findings);
}

function validatePrograms(
  value: unknown,
  baseDir: string,
  findings: SimManifestFinding[],
  addresses: EntryAddress[]
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    findings.push({
      level: "fail",
      code: "programs-shape",
      path: "sim.programs",
      message: "sim.programs must be declared with [[sim.programs]] array-of-table entries"
    });
    return;
  }

  value.forEach((entry, index) => {
    const entryPath = `sim.programs[${index}]`;
    if (!isRecord(entry)) {
      findings.push({
        level: "fail",
        code: "program-shape",
        path: entryPath,
        message: "program entry must be a TOML table"
      });
      return;
    }
    rejectUnknownKeys(entry, PROGRAM_KEYS, entryPath, findings);

    const program = stringField(entry, "program", `${entryPath}.program`, findings);
    const address = optionalStringField(entry, "address", `${entryPath}.address`, findings);
    const loader = optionalStringField(entry, "loader", `${entryPath}.loader`, findings);

    if (loader !== undefined && loader !== "direct") {
      findings.push({
        level: "fail",
        code: "unsupported-loader",
        path: `${entryPath}.loader`,
        message: `unsupported loader declaration ${JSON.stringify(loader)}; guided sims currently load only direct local .so programs`,
        hint: "Use loader = \"direct\" or omit loader. Forked upgradeable loader program pairs are a separate guarded path."
      });
    }

    if (address !== undefined) {
      const key = validatePubkey(address, `${entryPath}.address`, findings);
      if (key) addresses.push({ kind: "program", path: `${entryPath}.address`, address, key });
    }

    if (program !== undefined) {
      const programPath = resolveRelative(baseDir, program);
      if (!existsSync(programPath)) {
        findings.push({
          level: "fail",
          code: "program-file-missing",
          path: `${entryPath}.program`,
          message: `program file does not exist: ${programPath}`,
          hint: "Build the dependency program or fix the path relative to Riptide.toml."
        });
      }
    }
  });
}

function validateAccounts(
  value: unknown,
  baseDir: string,
  findings: SimManifestFinding[],
  addresses: EntryAddress[]
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    findings.push({
      level: "fail",
      code: "accounts-shape",
      path: "sim.accounts",
      message: "sim.accounts must be declared with [[sim.accounts]] array-of-table entries"
    });
    return;
  }

  value.forEach((entry, index) => {
    const entryPath = `sim.accounts[${index}]`;
    if (!isRecord(entry)) {
      findings.push({
        level: "fail",
        code: "account-shape",
        path: entryPath,
        message: "account entry must be a TOML table"
      });
      return;
    }
    rejectUnknownKeys(entry, ACCOUNT_KEYS, entryPath, findings);

    const address = stringField(entry, "address", `${entryPath}.address`, findings);
    const filename = stringField(entry, "filename", `${entryPath}.filename`, findings);
    const key = address ? validatePubkey(address, `${entryPath}.address`, findings) : null;
    if (address && key) addresses.push({ kind: "account", path: `${entryPath}.address`, address, key });

    if (filename !== undefined) {
      const accountPath = resolveRelative(baseDir, filename);
      validateAccountSnapshotFile(accountPath, address, `${entryPath}.filename`, findings);
    }
  });
}

function validateFork(
  value: unknown,
  baseDir: string,
  findings: SimManifestFinding[],
  addresses: EntryAddress[]
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    findings.push({
      level: "fail",
      code: "fork-shape",
      path: "sim.fork",
      message: "sim.fork must be declared with [[sim.fork]] array-of-table entries"
    });
    return;
  }

  value.forEach((entry, index) => {
    const entryPath = `sim.fork[${index}]`;
    if (!isRecord(entry)) {
      findings.push({
        level: "fail",
        code: "fork-entry-shape",
        path: entryPath,
        message: "fork entry must be a TOML table"
      });
      return;
    }
    rejectUnknownKeys(entry, FORK_KEYS, entryPath, findings);

    const address = stringField(entry, "address", `${entryPath}.address`, findings);
    const cluster = optionalStringField(entry, "cluster", `${entryPath}.cluster`, findings) ?? "mainnet";
    const filename = optionalStringField(entry, "filename", `${entryPath}.filename`, findings);
    optionalBooleanField(entry, "overwrite", `${entryPath}.overwrite`, findings);

    const key = address ? validatePubkey(address, `${entryPath}.address`, findings) : null;
    if (address && key) addresses.push({ kind: "fork", path: `${entryPath}.address`, address, key });

    if (cluster.trim().length === 0) {
      findings.push({
        level: "fail",
        code: "fork-cluster-empty",
        path: `${entryPath}.cluster`,
        message: "fork cluster must be a named cluster alias or custom RPC URL"
      });
    }

    if (filename !== undefined) {
      const cachePath = resolveRelative(baseDir, filename);
      if (existsSync(cachePath)) {
        validateAccountSnapshotFile(cachePath, address, `${entryPath}.filename`, findings);
      } else {
        findings.push({
          level: "warn",
          code: "fork-cache-missing",
          path: `${entryPath}.filename`,
          message: `fork cache file does not exist yet: ${cachePath}`,
          hint: "The first run may fetch it from RPC. For offline deterministic runs, create or commit the cache before running."
        });
      }
    }
  });
}

function validateMetrics(value: unknown, findings: SimManifestFinding[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    findings.push({
      level: "fail",
      code: "metrics-shape",
      path: "sim.metrics",
      message: "sim.metrics must be a TOML table"
    });
    return;
  }
  rejectUnknownKeys(value, METRICS_KEYS, "sim.metrics", findings);
  const enabled = optionalBooleanField(value, "enabled", "sim.metrics.enabled", findings) ?? false;
  const filename = optionalStringField(value, "filename", "sim.metrics.filename", findings);
  if (enabled && filename === undefined) {
    findings.push({
      level: "warn",
      code: "metrics-default-output",
      path: "sim.metrics.enabled",
      message: "guided-sim metrics are enabled without a manifest filename",
      hint: "Use `riptide sim run --out <dir>` or declare metrics.filename for a stable artifact location."
    });
  }
}

function validateRegression(value: unknown, findings: SimManifestFinding[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    findings.push({
      level: "fail",
      code: "regression-shape",
      path: "sim.regression",
      message: "sim.regression must be a TOML table"
    });
    return;
  }
  rejectUnknownKeys(value, REGRESSION_KEYS, "sim.regression", findings);
  const enabled =
    optionalBooleanField(value, "enabled", "sim.regression.enabled", findings) ?? false;
  validateStringArray(value["state_hashes"], "sim.regression.state_hashes", findings);
  const accounts = validateStringArray(value["accounts"], "sim.regression.accounts", findings);
  if (accounts) {
    const seen = new Map<string, number>();
    accounts.forEach((account, index) => {
      const key = validatePubkey(account, `sim.regression.accounts[${index}]`, findings);
      if (!key) return;
      const first = seen.get(key);
      if (first !== undefined) {
        findings.push({
          level: "fail",
          code: "duplicate-regression-account",
          path: `sim.regression.accounts[${index}]`,
          message: `duplicate regression account also appears at sim.regression.accounts[${first}]`
        });
      } else {
        seen.set(key, index);
      }
    });
  }
  if (enabled) {
    if (!accounts || accounts.length === 0) {
      findings.push({
        level: "warn",
        code: "regression-no-accounts",
        path: "sim.regression.accounts",
        message: "regression hashing is enabled but no accounts are selected",
        hint: "Add account pubkeys to sim.regression.accounts to emit stable account hashes."
      });
    }
  }
}

function validateCoverage(value: unknown, findings: SimManifestFinding[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    findings.push({
      level: "fail",
      code: "coverage-shape",
      path: "sim.coverage",
      message: "sim.coverage must be a TOML table"
    });
    return;
  }
  rejectUnknownKeys(value, COVERAGE_KEYS, "sim.coverage", findings);
  const enabled = optionalBooleanField(value, "enabled", "sim.coverage.enabled", findings) ?? false;
  if (enabled) {
    findings.push({
      level: "fail",
      code: "coverage-unavailable",
      path: "sim.coverage.enabled",
      message: "guided-sim coverage is declared but not implemented yet",
      hint: "Leave coverage.enabled = false until a guided run emits coverage output."
    });
  }
}

function validateDuplicateBootstrapAddresses(
  addresses: EntryAddress[],
  findings: SimManifestFinding[]
): void {
  const seen = new Map<string, EntryAddress>();
  for (const address of addresses) {
    const first = seen.get(address.key);
    if (!first) {
      seen.set(address.key, address);
      continue;
    }
    findings.push({
      level: "fail",
      code: "duplicate-address",
      path: address.path,
      message: `${address.kind} address duplicates ${first.kind} address at ${first.path}: ${address.address}`,
      hint: "Each bootstrapped program, local account, and forked account must use a distinct address."
    });
  }
}

function validateAccountSnapshotFile(
  accountPath: string,
  expectedAddress: string | undefined,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): void {
  if (!existsSync(accountPath)) {
    findings.push({
      level: "fail",
      code: "account-file-missing",
      path: diagnosticPath,
      message: `account snapshot file does not exist: ${accountPath}`,
      hint: "Fix the path relative to Riptide.toml or create the base64 account snapshot."
    });
    return;
  }

  let raw: string;
  try {
    raw = statSync(accountPath).isFile() ? readFileSync(accountPath, "utf8") : "";
  } catch (err) {
    findings.push({
      level: "fail",
      code: "account-file-read-failed",
      path: diagnosticPath,
      message: `could not read account snapshot: ${errMessage(err)}`
    });
    return;
  }

  if (raw.length === 0 && !statSync(accountPath).isFile()) {
    findings.push({
      level: "fail",
      code: "account-file-not-file",
      path: diagnosticPath,
      message: `account snapshot path is not a file: ${accountPath}`
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    findings.push({
      level: "fail",
      code: "account-json-invalid",
      path: diagnosticPath,
      message: `account snapshot JSON is invalid: ${errMessage(err)}`
    });
    return;
  }

  validateAccountSnapshot(parsed, expectedAddress, diagnosticPath, findings);
}

function validateAccountSnapshot(
  parsed: unknown,
  expectedAddress: string | undefined,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): void {
  if (!isRecord(parsed)) {
    findings.push({
      level: "fail",
      code: "account-json-shape",
      path: diagnosticPath,
      message: "account snapshot JSON must be an object"
    });
    return;
  }

  const declaredPubkey = parsed["pubkey"];
  if (declaredPubkey !== undefined) {
    if (typeof declaredPubkey !== "string") {
      findings.push({
        level: "fail",
        code: "account-pubkey-shape",
        path: `${diagnosticPath}.pubkey`,
        message: "snapshot pubkey must be a string"
      });
    } else {
      const declaredKey = validatePubkey(declaredPubkey, `${diagnosticPath}.pubkey`, findings);
      const expectedKey = expectedAddress ? decodePubkeyKey(expectedAddress) : null;
      if (declaredKey && expectedKey && declaredKey !== expectedKey) {
        findings.push({
          level: "fail",
          code: "cache-pubkey-mismatch",
          path: diagnosticPath,
          message: `account snapshot pubkey ${declaredPubkey} does not match manifest address ${expectedAddress}`
        });
      }
    }
  }

  const account = accountValue(parsed);
  if (!isRecord(account)) {
    findings.push({
      level: "fail",
      code: "account-value-missing",
      path: diagnosticPath,
      message: "account snapshot must contain account data at account, result.value, or the root object"
    });
    return;
  }

  validateAccountValue(account, diagnosticPath, findings);
}

function validateAccountValue(
  account: Record<string, unknown>,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): void {
  if (!isNonNegativeInteger(account["lamports"])) {
    findings.push({
      level: "fail",
      code: "account-lamports-invalid",
      path: `${diagnosticPath}.lamports`,
      message: "account snapshot is missing numeric lamports"
    });
  }

  if (typeof account["owner"] !== "string") {
    findings.push({
      level: "fail",
      code: "account-owner-missing",
      path: `${diagnosticPath}.owner`,
      message: "account snapshot is missing string owner"
    });
  } else {
    validatePubkey(account["owner"], `${diagnosticPath}.owner`, findings);
  }

  const data = account["data"];
  if (data === undefined) {
    findings.push({
      level: "fail",
      code: "account-data-missing",
      path: `${diagnosticPath}.data`,
      message: "account snapshot is missing data"
    });
  } else {
    validateAccountData(data, `${diagnosticPath}.data`, findings);
  }
}

function validateAccountData(
  data: unknown,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): void {
  if (typeof data === "string") {
    validateBase64(data, diagnosticPath, findings);
    return;
  }

  if (Array.isArray(data)) {
    const base64 = data[0];
    if (typeof base64 !== "string") {
      findings.push({
        level: "fail",
        code: "account-data-array",
        path: diagnosticPath,
        message: "account data array must start with a base64 string"
      });
      return;
    }
    const encoding = typeof data[1] === "string" ? data[1].toLowerCase() : "base64";
    if (encoding !== "base64") {
      findings.push({
        level: "fail",
        code: "account-data-encoding",
        path: diagnosticPath,
        message: `unsupported account data encoding ${JSON.stringify(encoding)}; use base64 snapshots`
      });
      return;
    }
    validateBase64(base64, diagnosticPath, findings);
    return;
  }

  findings.push({
    level: "fail",
    code: "account-data-shape",
    path: diagnosticPath,
    message: "account data must be a base64 string or [base64, \"base64\"] array"
  });
}

function validateBase64(
  value: string,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): void {
  if (!isStrictBase64(value)) {
    findings.push({
      level: "fail",
      code: "account-data-base64",
      path: diagnosticPath,
      message: "account data is not valid standard base64"
    });
  }
}

function accountValue(parsed: Record<string, unknown>): unknown {
  if (isRecord(parsed["account"])) return parsed["account"];
  const result = parsed["result"];
  if (isRecord(result)) {
    const value = result["value"];
    if (value === null) return undefined;
    if (isRecord(value)) return value;
  }
  return parsed;
}

function stringField(
  entry: Record<string, unknown>,
  key: string,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): string | undefined {
  const value = entry[key];
  if (typeof value === "string" && value.length > 0) return value;
  findings.push({
    level: "fail",
    code: "field-required",
    path: diagnosticPath,
    message: `${diagnosticPath} must be a non-empty string`
  });
  return undefined;
}

function optionalStringField(
  entry: Record<string, unknown>,
  key: string,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  findings.push({
    level: "fail",
    code: "field-type",
    path: diagnosticPath,
    message: `${diagnosticPath} must be a string`
  });
  return undefined;
}

function optionalBooleanField(
  entry: Record<string, unknown>,
  key: string,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): boolean | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  findings.push({
    level: "fail",
    code: "field-type",
    path: diagnosticPath,
    message: `${diagnosticPath} must be a boolean`
  });
  return undefined;
}

function validateStringArray(
  value: unknown,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    findings.push({
      level: "fail",
      code: "field-type",
      path: diagnosticPath,
      message: `${diagnosticPath} must be an array of strings`
    });
    return undefined;
  }
  const strings: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry === "string") {
      strings.push(entry);
      return;
    }
    findings.push({
      level: "fail",
      code: "field-type",
      path: `${diagnosticPath}[${index}]`,
      message: `${diagnosticPath}[${index}] must be a string`
    });
  });
  return strings;
}

function validatePubkey(
  value: string,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): string | null {
  const key = decodePubkeyKey(value);
  if (key) return key;
  findings.push({
    level: "fail",
    code: "invalid-pubkey",
    path: diagnosticPath,
    message: `invalid Solana pubkey ${JSON.stringify(value)}`
  });
  return null;
}

function decodePubkeyKey(value: string): string | null {
  const bytes = decodeBase58(value);
  if (!bytes || bytes.length !== 32) return null;
  return Buffer.from(bytes).toString("hex");
}

function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) return null;
  if (/^1+$/.test(value)) return new Uint8Array(value.length);
  const bytes = [0];
  let leadingZeros = 0;
  while (value[leadingZeros] === "1") leadingZeros += 1;
  for (const ch of value) {
    const index = BASE58_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) {
      const next = bytes[i] * 58 + carry;
      bytes[i] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < leadingZeros; i += 1) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try {
    Buffer.from(value, "base64");
    return true;
  } catch {
    return false;
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  diagnosticPath: string,
  findings: SimManifestFinding[]
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    findings.push({
      level: "fail",
      code: "unknown-key",
      path: diagnosticPath === "Riptide.toml" ? key : `${diagnosticPath}.${key}`,
      message: `unknown key ${JSON.stringify(key)} in ${diagnosticPath}`
    });
  }
}

function resolveManifestPath(targetPath: string, cwd: string): string {
  const absolute = path.resolve(cwd, targetPath);
  if (existsSync(absolute)) {
    try {
      if (statSync(absolute).isDirectory()) return path.join(absolute, "Riptide.toml");
    } catch {
      return absolute;
    }
  }
  if (path.basename(absolute) !== "Riptide.toml" && !path.extname(absolute)) {
    return path.join(absolute, "Riptide.toml");
  }
  return absolute;
}

function resolveRelative(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function report(manifestPath: string, findings: SimManifestFinding[]): SimManifestLintReport {
  const fail = findings.some((finding) => finding.level === "fail");
  const warn = findings.some((finding) => finding.level === "warn");
  return { manifestPath, findings, exitCode: fail ? 2 : warn ? 1 : 0 };
}

function countFindings(findings: SimManifestFinding[]): Record<SimManifestLevel, number> {
  return {
    pass: findings.filter((finding) => finding.level === "pass").length,
    warn: findings.filter((finding) => finding.level === "warn").length,
    fail: findings.filter((finding) => finding.level === "fail").length
  };
}

function verdict(exitCode: number): string {
  if (exitCode === 0) return "PASS";
  if (exitCode === 1) return "WARN";
  return "FAIL";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
