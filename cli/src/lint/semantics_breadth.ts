// ENGINE IS SOURCE OF TRUTH for parsing. This file mirrors the rules; if engine rejects, lint must reject too.

import type { Adapter, Semantics } from "../schemas/adapter.js";
import {
  COLLECTION_FORMULAS,
  REPLAY_STATE_SOURCES,
} from "../schemas/adapter.js";
import type { LintFinding } from "./index.js";

const SAFE_ADAPTER_IDENT_RE = /^[A-Za-z0-9_.-]+$/;
const SAFE_SEMANTIC_NAME_RE = /^[a-z][a-z0-9_]*$/;

export function lintSemanticsBreadth(adapter: Adapter): LintFinding[] {
  const semantics = adapter.semantics;
  if (semantics === undefined) return [];

  const findings: LintFinding[] = [];
  lintOracleBindings(semantics, findings);
  lintCollections(semantics, findings);
  lintReplay(semantics, findings);

  if (hasBreadthSurface(semantics) && !findings.some((finding) => finding.level !== "pass")) {
    findings.unshift({
      level: "pass",
      code: "semantics-breadth-clean",
      subject: "[semantics].oracles / collections / replay",
      message: "semantic oracle bindings, collections, and replay import declarations are valid.",
    });
  }

  return findings;
}

function hasBreadthSurface(semantics: Semantics): boolean {
  return (
    Object.keys(semantics.oracles).length > 0 ||
    Object.keys(semantics.collections).length > 0 ||
    semantics.replay !== undefined
  );
}

function lintOracleBindings(semantics: Semantics, findings: LintFinding[]): void {
  for (const [role, bindings] of Object.entries(semantics.oracles)) {
    if (!isSafeSemanticName(role)) {
      fail(
        findings,
        "semantics-oracle-malformed-role",
        `[semantics.oracles].${role}`,
        `semantic oracle role \`${role}\` must match \`[a-z][a-z0-9_]*\`.`,
        "Rename the oracle role to a valid semantic name."
      );
      continue;
    }

    if (!(role in semantics.roles)) {
      fail(
        findings,
        "semantics-oracle-unknown-role",
        `[semantics.oracles].${role}`,
        `UnknownOracleRole(${role}); declare [semantics.roles.${role}] before binding [semantics.oracles.${role}].`,
        `Add [semantics.roles.${role}] or move the oracle binding under an existing role.`
      );
      continue;
    }

    if (bindings.length === 0) {
      fail(
        findings,
        "semantics-oracle-empty-bindings",
        `[semantics.oracles].${role}`,
        `MultiOracleArityMismatch(role=${role}); expected at least 1 oracle binding, found 0.`,
        `Add at least one [[semantics.oracles.${role}]] binding or remove the empty role.`
      );
      continue;
    }

    let weightCount = 0;
    let weightSum = 0;
    bindings.forEach((binding, idx) => {
      const key = `[[semantics.oracles.${role}]][${idx}]`;
      lintPubkey(findings, `${key}.program_id`, "program_id", binding.program_id, "semantics-oracle-invalid-pubkey");
      lintPubkey(findings, `${key}.account`, "account", binding.account, "semantics-oracle-invalid-pubkey");

      if (!isSafeAdapterIdentifier(binding.confidence)) {
        fail(
          findings,
          "semantics-oracle-invalid-field-path",
          `${key}.confidence`,
          `oracle confidence path \`${binding.confidence}\` must match \`[A-Za-z0-9_.-]+\`.`,
          "Use a safe adapter identifier such as `oracle.confidence`."
        );
      }
      if (!isSafeAdapterIdentifier(binding.staleness)) {
        fail(
          findings,
          "semantics-oracle-invalid-field-path",
          `${key}.staleness`,
          `oracle staleness path \`${binding.staleness}\` must match \`[A-Za-z0-9_.-]+\`.`,
          "Use a safe adapter identifier such as `oracle.staleness`."
        );
      }

      if (binding.weight !== undefined) {
        weightCount += 1;
        if (!Number.isInteger(binding.weight) || binding.weight < 0) {
          fail(
            findings,
            "semantics-oracle-invalid-weight",
            `${key}.weight`,
            `oracle weight \`${binding.weight}\` must be a nonnegative integer.`,
            "Use nonnegative integer weights for every binding, or omit weights entirely."
          );
        } else {
          weightSum += binding.weight;
        }
      }
    });

    if (weightCount > 0 && weightCount !== bindings.length) {
      fail(
        findings,
        "semantics-oracle-weight-arity-mismatch",
        `[semantics.oracles].${role}.weight`,
        `MultiOracleArityMismatch(role=${role}); expected ${bindings.length} weight entries to match the oracle binding count, found ${weightCount}.`,
        "Either set `weight` on every oracle binding for this role or omit weights on all of them."
      );
    }
    if (weightCount > 0 && weightSum === 0) {
      fail(
        findings,
        "semantics-oracle-zero-total-weight",
        `[semantics.oracles].${role}.weight`,
        `MultiOracleWeightsAllZero(role=${role}); weighted oracle bindings must have a positive total weight.`,
        "Set at least one oracle binding weight above zero."
      );
    }
  }
}

