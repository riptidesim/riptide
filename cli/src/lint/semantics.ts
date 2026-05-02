import type { Adapter, Semantics } from "../schemas/adapter.js";
import {
  SEMANTIC_CLASS_RE,
  SEMANTIC_CLASS_REQUIREMENTS,
  SEMANTIC_CLASS_RE_SOURCE,
  SUPPORTED_SEMANTIC_CLASSES,
  isSupportedSemanticClass,
} from "../schemas/adapter.js";
import type { LintFinding } from "./index.js";

type ExprPath = string[];

interface ParsedExpression {
  identifiers: ExprPath[];
}

export function lintSemantics(adapter: Adapter): LintFinding[] {
  const semantics = adapter.semantics;
  if (semantics === undefined) return [];

  const findings: LintFinding[] = [];
  lintSemanticClass(adapter, semantics, findings);
  lintRequiredSemanticSurface(semantics, findings);
  lintDerivedExpressions(semantics, findings);
  lintInvariantExpressions(semantics, findings);

  if (!findings.some((finding) => finding.level === "fail")) {
    findings.unshift({
      level: "pass",
      code: "semantics-clean",
      subject: `[semantics].class = "${semantics.class ?? "(missing)"}"`,
      message:
        `economic semantic class, required ${semantics.class} roles, required derived observations, expressions, and derived dependency graph are valid; runtime remains selected by program_so + idl_path or the protocol backcompat hint.`,
    });
  }

  return findings;
}

function lintSemanticClass(
  adapter: Adapter,
  semantics: Semantics,
  findings: LintFinding[]
): void {
  if (semantics.class === undefined) {
    fail(
      findings,
      "semantics-missing-class",
      "[semantics].class",
      'MissingSemanticClass(class); `[semantics]` blocks must declare an economic class such as `class = "lending.v1"`.',
      'Add `class = "lending.v1"` under `[semantics]`.'
    );
    return;
  }
  if (!SEMANTIC_CLASS_RE.test(semantics.class)) {
    fail(
      findings,
      "semantics-malformed-class",
      "[semantics].class",
      `malformed semantic class string \`${semantics.class}\`; expected regex \`${SEMANTIC_CLASS_RE_SOURCE}\`.`,
      'Use a class string shaped like `lending.v1`.'
    );
    return;
  }
  if (!isSupportedSemanticClass(semantics.class)) {
    fail(
      findings,
      "semantics-unknown-class",
      "[semantics].class",
      `UnknownSemanticClass(${semantics.class}); supported semantic classes: ${SUPPORTED_SEMANTIC_CLASSES.join(", ")}.`,
      `Use one of: ${SUPPORTED_SEMANTIC_CLASSES.join(", ")}.`
    );
    return;
  }
}

function lintRequiredSemanticSurface(
  semantics: Semantics,
  findings: LintFinding[]
): void {
  if (semantics.class === undefined || !isSupportedSemanticClass(semantics.class)) return;

  const requirements = SEMANTIC_CLASS_REQUIREMENTS[semantics.class];
  for (const role of requirements.requiredRoles) {
    if (!(role in semantics.roles)) {
      fail(
        findings,
        "semantics-missing-required-role",
        `[semantics.roles].${role}`,
        `missing required role \`${role}\` for \`${semantics.class}\`.`,
        `Add [semantics.roles.${role}] with a source binding and typed fields.`
      );
    }
  }

  for (const name of requirements.requiredDerived) {
    if (!(name in semantics.derived)) {
      fail(
        findings,
        "semantics-missing-required-derived",
        `[semantics.derived].${name}`,
        `missing required derived observation \`${name}\` for \`${semantics.class}\`.`,
        `Add \`${name} = "<expression>"\` under [semantics.derived].`
      );
    }
  }
}

function lintDerivedExpressions(semantics: Semantics, findings: LintFinding[]): void {
  const derivedNames = new Set(Object.keys(semantics.derived));
  const graph = new Map<string, Set<string>>();

  for (const [name, source] of Object.entries(semantics.derived)) {
    const parsed = parseExpressionForLint(source);
    if (!parsed.ok) {
      fail(
        findings,
        "semantics-expression-parse-failed",
        `[semantics.derived].${name}`,
        `malformed semantic expression at byte ${parsed.span.start}: ${parsed.message}.`,
        "Fix the expression syntax; valid expressions use identifiers, dotted role fields, helper calls, arithmetic, comparisons, logical operators, and parentheses."
      );
      continue;
    }

    const deps = new Set<string>();
    for (const path of parsed.value.identifiers) {
      if (path.length === 1) {
        const ident = path[0]!;
        if (derivedNames.has(ident)) {
          deps.add(ident);
        } else {
          fail(
            findings,
            "semantics-unknown-identifier",
            `[semantics.derived].${name}`,
            `unknown semantic identifier \`${ident}\`.`,
            "Reference a previously declared derived observation or a role field like `position.debt_amount`."
          );
        }
      } else if (!roleFieldExists(semantics, path)) {
        fail(
          findings,
          "semantics-unknown-identifier",
          `[semantics.derived].${name}`,
          `unknown semantic identifier \`${path.join(".")}\`.`,
          "Declare the role field under [semantics.roles.<role>].fields or correct the expression path."
        );
      }
    }
    graph.set(name, deps);
  }

  const cycle = findCycle(graph);
  if (cycle.length > 0) {
    fail(
      findings,
      "semantics-derived-cycle",
      "[semantics.derived]",
      `DerivedObservationCycle(${cycle.join(" -> ")}).`,
      "Break the cycle by making at least one derived observation depend only on role fields or earlier acyclic derived values."
    );
  }
}

