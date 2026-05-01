// Static adapter linter.
//
// Reads an adapter's `[lineage].idl_source`, classifies the source
// kind, and — when the source is a JSON IDL — cross-checks the
// adapter's mapped instructions / args / accounts / `account.field`
// references against the IDL's declared surface.
//
// Honesty rules baked into this module:
// - JSON IDL is the only machine-checkable source kind today.
// - Rust-source `idl_source` (e.g. `programs/lending_pool/src/state.rs`)
//   is warn-only. Do NOT attempt to parse Rust in Sprint 13.
// - Missing `[lineage]` block is an explicit `SKIP`, not a PASS.
// - Uncovered source surfaces may warn. Never silently claim full
//   coverage.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Adapter, AdapterLineage, AccountOwner } from "../schemas/adapter.js";
import { lintSemantics } from "./semantics.js";
import { lintSemanticsBreadth } from "./semantics_breadth.js";

export type LintLevel = "pass" | "warn" | "fail" | "skip";

export interface LintFinding {
  level: LintLevel;
  code: string;
  subject: string;
  message: string;
  hint?: string;
}

export type LintSourceKind = "json-idl" | "non-json" | "missing-lineage";

export interface LintReport {
  adapterPath: string;
  adapterName: string;
  sourceKind: LintSourceKind;
  /** Absolute path to the resolved IDL (JSON-IDL case) or to the non-JSON source, when one could be located. */
  resolvedSourcePath?: string;
  findings: LintFinding[];
  coverage?: CoverageReport;
  /**
   * Exit code semantics:
   *   0 — no failures, and at most one SKIP finding (nothing to machine-check).
   *   1 — at least one WARN (uncovered, unrecognized, or non-JSON) but no FAIL.
   *   2 — at least one FAIL.
   */
  exitCode: 0 | 1 | 2;
}

export interface CoverageReport {
  /** IDL instructions the adapter maps to an action. */
  mappedInstructions: string[];
  /** IDL instructions the adapter intentionally leaves unmapped but names in `unsupported_fields`. */
  recognizedUnsupportedInstructions: string[];
  /** IDL instructions the adapter neither maps nor names in `unsupported_fields`. */
  uncoveredInstructions: string[];
  /** Adapter account names that appear under `[accounts]` or in `state_mapping`. */
  mappedAccounts: string[];
  /** IDL account/field references the adapter exercises (from state_mapping, observations, invariants). */
  mappedFields: Array<{ account: string; field: string }>;
  /** IDL account fields neither mapped nor explicitly recognized as unsupported. */
  uncoveredFields: Array<{ account: string; field: string }>;
}

// ---------- JSON IDL shape ----------

interface IdlArg {
  name: string;
  type?: unknown;
}

interface IdlAccountSlot {
  name: string;
  signer?: boolean;
  writable?: boolean;
}

interface IdlInstruction {
  name: string;
  args: IdlArg[];
  accounts: IdlAccountSlot[];
}

interface IdlAccountField {
  name: string;
  type?: unknown;
}

interface IdlAccount {
  name: string;
  fields: IdlAccountField[];
}

interface JsonIdl {
  instructions: IdlInstruction[];
  accounts: IdlAccount[];
}

// ---------- public API ----------

/**
 * Classify an `[lineage].idl_source` value. Does NOT touch the file
 * system — used when a fast decision (JSON vs non-JSON vs absent) is
 * enough.
 */
export function classifyLineageSourceKind(lineage: AdapterLineage | undefined): LintSourceKind {
  if (lineage === undefined || lineage.idl_source === undefined) {
    return "missing-lineage";
  }
  const source = lineage.idl_source.trim();
  if (source.length === 0) {
    return "missing-lineage";
  }
  return source.toLowerCase().endsWith(".json") ? "json-idl" : "non-json";
}

export interface LintInput {
  adapter: Adapter;
  /** Absolute path to the adapter TOML; used for relative-path resolution + reporting. */
  adapterPath: string;
  adapterName: string;
  /** Root the adapter's `idl_source` is resolved against when the source path is not absolute. */
  repoRoot: string;
}

