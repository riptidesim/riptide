export type ValidationStatus = "pass" | "warn" | "fail";

export interface ValidationResult {
  step: string;
  status: ValidationStatus;
  message: string;
  path?: string;
}

export class ReviewValidationError extends Error {
  readonly exitCode = 2 as const;
  /** Stable error code for the command error shape. */
  readonly code: string;
  /** The recommended next action; defaults to the message's own `next:` line. */
  readonly next: string;

  constructor(message: string, code: string, next?: string) {
    super(message);
    this.name = "ReviewValidationError";
    this.code = code;
    this.next =
      next ??
      message
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("next:"))
        ?.slice("next:".length)
        .trim() ??
      "fix the review input named in the message, then rerun review";
  }
}
