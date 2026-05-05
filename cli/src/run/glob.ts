// Scenario-name glob matcher for `riptide run <pattern>`.
//
// Jest-style ergonomics over strict minimatch: `riptide run '*shock*'`
// matches `perps/shock`, which strict minimatch would reject because `*`
// doesn't cross `/`. We deliberately loosen.
//
// - `?`  matches a single character (any, including `/`)
// - `*`  matches zero or more characters (any, including `/`)
// - `**` also matches zero or more characters — alias for `*`,
//        accepted for people typing the canonical form
// - `[abc]` / `[a-z]` character classes match one char
// - Every other character is a literal
//
// Implicit trailing match: a bare token like `whale-shock-grid` (no glob
// meta) matches BOTH the exact name `whale-shock-grid` AND any descendant
// `whale-shock-grid/...`. Mirrors jest's file-pattern ergonomics where
// `jest foo` matches every test whose name starts with `foo`.

const META_CHARS = /[*?[\]]/;

export function hasGlobMeta(pattern: string): boolean {
  return META_CHARS.test(pattern);
}

/**
 * Match `name` against `pattern`. Returns true on match.
 *
 * If `pattern` contains no glob metacharacters, the match is treated
 * as an implicit prefix match: `whale-shock-grid` matches `whale-shock-grid` and
 * `whale-shock-grid/w25-s40` but NOT `whale-shock-grid-extra`. The `/` boundary is
 * respected so a bare token can't accidentally match an unrelated
 * scenario whose name happens to start with the same string.
 */
export function matchScenarioName(name: string, pattern: string): boolean {
  if (!hasGlobMeta(pattern)) {
    if (name === pattern) return true;
    if (name.startsWith(pattern + "/")) return true;
    return false;
  }
  return new RegExp(`^${globToRegexBody(pattern)}$`).test(name);
}

export function filterScenariosByPattern<T extends { name: string }>(
  scenarios: T[],
  pattern: string
): T[] {
  return scenarios.filter((s) => matchScenarioName(s.name, pattern));
}

function globToRegexBody(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      // Consume any run of `*` as a single `.*` — both `*` and `**`
      // collapse to the same "match anything" semantics.
      while (pattern[i + 1] === "*") i += 1;
      out += ".*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += ".";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        // Unterminated class — treat literally. minimatch would error;
        // we degrade to literal so a stray bracket doesn't stop the run.
        out += escapeRegex(ch);
        i += 1;
        continue;
      }
      // Preserve the class contents verbatim (they are already valid
      // regex class syntax: `[a-z]`, `[!abc]`, etc.). The `!` -> `^`
      // negation swap matches minimatch convention.
      let body = pattern.slice(i + 1, end);
      if (body.startsWith("!")) {
        body = "^" + body.slice(1);
      }
      out += "[" + body + "]";
      i = end + 1;
      continue;
    }
    out += escapeRegex(ch);
    i += 1;
  }
  return out;
}

function escapeRegex(ch: string): string {
  return /[.+^$(){}|\\]/.test(ch) ? `\\${ch}` : ch;
}
