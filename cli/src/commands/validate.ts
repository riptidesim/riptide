// `riptide validate <assessment-dir>` — the structural gate the Skill runs
// before it delivers anything. It recognises the output the directory holds:
// an Assessment (intact Engine Output, a schema-valid Assessment Context and
// every required assessment.md section), an Out-of-Scope Note or a Blocker
// Report (schema-valid, required sections, no risk surface).

import { stat } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { validateOutput } from "../assess/outputs.js";
import {
  errorEnvelope,
  oneLineMessage,
  renderEnvelope,
  resolveCommandIO,
  successEnvelope,
  type CommandError,
  type CommandIO
} from "../contract/index.js";

export interface ValidateOptions {
  json?: boolean;
}

export function createValidateCommand(deps: CommandIO = {}): Command {
  return new Command("validate")
    .description(
      "Check the Assessment, Out-of-Scope Note or Blocker Report in a directory before the Skill delivers it"
    )
    .argument(
      "<assessment-dir>",
      "Directory holding an Assessment, an Out-of-Scope Note or a Blocker Report"
    )
    .option("--json", "Emit the result as a command envelope", false)
    .action(async (dir: string, options: ValidateOptions) => {
      const exitCode = await runValidate(dir, options, deps);
      process.exit(exitCode);
    });
}

export async function runValidate(
  dir: string,
  options: ValidateOptions,
  deps: CommandIO = {}
): Promise<number> {
  const { stdout, stderr, cwd } = resolveCommandIO(deps);
  const label = path.relative(cwd, path.resolve(cwd, dir)) || ".";

  let problems: CommandError[];
  let kind: string | null = null;
  try {
    if (!(await isDirectory(path.resolve(cwd, dir)))) {
      problems = [
        {
          code: "validate_dir_not_found",
          message: `assessment directory ${label} not found`,
          next: "pass the directory `riptide assess --out` rendered the Engine Output into"
        }
      ];
    } else {
      const validation = await validateOutput(path.resolve(cwd, dir), label);
      if (validation.ok) {
        if (options.json) {
          stdout(
            renderEnvelope(
              successEnvelope("validate", { schema_version: "validate-cli.v1", ...validation.result })
            )
          );
        } else {
          stdout(`riptide validate: PASS ${label} (${validation.result.kind})\n`);
        }
        return 0;
      }
      problems = validation.problems;
      kind = validation.kind;
    }
  } catch (error) {
    const failure: CommandError = {
      code: "validate_failed",
      message: oneLineMessage(error instanceof Error ? error.message : String(error)),
      next: `check that ${label} and its files are readable, then rerun \`riptide validate ${label} --json\``
    };
    if (options.json) stdout(renderEnvelope(errorEnvelope("validate", failure)));
    else stderr(`riptide validate: ${failure.message}\n  next: ${failure.next}\n`);
    return 2;
  }

  if (options.json) {
    stdout(renderEnvelope(errorEnvelope("validate", problems[0]!, { assessment_dir: label, kind, problems })));
  } else {
    stderr(
      `riptide validate: FAIL ${label}\n` +
        problems.map((problem) => `  ✗ ${problem.code}: ${problem.message}\n    next: ${problem.next}\n`).join("")
    );
  }
  return 1;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
