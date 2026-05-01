// Persona catalog for the `riptide init` wizard.
//
// Each protocol has its own protocol-specific personas (action vocab
// matches the engine's path: deposit/borrow for lending,
// add_liquidity/swap for AMM, stake/unstake for liquid staking, etc.).
// On top of that, every protocol surfaces a shared GENERIC pool —
// archetypes that live under fixtures/personas/ root and read as
// generic-enough that users frequently want them as starting points
// regardless of protocol. The wizard merges both lists (deduped by
// slug, protocol-specific labels win) so e.g. picking "lending" still
// shows liquidator, leveraged-long, sandwich-attacker, etc., even
// though their action vocab is perp/AMM-flavored — the user can edit
// the action_weights to match their adapter.
//
// Files ship under cli/assets/init-personas/<bucket>/<slug>.toml and
// ride along with the npm package via the `assets` files entry.

import { fileURLToPath } from "node:url";
import path from "node:path";

export type Protocol =
  | "amm"
  | "lending"
  | "perpetuals"
  | "liquid-staking"
  | "stablecoin"
  | "custom";

export interface ProtocolChoice {
  value: Protocol;
  label: string;
}

export const PROTOCOL_CHOICES: ProtocolChoice[] = [
  { value: "amm", label: "AMM / DEX" },
  { value: "lending", label: "Lending" },
  { value: "perpetuals", label: "Perpetuals" },
  { value: "liquid-staking", label: "Liquid staking" },
  { value: "stablecoin", label: "Stablecoin" },
  { value: "custom", label: "Custom (generic)" }
];

export interface PersonaChoice {
  slug: string;
  label: string;
}

// Cross-protocol archetypes available under every protocol bucket.
// Files live under cli/assets/init-personas/custom/<slug>.toml; the
// path resolver falls back to `custom/` whenever a protocol-specific
// copy is absent.
const GENERIC_PERSONAS: PersonaChoice[] = [
  { slug: "swapper", label: "Vanilla swapper" },
  { slug: "arbitrageur", label: "Arbitrageur" },
  { slug: "lp-provider", label: "Liquidity provider" },
  { slug: "sandwich-attacker", label: "Sandwich attacker (approximate)" },
  { slug: "rug-puller", label: "Rug-puller (opportunistic exit)" },
  { slug: "leveraged-long", label: "Leveraged long" },
  { slug: "leveraged-short", label: "Leveraged short" },
  { slug: "delta-neutral-farmer", label: "Delta-neutral farmer" },
  { slug: "funding-arbitrageur", label: "Funding arbitrageur (proxy)" },
  { slug: "liquidator", label: "Liquidator" },
  { slug: "whale", label: "Whale" }
];

const PROTOCOL_SPECIFIC: Record<Protocol, PersonaChoice[]> = {
  amm: [
    { slug: "swapper", label: "Vanilla swapper (A→B)" },
    { slug: "arbitrageur", label: "Arbitrageur (one-sided swapper)" },
    { slug: "lp-provider", label: "Liquidity provider" },
    { slug: "sandwich-attacker", label: "Sandwich attacker (approximate)" },
    { slug: "rug-puller", label: "Rug-puller (opportunistic LP exit)" }
  ],
  lending: [
    { slug: "steady-lp", label: "Steady LP (long-tail supplier)" },
    { slug: "cautious-yield-farmer", label: "Cautious yield farmer" },
    { slug: "degen-borrower", label: "Degen borrower" },
    { slug: "aggressive-arb-bot", label: "Aggressive arb bot" },
    { slug: "panic-whale", label: "Panic whale (mass withdraw)" },
    { slug: "whale", label: "Whale (outsized borrow)" }
  ],
  perpetuals: [
    { slug: "leveraged-long", label: "Leveraged long" },
    { slug: "leveraged-short", label: "Leveraged short" },
    { slug: "delta-neutral-farmer", label: "Delta-neutral farmer" },
    { slug: "funding-arbitrageur", label: "Funding arbitrageur (proxy)" },
    { slug: "liquidator", label: "Liquidator" }
  ],
  "liquid-staking": [
    { slug: "steady-staker", label: "Steady staker" },
    { slug: "yield-maxi", label: "Yield maximizer" },
    { slug: "panic-exiter", label: "Panic exiter" },
    { slug: "arb-redeemer", label: "Arb redeemer" }
  ],
  stablecoin: [
    { slug: "cautious-minter", label: "Cautious minter" },
    { slug: "leverage-looper", label: "Leverage looper" },
    { slug: "panic-redeemer", label: "Panic redeemer" },
    { slug: "arb-redeemer", label: "Arb redeemer" }
  ],
  custom: []
};

// Returns protocol-specific archetypes followed by any generic
// archetypes the protocol bucket doesn't already cover (deduped by
// slug — protocol-specific labels win because they tend to be more
// precise about the action-vocab variant).
export function personaChoicesFor(protocol: Protocol): PersonaChoice[] {
  const specific = PROTOCOL_SPECIFIC[protocol] ?? [];
  const seen = new Set(specific.map((choice) => choice.slug));
  const merged = [...specific];
  for (const generic of GENERIC_PERSONAS) {
    if (!seen.has(generic.slug)) {
      merged.push(generic);
      seen.add(generic.slug);
    }
  }
  return merged;
}

// How many of the choices returned by `personaChoicesFor(protocol)`
// are protocol-specific (the rest are generics). The wizard uses this
// to insert a visual separator between the two groups.
export function protocolSpecificCount(protocol: Protocol): number {
  return (PROTOCOL_SPECIFIC[protocol] ?? []).length;
}

// Probe candidate asset roots, mirroring the pattern in cli/src/serve/index.ts.
// Layouts: built (cli/dist/src/init/personas-catalog.js → ../../assets) and
// source (cli/src/init/personas-catalog.ts → ../../assets, or one level
// deeper depending on tsx vs npm-published). Caller picks the first that
// exists.
export function personaAssetCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, "..", "..", "..", "assets", "init-personas"),
    path.resolve(here, "..", "..", "assets", "init-personas"),
    path.resolve(here, "..", "assets", "init-personas")
  ];
}

// Lookup precedence: protocol-specific bucket first, then generic
// `custom/` bucket as a fallback. Lets the catalog surface a generic
// persona under every protocol without duplicating the .toml file.
export function personaPathCandidates(protocol: Protocol, slug: string): string[] {
  const roots = personaAssetCandidates();
  const buckets = protocol === "custom" ? ["custom"] : [protocol, "custom"];
  const out: string[] = [];
  for (const root of roots) {
    for (const bucket of buckets) {
      out.push(path.join(root, bucket, `${slug}.toml`));
    }
  }
  return out;
}