function lintInvariantExpressions(semantics: Semantics, findings: LintFinding[]): void {
  semantics.invariants.forEach((invariant, idx) => {
    const parsed = parseExpressionForLint(invariant.expr);
    if (!parsed.ok) {
      fail(
        findings,
        "semantics-expression-parse-failed",
        `[[semantics.invariants]][${idx}].expr`,
        `malformed semantic expression at byte ${parsed.span.start}: ${parsed.message}.`,
        "Fix the invariant expression syntax; it must parse to a boolean expression over derived observations and role fields."
      );
    }
  });
}

function roleFieldExists(semantics: Semantics, path: ExprPath): boolean {
  if (
    path.length === 3 &&
    semantics.roles[path[0]!] !== undefined &&
    semantics.oracles[path[0]!] !== undefined &&
    /^\d+$/.test(path[1]!) &&
    ["price", "confidence", "staleness"].includes(path[2]!)
  ) {
    return true;
  }
  if (
    path.length === 2 &&
    semantics.roles[path[0]!] !== undefined &&
    semantics.oracles[path[0]!] !== undefined &&
    ["weighted_price", "median_price"].includes(path[1]!)
  ) {
    return true;
  }
  if (path.length !== 2) return false;
  const [role, field] = path;
  if (role === undefined || field === undefined) return false;
  return semantics.roles[role]?.fields[field] !== undefined;
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

function findCycle(graph: Map<string, Set<string>>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (name: string): string[] | null => {
    if (visited.has(name)) return null;
    if (visiting.has(name)) {
      const start = stack.indexOf(name);
      return [...stack.slice(Math.max(start, 0)), name];
    }

    visiting.add(name);
    stack.push(name);
    const deps = [...(graph.get(name) ?? new Set<string>())].sort();
    for (const dep of deps) {
      if (!graph.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  };

  for (const name of [...graph.keys()].sort()) {
    const cycle = visit(name);
    if (cycle !== null) return cycle;
  }
  return [];
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
): { ok: true; value: ParsedExpression } | ({ ok: false } & LintExprError) {
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
  const identifiers: ExprPath[] = [];
  const parsed = parser.parseExpr(identifiers);
  if (!parsed.ok) return parsed;
  const trailing = parser.peek();
  if (trailing !== undefined) {
    return {
      ok: false,
      message: `trailing token \`${trailing.text}\``,
      span: { start: trailing.start, end: trailing.end },
    };
  }
  return { ok: true, value: { identifiers } };
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

  parseExpr(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    return this.parseOr(identifiers);
  }

  private parseOr(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseAnd(identifiers);
    if (!parsed.ok) return parsed;
    while (this.match("||")) {
      parsed = this.parseAnd(identifiers);
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseAnd(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseEquality(identifiers);
    if (!parsed.ok) return parsed;
    while (this.match("&&")) {
      parsed = this.parseEquality(identifiers);
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseEquality(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseComparison(identifiers);
    if (!parsed.ok) return parsed;
    while (this.match("==") || this.match("!=")) {
      parsed = this.parseComparison(identifiers);
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseComparison(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseAdd(identifiers);
    if (!parsed.ok) return parsed;
    while (this.match("<") || this.match("<=") || this.match(">") || this.match(">=")) {
      parsed = this.parseAdd(identifiers);
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseAdd(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseMul(identifiers);
    if (!parsed.ok) return parsed;
    while (this.match("+") || this.match("-")) {
      parsed = this.parseMul(identifiers);
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseMul(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    let parsed = this.parseUnary(identifiers);
    if (!parsed.ok) return parsed;
    while (this.match("*") || this.match("/")) {
      parsed = this.parseUnary(identifiers);
      if (!parsed.ok) return parsed;
    }
    return { ok: true };
  }

  private parseUnary(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
    if (this.match("!") || this.match("-")) {
      return this.parseUnary(identifiers);
    }
    return this.parsePrimary(identifiers);
  }

  private parsePrimary(identifiers: ExprPath[]): { ok: true } | ({ ok: false } & LintExprError) {
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
      const expr = this.parseExpr(identifiers);
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
        const arg = this.parseExpr(identifiers);
        if (!arg.ok) return arg;
        if (this.match(",")) continue;
        return this.expect(")", "`,` or `)` after helper argument");
      }
    }

    if (token.text === "true" || token.text === "false") return { ok: true };
    const path = [token.text];
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
      path.push(segment.text);
    }
    identifiers.push(path);
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
