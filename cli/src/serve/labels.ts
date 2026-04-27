export interface SemanticLabel {
  label: string;
  tooltip?: string;
  unit?: string;
}

export const SEMANTIC_LABELS: Record<string, SemanticLabel> = {
  "lending.v1.collateral_value": {
    label: "Collateral value",
    tooltip: "Position collateral amount priced by the oracle.",
    unit: "USD"
  },
  "lending.v1.debt_value": {
    label: "Debt value",
    tooltip: "Outstanding debt normalized to the lending semantic unit.",
    unit: "USD"
  },
  "lending.v1.health_factor": {
    label: "Health factor",
    tooltip: "Collateral value divided by debt value, guarded against zero debt.",
    unit: "ratio"
  },
  "lending.v1.max_borrow_value": {
    label: "Max borrow value",
    tooltip: "Collateral value multiplied by the reserve max LTV.",
    unit: "USD"
  },
  "lending.v1.liquidation_threshold_value": {
    label: "Liquidation threshold value",
    tooltip: "Collateral value at the reserve liquidation threshold.",
    unit: "USD"
  }
};

export function semanticLabelKey(semanticClass: string, observationName: string): string {
  return `${semanticClass}.${observationName}`;
}

export function labelForDerivedObservation(
  semanticClass: string | undefined,
  observationName: string
): SemanticLabel | undefined {
  if (!semanticClass) return undefined;
  return SEMANTIC_LABELS[semanticLabelKey(semanticClass, observationName)];
}