function lintCollections(semantics: Semantics, findings: LintFinding[]): void {
  for (const [name, collection] of Object.entries(semantics.collections)) {
    if (!isSafeSemanticName(name)) {
      fail(
        findings,
        "semantics-collection-malformed-name",
        `[semantics.collections].${name}`,
        `semantic collection name \`${name}\` must match \`[a-z][a-z0-9_]*\`.`,
        "Rename the collection to a valid semantic name."
      );
    }

    if (!isSafeSemanticName(collection.over)) {
      fail(
        findings,
        "semantics-collection-malformed-over",
        `[semantics.collections].${name}.over`,
        `collection \`over\` value \`${collection.over}\` must match \`[a-z][a-z0-9_]*\`.`,
        "Use a declared semantic role or one of `reserves`, `markets`, `positions`."
      );
    } else if (!isKnownCollectionOver(semantics, collection.over)) {
      fail(
        findings,
        "semantics-collection-unknown-role",
        `[semantics.collections].${name}.over`,
        `UnknownCollectionRole(${collection.over}); \`over\` must reference a declared semantic role, or one of \`reserves\`, \`markets\`, \`positions\` whose singular role is declared.`,
        "Point `over` at an existing semantic role or a supported plural alias."
      );
    }

    if (!COLLECTION_FORMULAS.includes(collection.formula as (typeof COLLECTION_FORMULAS)[number])) {
      fail(
        findings,
        "semantics-collection-unknown-formula",
        `[semantics.collections].${name}.formula`,
        `UnknownCollectionFormula(${collection.formula}); expected one of \`sum\`, \`min\`, \`max\`, \`worst\`.`,
        "Use one of `sum`, `min`, `max`, or `worst`."
      );
    }

    const parsed = parseExpressionForLint(collection.expr);
    if (!parsed.ok) {
      fail(
        findings,
        "semantics-collection-expression-parse-failed",
        `[semantics.collections].${name}.expr`,
        `CollectionExpressionParse: malformed semantic expression at byte ${parsed.span.start}: ${parsed.message}.`,
        "Fix the collection expression syntax; valid expressions use identifiers, dotted role fields, helper calls, arithmetic, comparisons, logical operators, and parentheses."
      );
    }
  }
}

