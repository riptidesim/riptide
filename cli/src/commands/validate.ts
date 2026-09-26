// `riptide validate <assessment-dir>` — the structural gate the Skill runs
// before it declares an Assessment complete: the Engine Output is intact, the
// Assessment Context sidecar is schema-valid, and the composed assessment.md
// carries every required section.

import { stat } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { validateAssessment } from "../assess/context.js";
import {
  errorEnvelope,
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
      "Check an Assessment directory: intact Engine Output, a schema-valid Assessment Context and the required assessment.md sections"
    )
    .argument("<assessment-dir>", "Directory holding assessment.json, assessment-context.json and assessment.md")
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
      const validation = await validateAssessment(path.resolve(cwd, dir), label);
      if (validation.ok) {
        if (options.json) {
          stdout(
            renderEnvelope(
              successEnvelope("validate", { schema_version: "validate-cli.v1", ...validation.result })
            )
          );
        } else {
          stdout(`riptide validate: PASS ${label}\n`);
        }
        return 0;
      }
      problems = validation.problems;
    }
  } catch (error) {
    const failure: CommandError = {
      code: "validate_failed",
      message: error instanceof Error ? error.message : String(error),
      next: `check that ${label} and its files are readable, then rerun \`riptide validate ${label} --json\``
    };
    if (options.json) stdout(renderEnvelope(errorEnvelope("validate", failure)));
    else stderr(`riptide validate: ${failure.message}\n  next: ${failure.next}\n`);
    return 2;
  }

  if (options.json) {
    stdout(renderEnvelope(errorEnvelope("validate", problems[0]!, { assessment_dir: label, problems })));
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
