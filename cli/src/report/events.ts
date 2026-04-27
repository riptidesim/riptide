import type { SimEvent } from "../compiler/schema.js";

export function formatProgramError(event: SimEvent): string | null {
  const error = event.program_error;
  if (!error) return null;
  if (error.label && error.interpretation) {
    return `${error.label} · code ${error.code} · ${error.interpretation}`;
  }
  return `Custom(${error.code})`;
}
