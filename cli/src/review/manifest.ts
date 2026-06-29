export type ValidationStatus = "pass" | "warn" | "fail";

export interface ValidationResult {
  step: string;
  status: ValidationStatus;
  message: string;
  path?: string;
}

export class ReviewValidationError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}
