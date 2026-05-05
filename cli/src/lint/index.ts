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
//   is warn-only. Do NOT attempt to parse Rust here.
// - Missing `[lineage]` block is an explicit `SKIP`, not a PASS.
// - Uncovered source surfaces may warn. Never silently claim full
//   coverage.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { inferAdapterRuntime } from "../schemas/adapter.js";
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
  optional?: boolean;
  address?: string;
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
  typeFieldsByName: Map<string, IdlAccountField[]>;
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
  lintAdapterLocalSurface(adapter, findings);
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
        : "machine validation is only available for JSON IDL sources; this source kind is inspection-only.",
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

    const missingAccounts = uniqueSorted(
      idlIx.accounts
        .filter((account) => !idlInstructionAccountIsSatisfied(adapter, account))
        .map((account) => account.name)
    );
    if (missingAccounts.length > 0) {
      findings.push({
        level: "fail",
        code: "instruction-account-not-declared",
        subject: `[instructions].${ixName}`,
        message:
          `adapter maps instruction \`${ixName}\`, but required IDL account(s) ${formatList(missingAccounts)} are not declared under [accounts] and are not recognized signers or well-known program/sysvar accounts.`,
        hint: `Add account bindings such as:\n${missingAccounts.map(suggestAccountStub).join("\n\n")}`,
      });
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
      if (!hasIdlFieldPath(idl, idlAccount, field)) {
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
    if (!hasIdlFieldPath(idl, idlAccount, field)) {
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
    if (!hasIdlFieldPath(idl, idlAccount, field)) {
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
    const ixNameLower = ix.name.toLowerCase();
    if (
      unsupportedText.includes(`\`${ixNameLower}\``) ||
      unsupportedText.includes(`\`${ixNameLower}(`)
    ) {
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

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function lintAdapterLocalSurface(adapter: Adapter, findings: LintFinding[]): void {
  if (inferAdapterRuntime(adapter) !== "generic") return;

  for (const [idx, inv] of adapter.invariants.entries()) {
    if (adapter.observations[inv.field] !== undefined) continue;
    const subject = inv.name
      ? `[[invariants]][${idx}] (${inv.name})`
      : `[[invariants]][${idx}]`;
    findings.push({
      level: "fail",
      code: "generic-invariant-field-not-observed",
      subject,
      message: `generic runtime invariant field \`${inv.field}\` is not declared under [observations].`,
      hint:
        "Generic SBF/IDL adapters may only use declared observation keys in [[invariants]]. Declare the observation, map it from [state_mapping], or remove bundled-lending snapshot metrics such as `active_agents`, `utilization`, and `cumulative_bad_debt`.",
    });
  }

  const declaredAccounts = new Set(Object.keys(adapter.accounts));
  for (const [idx, sa] of adapter.scheduled_actions.entries()) {
    for (const [accountIdx, account] of sa.accounts.entries()) {
      if (declaredAccounts.has(account)) continue;
      findings.push({
        level: "fail",
        code: "scheduled-action-account-not-declared",
        subject: `[[scheduled_actions]][${idx}].accounts[${accountIdx}]`,
        message: `scheduled action references account \`${account}\` but no [accounts.${account}] binding exists.`,
        hint: `Add an account binding such as:\n${suggestAccountStub(account)}`,
      });
    }
  }
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

function idlInstructionAccountIsSatisfied(adapter: Adapter, account: IdlAccountSlot): boolean {
  if (account.optional === true) return true;
  if (account.name in adapter.accounts) return true;
  if (account.address !== undefined && account.address.trim().length > 0) return true;
  if (account.signer === true && isRecognizedGenericSigner(account.name)) return true;
  return isWellKnownGenericAccountAlias(account.name);
}

function isRecognizedGenericSigner(value: string): boolean {
  switch (normalizeIdlName(value)) {
    case "admin":
    case "adminauthority":
    case "agent":
    case "agentauthority":
    case "authority":
    case "managerauthority":
    case "owner":
    case "payer":
    case "tokenauthority":
    case "trader":
    case "user":
    case "userauthority":
      return true;
    default:
      return false;
  }
}

function isWellKnownGenericAccountAlias(value: string): boolean {
  return [
    "system",
    "system_program",
    "spl_token",
    "token",
    "token_program",
    "spl_token_2022",
    "token_2022",
    "token_2022_program",
    "associated_token",
    "associated_token_program",
    "ata",
    "rent",
    "rent_sysvar",
    "sysvar_rent",
    "clock",
    "clock_sysvar",
    "sysvar_clock",
    "instructions_sysvar",
    "sysvar_instructions",
    "slot_hashes",
    "slot_hashes_sysvar",
    "sysvar_slot_hashes",
    "stake_history",
    "stake_history_sysvar",
    "sysvar_stake_history",
  ].includes(value);
}

function suggestAccountStub(accountName: string): string {
  const kind = guessAccountKind(accountName);
  const extra = guessAccountExtra(accountName);
  return [
    `[accounts.${accountName}]`,
    `kind = "${kind}"`,
    `space = ${guessAccountSpace(accountName)}`,
    ...extra,
  ].join("\n");
}

function guessAccountKind(accountName: string): "agent" | "shared" {
  const normalized = accountName.toLowerCase();
  if (
    /(authority|borrower|liquidator|owner|trader|user)/.test(normalized) &&
    /(ata|token_account|wallet|position|obligation|account)/.test(normalized)
  ) {
    return "agent";
  }
  return "shared";
}

function guessAccountSpace(accountName: string): string {
  const normalized = accountName.toLowerCase();
  if (normalized.includes("price_update_v2")) return "134";
  if (normalized.includes("token_account") || normalized.endsWith("_ata")) return "165";
  if (normalized.includes("mint")) return "82";
  return "\"auto\"";
}

function guessAccountExtra(accountName: string): string[] {
  const normalized = accountName.toLowerCase();
  if (normalized.includes("token_account") || normalized.endsWith("_ata")) {
    return ['decoder = "spl_token_account"'];
  }
  if (normalized.includes("mint")) {
    return ['decoder = "spl_mint"'];
  }
  return [];
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

function hasIdlFieldPath(idl: JsonIdl, account: IdlAccount, fieldPath: string): boolean {
  let fields = account.fields;
  const segments = fieldPath.split(".");
  for (let idx = 0; idx < segments.length; idx += 1) {
    const segment = segments[idx]!;
    const field = fields.find((candidate) => candidate.name === segment);
    if (field === undefined) return false;
    if (idx === segments.length - 1) return true;
    const defined = definedTypeName(field.type);
    if (defined === null) return false;
    fields = idl.typeFieldsByName.get(defined) ?? [];
  }
  return false;
}

function definedTypeName(type: unknown): string | null {
  if (!type || typeof type !== "object") return null;
  const defined = (type as { defined?: unknown }).defined;
  if (typeof defined === "string") return defined;
  if (defined && typeof defined === "object" && typeof (defined as { name?: unknown }).name === "string") {
    return (defined as { name: string }).name;
  }
  return null;
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
            args.push({ name: (a as { name: string }).name, type: (a as { type?: unknown }).type });
          }
        }
      }
      const accounts: IdlAccountSlot[] = [];
      if (Array.isArray(e.accounts)) {
        accounts.push(...parseIdlInstructionAccounts(e.accounts));
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
      typeFieldsByName.set(e.name, parseIdlFields(fieldsRaw));
    }
  }
  const accountsRaw = (parsed as { accounts?: unknown }).accounts;
  if (Array.isArray(accountsRaw)) {
    for (const entry of accountsRaw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { name?: unknown; fields?: unknown; type?: unknown };
      if (typeof e.name !== "string") continue;
      let fields: IdlAccountField[] = [];
      if (Array.isArray(e.fields)) {
        fields = parseIdlFields(e.fields);
      } else if (e.type && typeof e.type === "object" && Array.isArray((e.type as { fields?: unknown }).fields)) {
        fields = parseIdlFields((e.type as { fields: unknown[] }).fields);
      } else {
        fields = typeFieldsByName.get(e.name) ?? [];
      }
      accounts.push({ name: e.name, fields });
    }
  }

  return { instructions, accounts, typeFieldsByName };
}

function parseIdlFields(fieldsRaw: unknown[]): IdlAccountField[] {
  const fields: IdlAccountField[] = [];
  for (const f of fieldsRaw) {
    if (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string") {
      fields.push({ name: (f as { name: string }).name, type: (f as { type?: unknown }).type });
    }
  }
  return fields;
}

function parseIdlInstructionAccounts(accountsRaw: unknown[]): IdlAccountSlot[] {
  const accounts: IdlAccountSlot[] = [];

  const visit = (entries: unknown[]) => {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as {
        name?: unknown;
        accounts?: unknown;
        signer?: unknown;
        isSigner?: unknown;
        writable?: unknown;
        isMut?: unknown;
        optional?: unknown;
        address?: unknown;
      };
      if (Array.isArray(record.accounts)) {
        visit(record.accounts);
        continue;
      }
      if (typeof record.name !== "string") continue;
      accounts.push({
        name: record.name,
        signer: boolValue(record.signer) ?? boolValue(record.isSigner),
        writable: boolValue(record.writable) ?? boolValue(record.isMut),
        optional: boolValue(record.optional),
        address: typeof record.address === "string" ? record.address : undefined,
      });
    }
  };

  visit(accountsRaw);
  return accounts;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatList(names: string[]): string {
  if (names.length === 0) return "(none)";
  return names.map((n) => `\`${n}\``).join(", ");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
