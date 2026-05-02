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
  },
  "amm.v1.spot_price": {
    label: "Spot price",
    tooltip: "Fixture-reported last swap price used as the AMM spot-price proxy.",
    unit: "ratio"
  },
  "amm.v1.liquidity_value": {
    label: "Liquidity value",
    tooltip: "Total value proxy across both reserves.",
    unit: "units"
  },
  "amm.v1.lp_share_value": {
    label: "LP share value",
    tooltip: "Liquidity value divided by total LP supply.",
    unit: "units/share"
  },
  "amm.v1.reserve_ratio": {
    label: "Reserve ratio",
    tooltip: "Reserve A divided by reserve B, guarded against zero reserve B.",
    unit: "ratio"
  },
  "amm.v1.constant_product": {
    label: "Constant product",
    tooltip: "Reserve A multiplied by reserve B.",
    unit: "k"
  },
  "amm.v1.price_impact_bps": {
    label: "Price impact",
    tooltip: "Fixture-level price impact proxy in basis points.",
    unit: "bps"
  },
  "perps-margin.v1.account_equity": {
    label: "Account equity",
    tooltip: "Collateral plus unrealized PnL proxy for the margin account.",
    unit: "USD"
  },
  "perps-margin.v1.unrealized_pnl": {
    label: "Unrealized PnL",
    tooltip: "Position PnL proxy from available fixture position fields.",
    unit: "USD"
  },
  "perps-margin.v1.initial_margin_requirement": {
    label: "Initial margin requirement",
    tooltip: "Notional divided by max leverage.",
    unit: "USD"
  },
  "perps-margin.v1.maintenance_margin_requirement": {
    label: "Maintenance margin requirement",
    tooltip: "Notional scaled by the liquidation threshold.",
    unit: "USD"
  },
  "perps-margin.v1.margin_ratio": {
    label: "Margin ratio",
    tooltip: "Account equity divided by notional, guarded against zero notional.",
    unit: "bps"
  },
  "perps-margin.v1.liquidation_buffer": {
    label: "Liquidation buffer",
    tooltip: "Equity remaining above the maintenance margin requirement.",
    unit: "USD"
  },
  "perps-margin.v1.funding_payment": {
    label: "Funding payment",
    tooltip: "Smoke-grade funding proxy from fixture fields.",
    unit: "USD"
  },
  "perps-margin.v1.insurance_coverage": {
    label: "Insurance coverage",
    tooltip: "Fixture-level insurance coverage proxy.",
    unit: "USD"
  },
  "lst.v1.total_assets": {
    label: "Total assets",
    tooltip: "Underlying assets held by the liquid-staking pool.",
    unit: "tokens"
  },
  "lst.v1.lst_supply": {
    label: "LST supply",
    tooltip: "Liquid-staking token supply.",
    unit: "tokens"
  },
  "lst.v1.exchange_rate": {
    label: "Exchange rate",
    tooltip: "Underlying assets per LST, expressed from exchange-rate bps.",
    unit: "bps"
  },
  "lst.v1.reserve_buffer": {
    label: "Reserve buffer",
    tooltip: "Liquid reserve available for unstake claims.",
    unit: "tokens"
  },
  "lst.v1.withdrawal_queue_pressure": {
    label: "Withdrawal queue pressure",
    tooltip: "Pending unstake assets relative to total assets.",
    unit: "bps"
  },
  "lst.v1.claim_coverage_ratio": {
    label: "Claim coverage ratio",
    tooltip: "Reserve buffer relative to pending unstake assets.",
    unit: "bps"
  },
  "lst.v1.slash_loss_bps": {
    label: "Slash loss",
    tooltip: "Cumulative slashed assets relative to total assets.",
    unit: "bps"
  },
  "stablecoin.v1.collateral_value": {
    label: "Collateral value",
    tooltip: "Collateral assets backing the stablecoin supply.",
    unit: "USD"
  },
  "stablecoin.v1.liability_value": {
    label: "Liability value",
    tooltip: "Outstanding stablecoin supply treated as liabilities.",
    unit: "USD"
  },
  "stablecoin.v1.backing_ratio": {
    label: "Backing ratio",
    tooltip: "Collateral value divided by liability value.",
    unit: "bps"
  },
  "stablecoin.v1.collateralization_ratio": {
    label: "Collateralization ratio",
    tooltip: "Fixture-reported effective collateral ratio.",
    unit: "bps"
  },
  "stablecoin.v1.redemption_pressure": {
    label: "Redemption pressure",
    tooltip: "Pending redemption assets relative to stablecoin liabilities.",
    unit: "bps"
  },
  "stablecoin.v1.redemption_coverage_ratio": {
    label: "Redemption coverage ratio",
    tooltip: "Reserve buffer relative to pending redemption assets.",
    unit: "bps"
  },
  "stablecoin.v1.peg_deviation_bps": {
    label: "Peg deviation",
    tooltip: "Deviation from full backing, measured in basis points.",
    unit: "bps"
  },
  "stablecoin.v1.hedge_gap_value": {
    label: "Hedge gap value",
    tooltip: "Program-local hedge loss proxy from the shipped fixture.",
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
