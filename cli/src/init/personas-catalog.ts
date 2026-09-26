// Protocol hints `riptide init` accepts and the one persona it can write
// for any program.

export type Protocol =
  | "amm"
  | "lending"
  | "perpetuals"
  | "liquid-staking"
  | "stablecoin"
  | "custom";

export const PROTOCOL_CHOICES: readonly Protocol[] = [
  "amm",
  "lending",
  "perpetuals",
  "liquid-staking",
  "stablecoin",
  "custom"
];

// The one persona `riptide init` can write for any program without
// knowing what the program is. Its action weights come from whatever
// instructions the adapter actually mapped, so it exercises the mapped
// surface evenly. Anything more opinionated (whales, liquidators, panic
// exits) needs protocol meaning and belongs to `/riptide-config`.
export const DEFAULT_ACTOR_PERSONA = {
  slug: "actor",
  label: "Generic actor",
  actionRateMultiplier: 1
} as const;