/**
 * Run the lint pipeline for one adapter. No spawning, no network; reads
 * the JSON IDL from disk when the source is machine-checkable.
 */
export async function lintAdapter(input: LintInput): Promise<LintReport> {
  const { adapter, adapterPath, adapterName, repoRoot } = input;
  const findings: LintFinding[] = [];
  const kind = classifyLineageSourceKind(adapter.lineage);
  findings.push(...lintSemantics(adapter));
  findings.push(...lintSemanticsBreadth(adapter));
  if (findings.some((finding) => finding.level === "fail")) {
    return {
      adapterPath,
      adapterName,
      sourceKind: kind,
      findings,
      exitCode: exitCodeFrom(findings),
    };
  }

  if (kind === "missing-lineage") {
    findings.push({
      level: "skip",
      code: "lineage-missing",
      subject: "[lineage]",
      message:
        "adapter has no [lineage] block — machine validation is unavailable, nothing to check.",
      hint: "Author a [lineage] block with `idl_source`, or run `riptide lineage <adapter>` to inspect the current state.",
    });
    return {
      adapterPath,
      adapterName,
      sourceKind: kind,
      findings,
      exitCode: exitCodeFrom(findings),
    };
  }

  const idlSource = adapter.lineage!.idl_source!;
  const resolvedSourcePath = resolveLineageSource(idlSource, adapterPath, repoRoot);

  if (kind === "non-json") {
    const hasSemantics = adapter.semantics !== undefined;
    findings.push({
      level: hasSemantics ? "skip" : "warn",
      code: "lineage-non-json",
      subject: `[lineage].idl_source = "${idlSource}"`,
      message: hasSemantics
        ? "lineage source is non-JSON and remains inspection-only; the adapter's [semantics] block was machine-checked by lint."
        : "machine validation is only available for JSON IDL sources; this source kind is inspection-only in Sprint 13.",
      hint: hasSemantics
        ? "Use `riptide lineage <adapter>` for reviewer-readable lineage inspection; semantics lint has already validated the economic preflight."
        : "Use `riptide lineage <adapter>` for reviewer-readable inspection of the authored lineage.",
    });
    return {
      adapterPath,
      adapterName,
      sourceKind: kind,
      resolvedSourcePath,
      findings,
      exitCode: exitCodeFrom(findings),
    };
  }

  // JSON IDL path.
  let raw: string;
  try {
    const stats = await stat(resolvedSourcePath);
    if (!stats.isFile()) {
      throw new Error("not a regular file");
    }
    raw = await readFile(resolvedSourcePath, "utf8");
  } catch (err) {
    findings.push({
      level: "fail",
      code: "idl-unreadable",
      subject: `[lineage].idl_source = "${idlSource}"`,
      message: `could not read JSON IDL at ${resolvedSourcePath}: ${errMessage(err)}`,
      hint: "Check the idl_source path in the adapter's [lineage] block and ensure the file is committed.",
    });
    return {
      adapterPath,
      adapterName,
      sourceKind: kind,
      resolvedSourcePath,
      findings,
      exitCode: exitCodeFrom(findings),
    };
  }

  let idl: JsonIdl;
  try {
    idl = parseJsonIdl(raw);
  } catch (err) {
    findings.push({
      level: "fail",
      code: "idl-parse-failed",
      subject: resolvedSourcePath,
      message: `failed to parse JSON IDL: ${errMessage(err)}`,
      hint: "The linter expects an Anchor-style JSON IDL with `instructions[].{name,args,accounts}` and `accounts[].{name,fields}`.",
    });
    return {
      adapterPath,
      adapterName,
      sourceKind: kind,
      resolvedSourcePath,
      findings,
      exitCode: exitCodeFrom(findings),
    };
  }

  const coverage = lintAdapterAgainstJsonIdl(adapter, adapterName, idl, findings);

  return {
    adapterPath,
    adapterName,
    sourceKind: kind,
    resolvedSourcePath,
    findings,
    coverage,
    exitCode: exitCodeFrom(findings),
  };
}

