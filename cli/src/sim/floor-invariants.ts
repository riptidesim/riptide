// The Floor Invariants: the invariants the family library requires in every
// Assessment of a protocol shape, one set per family plus the generic Economic
// Protocol fallback. `sim generate` wires them into the sim crate, and
// `riptide validate` checks that the Assessment Context reports every one.
// Each expression reads only the derived observations the family's semantic
// class requires, so a class-valid adapter can always evaluate it.

import type { Adapter, SemanticClass } from "../schemas/adapter.js";

export const FAMILIES = ["lending", "amm", "perps", "lst", "stablecoin", "generic"] as const;
export type Family = (typeof FAMILIES)[number];

export interface FloorInvariant {
  id: string;
  expr: string;
  description: string;
}

export const FLOOR_INVARIANTS: Record<Family, readonly FloorInvariant[]> = {
  lending: [
    {
      id: "debt_below_collateral",
      expr: "debt_value <= collateral_value",
      description: "Position debt never exceeds its collateral value"
    },
    {
      id: "debt_below_max_borrow",
      expr: "debt_value <= max_borrow_value",
      description: "Position debt never exceeds its max-borrow value"
    }
  ],
  amm: [
    {
      id: "constant_product_positive",
      expr: "liquidity_value == 0 || constant_product > 0",
      description: "A pool holding liquidity never drains either reserve to zero"
    }
  ],
  perps: [
    {
      id: "equity_above_maintenance",
      expr: "account_equity >= maintenance_margin_requirement",
      description: "Account equity stays at or above the maintenance margin requirement"
    }
  ],
  lst: [
    {
      id: "lst_supply_backed",
      expr: "lst_supply * exchange_rate <= total_assets * 10000",
      description: "LST supply at the posted exchange rate (in bps) is covered by pooled assets"
    }
  ],
  stablecoin: [
    {
      id: "collateral_covers_liabilities",
      expr: "collateral_value >= liability_value",
      description: "Collateral value covers the issued stablecoin liabilities"
    }
  ],
  generic: [
    {
      id: "supply_covers_balances",
      expr: "source_balance + destination_balance <= mint_supply",
      description: "Token balances the protocol moves never exceed the mint supply"
    }
  ]
};

/** The semantic class whose required derived observations a family's Floor Invariants read. */
export const FAMILY_CLASS: Record<Family, SemanticClass> = {
  lending: "lending.v1",
  amm: "amm.v1",
  perps: "perps-margin.v1",
  lst: "lst.v1",
  stablecoin: "stablecoin.v1",
  generic: "token.v1"
};

/** The family an adapter's `[semantics].class` names; no class, or `token.v1`, is the generic fallback. */
export function familyOf(adapter: Adapter): Family {
  const semanticClass = adapter.semantics?.class;
  const family = FAMILIES.find((candidate) => FAMILY_CLASS[candidate] === semanticClass);
  return family ?? "generic";
}

export function isFloorInvariant(family: Family, id: string): boolean {
  return FLOOR_INVARIANTS[family].some((floor) => floor.id === id);
}

export interface WiredFloorInvariant {
  id: string;
  /** False when the adapter declares no `[semantics]` block of the family's class to evaluate it against. */
  wired: boolean;
  /** The expression the sim checks: the adapter's own when it declares an invariant with this ID. */
  expr: string;
}

/** How `sim generate` wires each of the family's Floor Invariants into an adapter's sim. */
export function wireFloorInvariants(adapter: Adapter): { family: Family; floors: WiredFloorInvariant[] } {
  const family = familyOf(adapter);
  const semantics = adapter.semantics;
  const wired = semantics?.class === FAMILY_CLASS[family];
  const floors = FLOOR_INVARIANTS[family].map((floor) => {
    const declared = semantics?.invariants.find((invariant) => invariant.name === floor.id);
    return { id: floor.id, wired, expr: declared?.expr ?? floor.expr };
  });
  return { family, floors };
}
