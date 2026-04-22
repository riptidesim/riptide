// Centralized message-first renderer for top-level CLI failures.
//
// Default surface is operator-readable: a one-line `riptide: <message>`
// followed by any structured hints (file / field / expected / actual /
// next step) the throwing site attached to the error. Stack traces are
// gated behind an explicit debug switch — operators see actionable
// guidance, contributors flip the switch when they need depth.
//
// Debug switch precedence:
//   1. RIPTIDE_DEBUG=1 → show stack
//   2. RIPTIDE_DEBUG=0 → hide stack (overrides anything else)
//   3. NODE_ENV=test  → hide stack (keep test output clean)
//   4. default        → hide stack
//
// The renderer is intentionally pure: it takes the error, the env, and
// optionally a colorizer, and returns a string. The CLI entrypoint
// writes the string to stderr.

import { COLORIZED, PLAIN, type Colorizer } from "../display/index.js";

export interface RenderOptions {
  env?: NodeJS.ProcessEnv;
  /** Force color on/off; default infers from TTY + NO_COLOR/FORCE_COLOR. */
  color?: boolean;
  /** Stream the output will hit (only used to seed the default color decision). */
  isTTY?: boolean;
}

/**
 * Inspect the env to decide whether to dump a stack trace alongside the
 * message. Default is OFF — operators should not have to read a Node
 * stack to understand a missing-adapter error.
 */
export function shouldShowStack(env: NodeJS.ProcessEnv): boolean {
  const v = env.RIPTIDE_DEBUG;
  if (v === undefined) return false;
  // Treat any non-empty, non-"0", non-"false" value as "on". Mirrors
  // the loose truthy convention familiar from CI env switches.
  if (v === "" || v === "0" || v.toLowerCase() === "false") return false;
  return true;
}

/**
 * Render a thrown error for top-level CLI failure surfaces.
 *
 * - Default: `riptide: <message>` (stripping any leading `Error:` noise),
 *   then any extra lines the throwing site embedded in the message.
 * - Debug: full stack trace appended after the message block.
 * - Non-Error throws are stringified safely (never `[object Object]`).
 */
export function renderCliError(err: unknown, opts: RenderOptions = {}): string {
  const env = opts.env ?? process.env;
  const colorize = pickColorizer(opts);

  const debug = shouldShowStack(env);

  const message = extractMessage(err);
  const stack = debug ? extractStack(err) : undefined;

  const lines: string[] = [];
  // First line: `riptide: <one-line summary>`. Multi-line messages
  // (already common for engine binary failures + replay-config errors)
  // keep their structure so file/field/expected/actual/hint lines line
  // up under the prefix.
  const messageLines = message.split("\n");
  const head = messageLines[0] ?? "";
  lines.push(`${colorize.red("riptide:")} ${head}`);
  for (const tail of messageLines.slice(1)) {
    lines.push(tail);
  }

  if (stack) {
    lines.push("");
    lines.push(colorize.dim("--- stack trace (RIPTIDE_DEBUG) ---"));
    lines.push(colorize.dim(stack));
  } else {
    // Quiet-default hint: tell the user how to opt into the stack the
    // first time they hit an error. One short line, dimmed.
    lines.push(colorize.dim("(set RIPTIDE_DEBUG=1 for the full stack trace)"));
  }

  return lines.join("\n") + "\n";
}

function pickColorizer(opts: RenderOptions): Colorizer {
  if (opts.color === true) return COLORIZED;
  if (opts.color === false) return PLAIN;
  const env = opts.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return PLAIN;
  if (env.FORCE_COLOR === "0") return PLAIN;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return COLORIZED;
  return opts.isTTY ? COLORIZED : PLAIN;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    // Node sometimes attaches `Error: ` to .toString(); .message is the
    // already-clean version. Defensive trim handles strange custom
    // subclasses that override .message to a non-string.
    const m = typeof err.message === "string" ? err.message : String(err);
    return m.length > 0 ? m : "(error with empty message)";
  }
  if (err === null) return "(null thrown)";
  if (err === undefined) return "(undefined thrown)";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "symbol") {
    // `String(Symbol("x"))` → `"Symbol(x)"`. JSON.stringify would
    // return undefined here, so the object branch below would
    // misfire — handle symbols before we ever touch JSON.
    return `(Symbol thrown: ${String(err)})`;
  }
  if (typeof err === "function") {
    // JSON.stringify also returns undefined for functions. Name the
    // function when we can; otherwise report anonymously.
    const name = (err as { name?: unknown }).name;
    return `(function thrown: ${typeof name === "string" && name.length > 0 ? name : "anonymous"})`;
  }
  // Object / array / etc. — defensively JSON-stringify so we never emit
  // `[object Object]` from the top-level catch path.
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(err);
  } catch {
    // JSON.stringify throws on cyclic structures. Fall through to the
    // hand-rolled best-effort below.
    serialized = undefined;
  }
  if (typeof serialized === "string" && serialized.length > 0) {
    return serialized;
  }
  // `JSON.stringify` returns `undefined` (not throws) for values whose
  // only serializable pieces collapse — e.g. an object whose own
  // properties are all symbols, a toJSON() that returns undefined, or
  // nested unserializables. Same fallback path as the cyclic case:
  // class name + own-property keys so an operator still gets a toehold.
  return describeOpaqueThrow(err);
}

function describeOpaqueThrow(err: unknown): string {
  const className =
    err !== null && typeof err === "object"
      ? (err.constructor && typeof err.constructor.name === "string"
          ? err.constructor.name
          : "Object")
      : typeof err;
  let keyPart = "";
  if (err !== null && typeof err === "object") {
    try {
      const keys = Object.keys(err as Record<string, unknown>).slice(0, 4);
      if (keys.length > 0) {
        keyPart = ` with keys [${keys.join(", ")}]`;
      }
    } catch {
      // Proxies / frozen exotic objects may refuse Object.keys; swallow.
    }
  }
  return `(non-serializable ${className} thrown${keyPart} — set RIPTIDE_DEBUG=1 for the stack)`;
}

function extractStack(err: unknown): string | undefined {
  if (err instanceof Error && typeof err.stack === "string") {
    return err.stack;
  }
  return undefined;
}