export function lintAdapterAgainstJsonIdl(
  adapter: Adapter,
  adapterName: string,
  idl: JsonIdl,
  findings: LintFinding[]
): CoverageReport {
  const idlInstructionsByName = new Map(idl.instructions.map((ix) => [ix.name, ix]));
  const idlAccountsByName = new Map(idl.accounts.map((a) => [a.name, a]));
  const logicalObservations = new Set(Object.values(adapter.state_mapping));

  // --- instruction + arg checks ---
  const mappedInstructions: string[] = [];
  for (const [ixName, mapping] of Object.entries(adapter.instructions)) {
    const idlIx = idlInstructionsByName.get(ixName);
    if (!idlIx) {
      findings.push({
        level: "fail",
        code: "instruction-not-in-idl",
        subject: `[instructions].${ixName}`,
        message: `adapter maps instruction \`${ixName}\` but the JSON IDL has no instruction with that name.`,
        hint: `Available instructions in the IDL: ${formatList(idl.instructions.map((i) => i.name))}.`,
      });
      continue;
    }
    mappedInstructions.push(ixName);

    const idlArgNames = new Set(idlIx.args.map((a) => a.name));
    if (mapping.amount !== undefined && !idlArgNames.has(mapping.amount)) {
      findings.push({
        level: "fail",
        code: "instruction-amount-arg-not-in-idl",
        subject: `[instructions].${ixName}.amount`,
        message: `adapter binds \`amount = "${mapping.amount}"\` but instruction \`${ixName}\` declares no arg with that name.`,
        hint: `Instruction \`${ixName}\` declares args: ${formatList(idlIx.args.map((a) => a.name))}.`,
      });
    }
    for (const argName of Object.keys(mapping.args ?? {})) {
      if (!idlArgNames.has(argName)) {
        findings.push({
          level: "fail",
          code: "instruction-arg-not-in-idl",
          subject: `[instructions].${ixName}.args.${argName}`,
          message: `adapter binds literal \`args.${argName}\` but instruction \`${ixName}\` declares no arg with that name.`,
          hint: `Instruction \`${ixName}\` declares args: ${formatList(idlIx.args.map((a) => a.name))}.`,
        });
      }
    }
  }

  // --- scheduled-action instruction checks ---
  for (const [idx, sa] of adapter.scheduled_actions.entries()) {
    // Adapter validation already guarantees sa.instruction is in
    // adapter.instructions. Re-check it against the IDL directly so a
    // scheduled action targeting an IDL-nonexistent instruction is
    // still named in the lint failure path for clarity.
    if (!idlInstructionsByName.has(sa.instruction)) {
      findings.push({
        level: "fail",
        code: "scheduled-instruction-not-in-idl",
        subject: `[[scheduled_actions]][${idx}].instruction`,
        message: `scheduled action references instruction \`${sa.instruction}\` but the JSON IDL has no instruction with that name.`,
        hint: `Available instructions in the IDL: ${formatList(idl.instructions.map((i) => i.name))}.`,
      });
    }
  }

  // --- account + field checks ---
  //
  // Externally-owned accounts (`[accounts.<name>.owner]` with
  // `program_so` or `pubkey`) are legitimately outside the adapter's
  // primary JSON IDL — they belong to a sibling program (e.g. the
  // admin-mock oracle bound by liquid-staking). Skip the cross
  // check for those; a missing IDL account is only a failure for
  // accounts that the adapter claims the simulated program itself owns.
  const mappedAccounts: string[] = [];
  const siblingOwnedAccounts = new Set<string>();
  const decodedAccounts = new Set<string>();
  for (const [accountName, def] of Object.entries(adapter.accounts)) {
    if (def.decoder !== undefined) {
      decodedAccounts.add(accountName);
      continue;
    }
    // Defensive: only treat the account as externally-owned when the
    // owner block is *valid* (exactly one of program_so / pubkey, both
    // non-empty after trimming). The CLI schema already enforces this
    // via validateAccountOwners, but the guard protects against future
    // schema drift — an invalid owner block must not silently hide an
    // IDL mismatch under `mapped-surface-clean`.
    if (isValidExternalOwner(def.owner)) {
      siblingOwnedAccounts.add(accountName);
      continue;
    }
    if (findIdlAccount(idlAccountsByName, accountName) !== undefined) {
      mappedAccounts.push(accountName);
    }
  }

  const mappedFieldKeys = new Set<string>();
  const mappedFields: Array<{ account: string; field: string }> = [];
  const recordField = (account: string, field: string) => {
    const key = `${account}.${field}`;
    if (!mappedFieldKeys.has(key)) {
      mappedFieldKeys.add(key);
      mappedFields.push({ account, field });
    }
  };

  // state_mapping keys are `account.field`.
  for (const key of Object.keys(adapter.state_mapping)) {
    const parts = splitDotted(key);
    if (parts === null) continue; // adapter validation already rejects malformed dotted keys
    const [account, field] = parts;
    if (decodedAccounts.has(account)) {
      recordField(account, field);
      continue;
    }
    // Sibling-owned accounts belong to a different program and are
    // intentionally outside the adapter's main JSON IDL.
    if (siblingOwnedAccounts.has(account)) {
      recordField(account, field);
      continue;
    }
    const idlAccount = findIdlAccount(idlAccountsByName, account);
    if (!idlAccount) {
      findings.push({
        level: "fail",
        code: "state-mapping-account-not-in-idl",
        subject: `[state_mapping]."${key}"`,
        message: `state_mapping key references account \`${account}\` but the JSON IDL has no account with that name.`,
        hint: `Available accounts in the IDL: ${formatList(idl.accounts.map((a) => a.name))}.`,
      });
      continue;
    }
    const fieldNames = new Set(idlAccount.fields.map((f) => f.name));
    if (!fieldNames.has(field)) {
      findings.push({
        level: "fail",
        code: "state-mapping-field-not-in-idl",
        subject: `[state_mapping]."${key}"`,
        message: `state_mapping key references \`${account}.${field}\` but account \`${account}\` has no such field in the JSON IDL.`,
        hint: `Account \`${account}\` declares fields: ${formatList(idlAccount.fields.map((f) => f.name))}.`,
      });
      continue;
    }
    recordField(account, field);
  }

  // observations keys may be either `account.field` (generic path) or a
  // plain logical observation name (lending path). Only check when
  // dotted — lending observations are logical names, not IDL refs.
  for (const obsKey of Object.keys(adapter.observations)) {
    if (logicalObservations.has(obsKey)) {
      continue;
    }
    const parts = splitDotted(obsKey);
    if (parts === null) continue;
    const [account, field] = parts;
    if (decodedAccounts.has(account)) {
      recordField(account, field);
      continue;
    }
    if (siblingOwnedAccounts.has(account)) {
      recordField(account, field);
      continue;
    }
    const idlAccount = findIdlAccount(idlAccountsByName, account);
    if (!idlAccount) {
      findings.push({
        level: "fail",
        code: "observation-account-not-in-idl",
        subject: `[observations]."${obsKey}"`,
        message: `observation key references account \`${account}\` but the JSON IDL has no account with that name.`,
        hint: `Available accounts in the IDL: ${formatList(idl.accounts.map((a) => a.name))}.`,
      });
      continue;
    }
    const fieldNames = new Set(idlAccount.fields.map((f) => f.name));
    if (!fieldNames.has(field)) {
      findings.push({
        level: "fail",
        code: "observation-field-not-in-idl",
        subject: `[observations]."${obsKey}"`,
        message: `observation \`${obsKey}\` references field \`${field}\` on account \`${account}\` but the JSON IDL does not declare it.`,
        hint: `Account \`${account}\` declares fields: ${formatList(idlAccount.fields.map((f) => f.name))}.`,
      });
      continue;
    }
    recordField(account, field);
  }

  // invariants[].field is a dotted `account.field` reference too.
  for (const [idx, inv] of adapter.invariants.entries()) {
    if (adapter.observations[inv.field] !== undefined) {
      continue;
    }
    const parts = splitDotted(inv.field);
    if (parts === null) {
      // adapter allows non-dotted invariant fields (e.g. logical lending
      // observations like `tvl`). Don't fail — lending adapters already
      // live in the skip/warn `non-json` branch.
      continue;
    }
    const [account, field] = parts;
    if (decodedAccounts.has(account)) {
      recordField(account, field);
      continue;
    }
    if (siblingOwnedAccounts.has(account)) {
      recordField(account, field);
      continue;
    }
    const idlAccount = findIdlAccount(idlAccountsByName, account);
    const subject = inv.name
      ? `[[invariants]][${idx}] (${inv.name})`
      : `[[invariants]][${idx}]`;
    if (!idlAccount) {
      findings.push({
        level: "fail",
        code: "invariant-account-not-in-idl",
        subject,
        message: `invariant references account \`${account}\` but the JSON IDL has no account with that name.`,
        hint: `Available accounts in the IDL: ${formatList(idl.accounts.map((a) => a.name))}.`,
      });
      continue;
    }
    const fieldNames = new Set(idlAccount.fields.map((f) => f.name));
    if (!fieldNames.has(field)) {
      findings.push({
        level: "fail",
        code: "invariant-field-not-in-idl",
        subject,
        message: `invariant references \`${account}.${field}\` but account \`${account}\` has no such field in the JSON IDL.`,
        hint: `Account \`${account}\` declares fields: ${formatList(idlAccount.fields.map((f) => f.name))}.`,
      });
      continue;
    }
    recordField(account, field);
  }

  // --- coverage report + honest warnings ---
  const unsupportedText = (adapter.lineage?.unsupported_fields ?? []).join("\n").toLowerCase();
  const recognizedUnsupportedInstructions: string[] = [];
  const uncoveredInstructions: string[] = [];
  for (const ix of idl.instructions) {
    if (mappedInstructions.includes(ix.name)) continue;
    if (unsupportedText.includes(`\`${ix.name}\``) || unsupportedText.includes(`\`${ix.name}(`)) {
      recognizedUnsupportedInstructions.push(ix.name);
    } else {
      uncoveredInstructions.push(ix.name);
    }
  }

  for (const uncovered of uncoveredInstructions) {
    findings.push({
      level: "warn",
      code: "idl-instruction-uncovered",
      subject: `${adapterName}: instruction \`${uncovered}\``,
      message: `IDL declares instruction \`${uncovered}\` but the adapter does not map it and does not name it in [lineage].unsupported_fields.`,
      hint: `Either map \`${uncovered}\` under [instructions] or acknowledge it explicitly in [lineage].unsupported_fields — lint will stop warning once it is accounted for.`,
    });
  }

  // uncovered fields — only for accounts the adapter declares
  // interest in (either in [accounts] or in state_mapping). We
  // deliberately do NOT enumerate every IDL account's fields as
  // "uncovered" — an adapter that intentionally ignores an entire
  // account should not be punished with N warnings per ignored
  // account.
  const accountsOfInterest = new Set<string>([
    ...mappedAccounts,
    ...mappedFields.map((f) => f.account),
  ]);
  const uncoveredFields: Array<{ account: string; field: string }> = [];
  for (const account of accountsOfInterest) {
    const idlAccount = findIdlAccount(idlAccountsByName, account);
    if (!idlAccount) continue;
    for (const field of idlAccount.fields) {
      const isMapped = mappedFields.some(
        (m) => m.account === account && m.field === field.name
      );
      if (isMapped) continue;
      const fieldRef = `${account}.${field.name}`;
      // Accept either the exact dotted reference or a plain field name
      // embedded in the unsupported prose.
      const fieldRefLower = fieldRef.toLowerCase();
      const fieldNameLower = field.name.toLowerCase();
      const recognizedAsUnsupported =
        unsupportedText.includes(fieldRefLower) ||
        unsupportedText.includes(`\`${fieldNameLower}\``) ||
        unsupportedText.includes(`.${fieldNameLower} `) ||
        unsupportedText.includes(`.${fieldNameLower}/`) ||
        unsupportedText.includes(`.${fieldNameLower},`);
      if (recognizedAsUnsupported) continue;
      uncoveredFields.push({ account, field: field.name });
    }
  }

  for (const uncovered of uncoveredFields) {
    findings.push({
      level: "warn",
      code: "idl-field-uncovered",
      subject: `${adapterName}: \`${uncovered.account}.${uncovered.field}\``,
      message: `account \`${uncovered.account}\` declares field \`${uncovered.field}\` in the JSON IDL but the adapter does not map it and does not name it in [lineage].unsupported_fields.`,
      hint: `Either bind it under [state_mapping] / [observations] or acknowledge it explicitly in [lineage].unsupported_fields.`,
    });
  }

  // Only emit the "all mapped clean" PASS if nothing upstream already
  // failed — an adapter with one bad mapping should not read as
  // partially passing.
  const hasFail = findings.some((f) => f.level === "fail");
  if (!hasFail && mappedInstructions.length > 0) {
    findings.unshift({
      level: "pass",
      code: "mapped-surface-clean",
      subject: `${mappedInstructions.length} instruction(s), ${mappedFields.length} field ref(s)`,
      message: `every mapped instruction, arg, account, and \`account.field\` reference resolves in the JSON IDL.`,
    });
  }

  return {
    mappedInstructions,
    recognizedUnsupportedInstructions,
    uncoveredInstructions,
    mappedAccounts,
    mappedFields,
    uncoveredFields,
  };
}

