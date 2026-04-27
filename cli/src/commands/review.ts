// `riptide review <pack>` — read-only evidence-pack reviewer surface.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Command } from "commander";

import { renderCliError } from "../errors/render.js";
import { verifyCanonicalHash } from "../review/hash.js";
import { buildReviewJsonPayload } from "../review/json.js";
import { buildReviewMarkdown, collectInvariantFires } from "../review/markdown.js";
import { loadPackManifest, ReviewValidationError, type ValidationResult } from "../review/manifest.js";
import { printBanner } from "../banner.js";

const execFileAsync = promisify(execFile);

export interface ReviewOptions {
  out?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface ReviewCommandDeps {
  stdoutWrite?: (chunk: string) => void;
  stderrWrite?: (chunk: string) => void;
  cwd?: string;
  color?: boolean;
}

export function createReviewCommand(deps: ReviewCommandDeps = {}): Command {
  return new Command("review")
    .description("Validate a Riptide evidence pack, verify its canonical hash, and emit reviewer markdown")
    .argument("<pack>", "Path to a Riptide evidence pack directory")
    .option("--out <md-path>", "Write reviewer markdown to a file instead of stdout")
    .option("--json", "Emit a structured JSON review payload", false)
    .option("--quiet", "Suppress interactive banner", false)
    .action(async (pack: string, options: ReviewOptions) => {
      printBanner({ flags: { json: Boolean(options.json), quiet: Boolean(options.quiet) } });
      const exitCode = await runReview(pack, options, deps);
      process.exit(exitCode);
    });
}

export async function runReview(
  pack: string,
  options: ReviewOptions,
  deps: ReviewCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));

  try {
    const packData = await loadPackManifest(pack);
    const validationResults: ValidationResult[] = [...packData.validationResults];
    const warnings: string[] = [];

    const { result: simulationResult, verification } = await verifyCanonicalHash(
      packData.manifest,
      packData.simulationResultPath,
      validationResults
    );

    const rerunPath = path.join(packData.packRoot, "rerun.sh");
    await validateRerunScript(rerunPath, validationResults);

    const provenancePath = path.join(packData.packRoot, "provenance.json");
    let provenance: Record<string, unknown> | undefined;
    if (existsSync(provenancePath)) {
      provenance = await readOptionalJson(provenancePath);
      validationResults.push({
        step: "provenance",
        status: "pass",
        message: "provenance.json present",
        path: provenancePath,
      });
    } else if (!manifestHasProofMetadata(packData.manifest)) {
      const message = "provenance.json missing and manifest has no proof metadata; omitting proof-level badge";
      warnings.push(message);
      validationResults.push({
        step: "provenance",
        status: "warn",
        message,
        path: provenancePath,
      });
    }

    const invariantFires = collectInvariantFires(simulationResult);
    const markdown = buildReviewMarkdown({
      packRoot: packData.packRoot,
      manifest: packData.manifest,
      provenance,
      simulationResult,
      hash: verification,
      rerunPath,
    });

    if (options.json) {
      stdout(
        JSON.stringify(
          buildReviewJsonPayload({
            manifest: packData.manifest,
            manifestDigest: sha256(Buffer.from(packData.manifestRaw, "utf8")),
            validationResults,
            invariantFires,
            hash: verification,
            warnings,
          }),
          null,
          2
        ) + "\n"
      );
    } else if (typeof options.out === "string" && options.out.length > 0) {
      const outPath = path.resolve(deps.cwd ?? process.cwd(), options.out);
      await writeFile(outPath, markdown, "utf8");
      stdout(`wrote review markdown: ${outPath}\n`);
    } else {
      stdout(markdown);
    }

    return warnings.length > 0 ? 1 : 0;
  } catch (error) {
    const exitCode = error instanceof ReviewValidationError ? error.exitCode : 2;
    stderr(
      renderCliError(error, {
        env: process.env,
        color: deps.color,
        isTTY: Boolean(process.stderr.isTTY),
      })
    );
    return exitCode;
  }
}

async function validateRerunScript(
  rerunPath: string,
  validationResults: ValidationResult[]
): Promise<void> {
  if (!existsSync(rerunPath)) {
    throw new ReviewValidationError(
      `rerun.sh not found\n  expected: ${rerunPath}\n  next: restore the pack rerun recipe before review`
    );
  }
  try {
    await execFileAsync("sh", ["-n", rerunPath]);
  } catch (error) {
    throw new ReviewValidationError(
      `rerun.sh failed POSIX syntax check\n  path: ${rerunPath}\n  reason: ${errorMessage(error)}\n  next: fix shell syntax; review never executes rerun.sh`
    );
  }
  validationResults.push({
    step: "rerun-sh",
    status: "pass",
    message: "rerun.sh is present and sh -n parseable",
    path: rerunPath,
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestHasProofMetadata(manifest: Record<string, unknown>): boolean {
  if (typeof manifest.proof_level === "number") return true;
  const proofLevel = manifest.proof_level;
  if (proofLevel && typeof proofLevel === "object" && !Array.isArray(proofLevel)) {
    return typeof (proofLevel as Record<string, unknown>).level === "number";
  }
  const proof = manifest.proof;
  if (proof && typeof proof === "object" && !Array.isArray(proof)) {
    return typeof (proof as Record<string, unknown>).level === "number";
  }
  return false;
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ReviewValidationError(
      `malformed provenance.json\n  path: ${filePath}\n  parse error: ${errorMessage(error)}\n  next: fix or remove optional provenance.json before review`
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
