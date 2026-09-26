// The uniform IO contract every Engine command runner follows.
//
// Runners never write to the process directly: they take their streams
// (and working directory) through `CommandIO`, so the Skill and the test
// suite drive them the same way. In `--json` mode a runner writes exactly
// one envelope to stdout — `SuccessEnvelope` or `ErrorEnvelope` — and
// signals the outcome through its exit code as well. See
// docs/architecture.md § "Engine command contract".

import path from "node:path";

export interface CommandIO {
  stdoutWrite?: (chunk: string) => void;
  stderrWrite?: (chunk: string) => void;
  cwd?: string;
}

export interface ResolvedCommandIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  cwd: string;
  /** True when the caller supplied either stream, so child processes must be piped, not inherited. */
  injected: boolean;
}

export function resolveCommandIO(io: CommandIO = {}): ResolvedCommandIO {
  return {
    stdout: io.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk)),
    stderr: io.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk)),
    cwd: path.resolve(io.cwd ?? process.cwd()),
    injected: io.stdoutWrite !== undefined || io.stderrWrite !== undefined
  };
}

export const COMMAND_ENVELOPE_SCHEMA_VERSION = "riptide-command.v1";

/** A failure the Skill can act on: a stable `code`, a one-line `message`, and the recommended `next` action. */
export interface CommandError {
  code: string;
  message: string;
  next: string;
}

export interface SuccessEnvelope<T> {
  schema_version: typeof COMMAND_ENVELOPE_SCHEMA_VERSION;
  command: string;
  ok: true;
  data: T;
}

export interface ErrorEnvelope<T = never> {
  schema_version: typeof COMMAND_ENVELOPE_SCHEMA_VERSION;
  command: string;
  ok: false;
  error: CommandError;
  /** Whatever partial result the command still produced, when it helps the caller repair. */
  data?: T;
}

export function successEnvelope<T>(command: string, data: T): SuccessEnvelope<T> {
  return { schema_version: COMMAND_ENVELOPE_SCHEMA_VERSION, command, ok: true, data };
}

export function errorEnvelope<T = never>(
  command: string,
  error: CommandError,
  data?: T
): ErrorEnvelope<T> {
  return {
    schema_version: COMMAND_ENVELOPE_SCHEMA_VERSION,
    command,
    ok: false,
    error,
    ...(data === undefined ? {} : { data })
  };
}

export function renderEnvelope(envelope: SuccessEnvelope<unknown> | ErrorEnvelope<unknown>): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}