function lintReplay(semantics: Semantics, findings: LintFinding[]): void {
  const replay = semantics.replay;
  if (replay === undefined) return;

  if (
    replay.state_source === undefined ||
    !REPLAY_STATE_SOURCES.includes(replay.state_source as (typeof REPLAY_STATE_SOURCES)[number])
  ) {
    fail(
      findings,
      "semantics-replay-unknown-state-source",
      "[semantics.replay].state_source",
      `UnknownReplayStateSource(${replay.state_source ?? "<missing>"}); expected \`fixture\` or \`mainnet-rpc\`.`,
      "Set `state_source = \"fixture\"` with a replay pack path, or `state_source = \"mainnet-rpc\"`."
    );
    return;
  }

  if (replay.state_source === "mainnet-rpc") {
    findings.push({
      level: "warn",
      code: "semantics-replay-mainnet-rpc-not-implemented",
      subject: '[semantics.replay].state_source = "mainnet-rpc"',
      message:
        "MainnetRpcNotImplemented; mainnet-rpc state import is not implemented in v1.",
      hint: "Export accounts to a fixture pack via `riptide pack-state` when fixture-backed replay is required.",
    });
  }

  if (replay.state_source === "fixture") {
    if (replay.pack_path === undefined || replay.pack_path.trim().length === 0) {
      fail(
        findings,
        "semantics-replay-missing-pack-path",
        "[semantics.replay].pack_path",
        'MissingReplayPackPath; fixture replay state import requires `pack_path = "<relative-path>"`.',
        "Set a relative `pack_path` under [semantics.replay]."
      );
    } else {
      lintRelativePath(findings, "[semantics.replay].pack_path", replay.pack_path);
    }
  } else if (replay.pack_path !== undefined) {
    lintRelativePath(findings, "[semantics.replay].pack_path", replay.pack_path);
  }

  for (const [role, account] of Object.entries(replay.roles)) {
    if (!isSafeSemanticName(role)) {
      fail(
        findings,
        "semantics-replay-malformed-role",
        `[semantics.replay.roles].${role}`,
        `replay role \`${role}\` must match \`[a-z][a-z0-9_]*\`.`,
        "Rename the replay role to match a declared semantic role."
      );
      continue;
    }
    if (!(role in semantics.roles)) {
      fail(
        findings,
        "semantics-replay-unknown-role",
        `[semantics.replay.roles].${role}`,
        `replay role \`${role}\` references no [semantics.roles.${role}] entry.`,
        "Declare the semantic role before binding it in [semantics.replay.roles]."
      );
      continue;
    }
    lintPubkey(findings, `[semantics.replay.roles].${role}`, "account pubkey", account, "semantics-replay-invalid-pubkey");
  }
}

function isKnownCollectionOver(semantics: Semantics, over: string): boolean {
  if (over in semantics.roles) return true;
  const singular = collectionPluralAlias(over);
  return singular !== null && singular in semantics.roles;
}

function collectionPluralAlias(over: string): string | null {
  switch (over) {
    case "reserves":
      return "reserve";
    case "markets":
      return "market";
    case "positions":
      return "position";
    default:
      return null;
  }
}

function lintPubkey(
  findings: LintFinding[],
  subject: string,
  label: string,
  value: string,
  code: string
): void {
  const reason = base58PubkeyError(value);
  if (reason === null) return;
  fail(
    findings,
    code,
    subject,
    `${label} \`${value}\` is not a valid base58-encoded 32-byte pubkey: ${reason}.`,
    "Use a base58-encoded Solana pubkey that decodes to exactly 32 bytes."
  );
}

function lintRelativePath(findings: LintFinding[], subject: string, value: string): void {
  if (value.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    fail(
      findings,
      "semantics-replay-invalid-pack-path",
      subject,
      `path \`${value}\` must be non-empty and free of control characters.`,
      "Use a relative path to a replay fixture pack."
    );
    return;
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    fail(
      findings,
      "semantics-replay-invalid-pack-path",
      subject,
      `path \`${value}\` must be relative to the adapter or replay fixture root.`,
      "Replace the absolute path with a relative replay pack path."
    );
  }
}

function isSafeAdapterIdentifier(value: string): boolean {
  return value.length > 0 && SAFE_ADAPTER_IDENT_RE.test(value);
}

