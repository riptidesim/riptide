import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ReviewManifest, ValidationResult } from "./manifest.js";
import { ReviewValidationError } from "./manifest.js";

export interface HashVerification {
  expected: string;
  observed: string;
  rawSha256: string;
  ok: boolean;
  file: string;
}

export async function verifyCanonicalHash(
  manifest: ReviewManifest,
  simulationResultPath: string,
  validationResults: ValidationResult[]
): Promise<{ result: Record<string, unknown>; verification: HashVerification }> {
  const raw = await readFile(simulationResultPath);
  const rawSha256 = sha256(raw);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new ReviewValidationError(
      `malformed simulation-result.json\n  path: ${simulationResultPath}\n  parse error: ${errorMessage(error)}\n  next: restore the pack output before review`
    );
  }

  const observed = canonicalSimulationResultHash(raw.toString("utf8"));
  const expected = manifest.canonical_hash ?? "";
  const verification: HashVerification = {
    expected,
    observed,
    rawSha256,
    ok: expected === observed,
    file: simulationResultPath,
  };

  if (!verification.ok) {
    throw new ReviewValidationError(
      `canonical hash mismatch\n  file: ${simulationResultPath}\n  expected: ${expected}\n  observed: ${observed}\n  raw_sha256: ${rawSha256}\n  next: rerun the pack from a clean checkout or investigate intentional drift before updating the pin`
    );
  }

  validationResults.push({
    step: "canonical-hash",
    status: "pass",
    message: `canonical hash verified (${observed})`,
    path: simulationResultPath,
  });

  return { result: parsed, verification };
}

export function canonicalSimulationResultHash(raw: string): string {
  const numberFormats = collectNumberFormats(raw);
  const result = JSON.parse(raw) as Record<string, unknown>;
  const canonical = deepClone(result);
  const runConfig = canonical["run_config"];
  if (runConfig && typeof runConfig === "object" && !Array.isArray(runConfig)) {
    (runConfig as Record<string, unknown>)["output_path"] = "__canonical__";
  }
  delete canonical["semantics"];
  const summary = canonical["summary"];
  if (summary && typeof summary === "object" && !Array.isArray(summary)) {
    delete (summary as Record<string, unknown>)["expression_invariants"];
  }
  const timeseries = canonical["timeseries"];
  if (Array.isArray(timeseries)) {
    for (const tick of timeseries) {
      if (tick && typeof tick === "object" && !Array.isArray(tick)) {
        delete (tick as Record<string, unknown>)["derived_observations"];
      }
    }
  }
  return sha256(Buffer.from(serdeLikeStringify(canonical, "", [], numberFormats), "utf8"));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const FLOAT_KEYS = new Set([
  "oracle_price",
  "tvl",
  "utilization",
  "cumulative_bad_debt",
  "final_balance",
  "pnl",
  "expected",
  "observed",
  "value",
  "final_tvl",
  "final_utilization",
  "largest_single_tick_drawdown",
  "total_bad_debt",
]);

function serdeLikeStringify(
  value: unknown,
  key = "",
  jsonPath: string[] = [],
  numberFormats: Map<string, string> = new Map()
): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => serdeLikeStringify(entry, "", [...jsonPath, String(index)], numberFormats)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .map((entryKey) => `${JSON.stringify(entryKey)}:${serdeLikeStringify((value as Record<string, unknown>)[entryKey], entryKey, [...jsonPath, entryKey], numberFormats)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ReviewValidationError("simulation-result.json contains a non-finite number");
    }
    const original = numberFormats.get(pathKey(jsonPath));
    if (Number.isInteger(value) && (FLOAT_KEYS.has(key) || tokenWasFloat(original))) {
      return value.toFixed(1);
    }
    return String(value);
  }
  throw new ReviewValidationError(`simulation-result.json contains unsupported JSON value (${typeof value})`);
}

function tokenWasFloat(token: string | undefined): boolean {
  return token !== undefined && /[.eE]/.test(token);
}

function collectNumberFormats(raw: string): Map<string, string> {
  return new JsonNumberScanner(raw).scan();
}

function pathKey(jsonPath: string[]): string {
  return jsonPath.join("\u0000");
}

class JsonNumberScanner {
  private index = 0;
  private readonly formats = new Map<string, string>();

  constructor(private readonly raw: string) {}

  scan(): Map<string, string> {
    this.skipWhitespace();
    this.readValue([]);
    return this.formats;
  }

  private readValue(jsonPath: string[]): void {
    this.skipWhitespace();
    const char = this.raw[this.index];
    if (char === "{") return this.readObject(jsonPath);
    if (char === "[") return this.readArray(jsonPath);
    if (char === "\"") {
      this.readString();
      return;
    }
    if (char === "-" || isDigit(char)) {
      this.readNumber(jsonPath);
      return;
    }
    if (this.raw.startsWith("true", this.index)) {
      this.index += 4;
      return;
    }
    if (this.raw.startsWith("false", this.index)) {
      this.index += 5;
      return;
    }
    if (this.raw.startsWith("null", this.index)) {
      this.index += 4;
      return;
    }
    throw new ReviewValidationError("could not scan simulation-result.json numeric tokens");
  }

  private readObject(jsonPath: string[]): void {
    this.expect("{");
    this.skipWhitespace();
    if (this.raw[this.index] === "}") {
      this.index++;
      return;
    }
    while (this.index < this.raw.length) {
      const key = this.readString();
      this.expect(":");
      this.readValue([...jsonPath, key]);
      this.skipWhitespace();
      if (this.raw[this.index] === "}") {
        this.index++;
        return;
      }
      this.expect(",");
    }
  }

  private readArray(jsonPath: string[]): void {
    this.expect("[");
    this.skipWhitespace();
    if (this.raw[this.index] === "]") {
      this.index++;
      return;
    }
    let index = 0;
    while (this.index < this.raw.length) {
      this.readValue([...jsonPath, String(index)]);
      index++;
      this.skipWhitespace();
      if (this.raw[this.index] === "]") {
        this.index++;
        return;
      }
      this.expect(",");
    }
  }

  private readString(): string {
    this.expect("\"");
    let out = "";
    while (this.index < this.raw.length) {
      const char = this.raw[this.index++];
      if (char === "\"") return out;
      if (char !== "\\") {
        out += char;
        continue;
      }
      const escaped = this.raw[this.index++];
      if (escaped === "u") {
        out += String.fromCharCode(Number.parseInt(this.raw.slice(this.index, this.index + 4), 16));
        this.index += 4;
      } else {
        out += escaped;
      }
    }
    throw new ReviewValidationError("unterminated string while scanning simulation-result.json");
  }

  private readNumber(jsonPath: string[]): void {
    const start = this.index;
    if (this.raw[this.index] === "-") this.index++;
    while (isDigit(this.raw[this.index])) this.index++;
    if (this.raw[this.index] === ".") {
      this.index++;
      while (isDigit(this.raw[this.index])) this.index++;
    }
    if (this.raw[this.index] === "e" || this.raw[this.index] === "E") {
      this.index++;
      if (this.raw[this.index] === "+" || this.raw[this.index] === "-") this.index++;
      while (isDigit(this.raw[this.index])) this.index++;
    }
    this.formats.set(pathKey(jsonPath), this.raw.slice(start, this.index));
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.raw[this.index] ?? "")) this.index++;
  }

  private expect(expected: string): void {
    this.skipWhitespace();
    if (this.raw[this.index] !== expected) {
      throw new ReviewValidationError(`expected ${expected} while scanning simulation-result.json`);
    }
    this.index++;
    this.skipWhitespace();
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