// ---------- helpers ----------

function exitCodeFrom(findings: LintFinding[]): 0 | 1 | 2 {
  if (findings.some((f) => f.level === "fail")) return 2;
  if (findings.some((f) => f.level === "warn")) return 1;
  return 0;
}

function isValidExternalOwner(owner: AccountOwner | undefined): boolean {
  if (owner === undefined) return false;
  const programSo = (owner.program_so ?? "").trim();
  const pubkey = (owner.pubkey ?? "").trim();
  const hasProgramSo = owner.program_so !== undefined && programSo.length > 0;
  const hasPubkey = owner.pubkey !== undefined && pubkey.length > 0;
  // Exactly-one; treat the field as present only when the contract is
  // intact. For the pubkey branch, also require that the value is a
  // valid base58-encoded 32-byte pubkey — mirrors
  // `engine/src/adapter/loader.rs::validate_account_owners`'s
  // `Pubkey::from_str` check. Belt-and-braces: schema-level validation
  // already rejects these, but the linter should never silently skip
  // an IDL cross-check on an unverified owner.
  if (hasProgramSo && hasPubkey) return false;
  if (hasProgramSo) return true;
  if (hasPubkey) return isBase58Pubkey32(pubkey);
  return false;
}

const BASE58_ALPHABET_SET = new Set(
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
);

