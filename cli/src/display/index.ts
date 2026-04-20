// Display helpers: colors + path normalization for the `riptide run` UX.
//
// Kept dep-free — the color primitives are small enough ANSI snippets
// that pulling `picocolors` (or any 3rd-party dep) isn't worth it. A
// single environment check decides whether to emit escape codes or
// plain strings: TTY + !NO_COLOR + !FORCE_COLOR=0 → colored. Callers
// pass the decision in via `useColor` so tests can pin both paths
// without monkey-patching globals.
//
// Path normalization relativizes a displayed path against a cwd when
// the target is inside that cwd. Outside-cwd targets pass through
// unchanged — `/etc/hosts` stays `/etc/hosts`, not `../../../etc/hosts`
// which would be more confusing than useful.

import path from "node:path";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

export interface Colorizer {
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
}

function wrap(code: string): (s: string) => string {
  return (s) => `${ESC}${code}m${s}${RESET}`;
}

function identity(s: string): string {
  return s;
}

export const COLORIZED: Colorizer = Object.freeze({
  green: wrap("32"),
  red: wrap("31"),
  yellow: wrap("33"),
  cyan: wrap("36"),
  gray: wrap("90"),
  bold: wrap("1"),
  dim: wrap("2")
});

export const PLAIN: Colorizer = Object.freeze({
  green: identity,
  red: identity,
  yellow: identity,
  cyan: identity,
  gray: identity,
  bold: identity,
  dim: identity
});

/**
 * Decide whether to emit ANSI color codes.
 *
 * Priority order (first match wins):
 *   1. `FORCE_COLOR=0` OR `NO_COLOR` set (any non-empty value) → false
 *   2. `FORCE_COLOR=1|2|3` → true (CI / pipe-to-less / etc.)
 *   3. `isTTY` → true
 *   4. default → false
 */
export function shouldUseColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return Boolean(isTTY);
}

export function pickColorizer(useColor: boolean): Colorizer {
  return useColor ? COLORIZED : PLAIN;
}

/**
 * Convert an absolute (or messy) path to a CWD-relative one when the
 * target lives inside `cwd`. Outside-cwd targets pass through unchanged.
 * Non-path inputs that happen to look like paths (dots, tildes) are
 * returned as-is — we only rewrite when the lexical relationship is
 * unambiguous.
 */
export function relativizePath(p: string, cwd: string): string {
  if (!p) return p;
  // Skip strings that don't look like absolute paths at all.
  if (!p.startsWith("/") && !p.match(/^[A-Za-z]:[\\/]/)) return p;
  const abs = path.resolve(p);
  const rel = path.relative(cwd, abs);
  if (rel === "" || rel === ".") return ".";
  if (rel.startsWith("..")) return p;
  return rel;
}

/**
 * Scan a block of engine stderr and rewrite every absolute path that
 * lives inside `cwd` to a CWD-relative form. Paths outside cwd pass
 * through. We match unix + windows path shapes conservatively; false
 * positives here are cosmetic only (they rewrite a path that wasn't
 * a path, which the user still reads fine).
 */
const PATH_LIKE = /\/[^\s:"',()\[\]<>]+|[A-Za-z]:[\\/][^\s:"',()\[\]<>]+/g;

export function relativizePathsInBlob(blob: string, cwd: string): string {
  if (!blob) return blob;
  const resolvedCwd = path.resolve(cwd);
  return blob.replace(PATH_LIKE, (match) => {
    try {
      // Only rewrite absolute paths inside cwd. Leave relative paths,
      // URLs, and out-of-cwd absolute paths untouched.
      if (!match.startsWith("/") && !match.match(/^[A-Za-z]:[\\/]/)) {
        return match;
      }
      const abs = path.resolve(match);
      if (!abs.startsWith(resolvedCwd + path.sep) && abs !== resolvedCwd) {
        return match;
      }
      const rel = path.relative(resolvedCwd, abs);
      if (!rel || rel.startsWith("..")) return match;
      return rel;
    } catch {
      return match;
    }
  });
}
