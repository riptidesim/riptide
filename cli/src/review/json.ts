import type { HashVerification } from "./hash.js";
import type { ReviewManifest, ValidationResult } from "./manifest.js";
import type { InvariantFire } from "./markdown.js";

export interface ReviewJsonPayloadInput {
  manifest: ReviewManifest;
  manifestDigest: string;
  validationResults: ValidationResult[];
  invariantFires: InvariantFire[];
  hash: HashVerification;
  warnings: string[];
}

export function buildReviewJsonPayload(input: ReviewJsonPayloadInput): Record<string, unknown> {
  const slug = typeof input.manifest.run_id === "string"
    ? input.manifest.run_id.replace(/^replay-/, "")
    : null;
  return {
    pack: {
      slug,
    },
    manifest: {
      digest: input.manifestDigest,
      run_id: input.manifest.run_id ?? null,
      scenario: input.manifest.scenario ?? null,
      canonical_hash: input.manifest.canonical_hash ?? null,
    },
    validation: input.validationResults,
    invariant_fires: input.invariantFires,
    hash: {
      ...input.hash,
      raw_sha256: input.hash.rawSha256,
    },
    warnings: input.warnings,
  };
}