function isBase58Pubkey32(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i += 1) {
    if (!BASE58_ALPHABET_SET.has(s.charAt(i))) return false;
  }
  // Byte-length check via inline base58 decode. Valid Solana pubkey
  // encodes to 32-44 base58 chars; the exact byte-length check has to
  // happen on the decoded output.
  let leadingZeros = 0;
  while (leadingZeros < s.length && s.charAt(leadingZeros) === "1") {
    leadingZeros += 1;
  }
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes: number[] = [];
  for (let i = leadingZeros; i < s.length; i += 1) {
    let carry = alphabet.indexOf(s.charAt(i));
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  return leadingZeros + bytes.length === 32;
}

function splitDotted(key: string): [string, string] | null {
  const dot = key.indexOf(".");
  if (dot <= 0 || dot === key.length - 1) return null;
  return [key.slice(0, dot), key.slice(dot + 1)];
}

function findIdlAccount(
  accounts: Map<string, JsonIdl["accounts"][number]>,
  adapterName: string
): JsonIdl["accounts"][number] | undefined {
  const exact = accounts.get(adapterName);
  if (exact !== undefined) return exact;
  const normalizedAdapterName = normalizeIdlName(adapterName);
  for (const account of accounts.values()) {
    if (normalizeIdlName(account.name) === normalizedAdapterName) {
      return account;
    }
  }
  return undefined;
}

