export type ValidationStatus = "pass" | "warn" | "fail";

export interface ValidationResult {
  step: string;
  status: ValidationStatus;
  message: string;
  path?: string;
}

import { nextLineOf } from "../contract/index.js";

export type ReviewValidationErrorCode =
  | "review_unrecognized_root"
  | "review_artifact_not_found"
  | "review_artifact_malformed"
  | "review_artifact_schema_invalid"
  | "review_trace_malformed"
  | "review_no_retained_cases"
  | "review_retained_path_missing"
  | "review_case_digest_invalid"
  | "review_rerun_script_missing"
  | "review_rerun_script_invalid";

export class ReviewValidationError extends Error {
  readonly exitCode = 2 as const;
  /** Stable error code for the command error shape. */
  readonly code: ReviewValidationErrorCode;
  /** The recommended next action; defaults to the message's own `next:` line. */
  readonly next: string;

  constructor(message: string, code: ReviewValidationErrorCode, next?: string) {
    super(message);
    this.name = "ReviewValidationError";
    this.code = code;
    this.next = next ?? nextLineOf(message) ?? "fix the review input named in the message, then rerun review";
  }
}