function isSafeSemanticName(value: string): boolean {
  return SAFE_SEMANTIC_NAME_RE.test(value);
}

function fail(
  findings: LintFinding[],
  code: string,
  subject: string,
  message: string,
  hint: string
): void {
  findings.push({
    level: "fail",
    code,
    subject,
    message,
    hint,
  });
}

// Base58 alphabet (Bitcoin / Solana flavor: no "0", "O", "I", "l").
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP: Record<string, number> = Object.fromEntries(
  Array.from(BASE58_ALPHABET, (ch, i) => [ch, i])
);

function base58PubkeyError(s: string): string | null {
  if (s.length === 0) return "empty string";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (BASE58_MAP[ch] === undefined) {
      return `invalid base58 character \`${ch}\` at position ${i}`;
    }
  }

  let leadingZeros = 0;
  while (leadingZeros < s.length && s.charAt(leadingZeros) === "1") {
    leadingZeros += 1;
  }

  const bytes: number[] = [];
  for (let i = leadingZeros; i < s.length; i += 1) {
    let carry = BASE58_MAP[s.charAt(i)]!;
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

  const totalLen = leadingZeros + bytes.length;
  if (totalLen !== 32) {
    return `decoded to ${totalLen} bytes (expected 32)`;
  }
  return null;
}

type TokenKind =
  | "number"
  | "ident"
  | "+"
  | "-"
  | "*"
  | "/"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "!"
  | "("
  | ")"
  | ","
  | ".";

interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

interface LintExprError {
  message: string;
  span: { start: number; end: number };
}

function parseExpressionForLint(
  source: string
): { ok: true } | ({ ok: false } & LintExprError) {
  const lexed = lex(source);
  if (!lexed.ok) return lexed;
  if (lexed.value.length === 0) {
    return {
      ok: false,
      message: "empty expression",
      span: { start: 0, end: 0 },
    };
  }
  const parser = new ExprParser(lexed.value);
  const parsed = parser.parseExpr();
  if (!parsed.ok) return parsed;
  const trailing = parser.peek();
  if (trailing !== undefined) {
    return {
      ok: false,
      message: `trailing token \`${trailing.text}\``,
      span: { start: trailing.start, end: trailing.end },
    };
  }
  return { ok: true };
}

function lex(source: string): { ok: true; value: Token[] } | ({ ok: false } & LintExprError) {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const start = i;

    if (/[0-9]/.test(ch)) {
      i += 1;
      while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        i += 1;
        if (i >= source.length || !/[0-9]/.test(source[i]!)) {
          return {
            ok: false,
            message: "decimal point must be followed by at least one digit",
            span: { start, end: i },
          };
        }
        while (i < source.length && /[0-9]/.test(source[i]!)) i += 1;
      }
      tokens.push({ kind: "number", text: source.slice(start, i), start, end: i });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      i += 1;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i += 1;
      tokens.push({ kind: "ident", text: source.slice(start, i), start, end: i });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ kind: two as TokenKind, text: two, start, end: start + 2 });
      i += 2;
      continue;
    }
    if (["+", "-", "*", "/", "<", ">", "!", "(", ")", ",", "."].includes(ch)) {
      tokens.push({ kind: ch as TokenKind, text: ch, start, end: start + 1 });
      i += 1;
      continue;
    }
    if (ch === "=") {
      return {
        ok: false,
        message: "unexpected `=`; use `==` for equality",
        span: { start, end: start + 1 },
      };
    }
    if (ch === "&") {
      return {
        ok: false,
        message: "unexpected `&`; use `&&` for logical and",
        span: { start, end: start + 1 },
      };
    }
    if (ch === "|") {
      return {
        ok: false,
        message: "unexpected `|`; use `||` for logical or",
        span: { start, end: start + 1 },
      };
    }
    return {
      ok: false,
      message: `invalid character \`${ch}\``,
      span: { start, end: start + 1 },
    };
  }
  return { ok: true, value: tokens };
}

class ExprParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.index];
  }

  parseExpr(): { ok: true } | ({ ok: false } & LintExprError) {
    return this.parseOr();
  }

  private parseOr(): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseAnd();
    if (!parsed.ok) return parsed;
    while (this.match("||")) {
      parsed = this.parseAnd();
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseAnd(): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseEquality();
    if (!parsed.ok) return parsed;
    while (this.match("&&")) {
      parsed = this.parseEquality();
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseEquality(): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseComparison();
    if (!parsed.ok) return parsed;
    while (this.match("==") || this.match("!=")) {
      parsed = this.parseComparison();
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseComparison(): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseAdd();
    if (!parsed.ok) return parsed;
    while (this.match("<") || this.match("<=") || this.match(">") || this.match(">=")) {
      parsed = this.parseAdd();
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseAdd(): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseMul();
    if (!parsed.ok) return parsed;
    while (this.match("+") || this.match("-")) {
      parsed = this.parseMul();
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseMul(): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseUnary();
    if (!parsed.ok) return parsed;
    while (this.match("*") || this.match("/")) {
      parsed = this.parseUnary();
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseUnary(): { ok: true } | ({ ok: false } & LintExprError) {
    if (this.match("!") || this.match("-")) {
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): { ok: true } | ({ ok: false } & LintExprError) {
    const token = this.next();
    if (token === undefined) {
      const at = this.tokens[this.tokens.length - 1]?.end ?? 0;
      return {
        ok: false,
        message: "unexpected end of expression; expected number, bool, identifier, helper call, or `(`",
        span: { start: at, end: at },
      };
    }

    if (token.kind === "number") return { ok: true };
    if (token.kind === "(") {
      const expr = this.parseExpr();
      if (!expr.ok) return expr;
      return this.expect(")", "`)` after expression");
    }
    if (token.kind !== "ident") {
      return {
        ok: false,
        message: `unexpected token \`${token.text}\`; expected number, bool, identifier, helper call, or \`(\``,
        span: { start: token.start, end: token.end },
      };
    }

    if (this.match("(")) {
      if (this.match(")")) return { ok: true };
      while (true) {
        const arg = this.parseExpr();
        if (!arg.ok) return arg;
        if (this.match(",")) continue;
        return this.expect(")", "`,` or `)` after helper argument");
      }
    }

    if (token.text === "true" || token.text === "false") return { ok: true };
    while (this.match(".")) {
      const segment = this.next();
      if (segment === undefined) {
        return {
          ok: false,
          message: "unexpected end of expression; expected identifier after `.`",
          span: { start: token.end, end: token.end },
        };
      }
      if (segment.kind !== "ident" && !(segment.kind === "number" && /^\d+$/.test(segment.text))) {
        return {
          ok: false,
          message: `unexpected token \`${segment.text}\`; expected identifier after \`.\``,
          span: { start: segment.start, end: segment.end },
        };
      }
    }
    return { ok: true };
  }

  private match(kind: TokenKind): boolean {
    if (this.tokens[this.index]?.kind !== kind) return false;
    this.index += 1;
    return true;
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index];
    if (token !== undefined) this.index += 1;
    return token;
  }

  private expect(kind: TokenKind, label: string): { ok: true } | ({ ok: false } & LintExprError) {
    const token = this.next();
    if (token === undefined) {
      const at = this.tokens[this.tokens.length - 1]?.end ?? 0;
      return {
        ok: false,
        message: `unexpected end of expression; expected ${label}`,
        span: { start: at, end: at },
      };
    }
    if (token.kind !== kind) {
      return {
        ok: false,
        message: `unexpected token \`${token.text}\`; expected ${label}`,
        span: { start: token.start, end: token.end },
      };
    }
    return { ok: true };
  }
}