function normalizeIdlName(value: string): string {
  return value.replace(/[_-]/g, "").toLowerCase();
}

function resolveLineageSource(idlSource: string, adapterPath: string, repoRoot: string): string {
  if (path.isAbsolute(idlSource)) return idlSource;
  // Two resolution bases, in order:
  //   1. repo root — matches `fixtures/idls/<name>.json` style entries
  //      authored relative to the monorepo root (the common case on the
  //      shipping adapters).
  //   2. adapter directory — fallback for adapters that live outside
  //      the repo's fixtures tree and keep the IDL next to the TOML.
  const repoRelative = path.resolve(repoRoot, idlSource);
  if (existsSync(repoRelative)) return repoRelative;
  const adapterRelative = path.resolve(path.dirname(adapterPath), idlSource);
  if (existsSync(adapterRelative)) return adapterRelative;
  // Neither candidate exists; return the repo-rooted guess so the
  // downstream failure message names a concrete, predictable path.
  return repoRelative;
}

function parseJsonIdl(raw: string): JsonIdl {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON IDL root is not an object");
  }
  const instructions: IdlInstruction[] = [];
  const instructionsRaw = (parsed as { instructions?: unknown }).instructions;
  if (Array.isArray(instructionsRaw)) {
    for (const entry of instructionsRaw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { name?: unknown; args?: unknown; accounts?: unknown };
      if (typeof e.name !== "string") continue;
      const args: IdlArg[] = [];
      if (Array.isArray(e.args)) {
        for (const a of e.args) {
          if (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string") {
            args.push({ name: (a as { name: string }).name });
          }
        }
      }
      const accounts: IdlAccountSlot[] = [];
      if (Array.isArray(e.accounts)) {
        for (const s of e.accounts) {
          if (s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string") {
            accounts.push({ name: (s as { name: string }).name });
          }
        }
      }
      instructions.push({ name: e.name, args, accounts });
    }
  }

  const accounts: IdlAccount[] = [];
  const typeFieldsByName = new Map<string, IdlAccountField[]>();
  const typesRaw = (parsed as { types?: unknown }).types;
  if (Array.isArray(typesRaw)) {
    for (const entry of typesRaw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { name?: unknown; fields?: unknown; type?: unknown };
      if (typeof e.name !== "string") continue;
      const fieldsRaw = Array.isArray(e.fields)
        ? e.fields
        : e.type && typeof e.type === "object" && Array.isArray((e.type as { fields?: unknown }).fields)
          ? (e.type as { fields: unknown[] }).fields
          : [];
      const fields: IdlAccountField[] = [];
      for (const f of fieldsRaw) {
        if (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string") {
          fields.push({ name: (f as { name: string }).name });
        }
      }
      typeFieldsByName.set(e.name, fields);
    }
  }
  const accountsRaw = (parsed as { accounts?: unknown }).accounts;
  if (Array.isArray(accountsRaw)) {
    for (const entry of accountsRaw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { name?: unknown; fields?: unknown };
      if (typeof e.name !== "string") continue;
      let fields: IdlAccountField[] = [];
      if (Array.isArray(e.fields)) {
        for (const f of e.fields) {
          if (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string") {
            fields.push({ name: (f as { name: string }).name });
          }
        }
      } else {
        fields = typeFieldsByName.get(e.name) ?? [];
      }
      accounts.push({ name: e.name, fields });
    }
  }

  return { instructions, accounts };
}

function formatList(names: string[]): string {
  if (names.length === 0) return "(none)";
  return names.map((n) => `\`${n}\``).join(", ");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
