export const DEFAULT_INIT_SEEDS = 50;
export const SINGLE_RUN_SEED = 1337;

export type InitHarnessMode = "none" | "generate" | "todo";

export function shouldScaffoldHarness(mode: InitHarnessMode | undefined): boolean {
  return mode === "generate" || mode === "todo";
}

export function defaultHarnessModeForProtocol(protocol: string): InitHarnessMode {
  return protocol === "lending" ? "none" : "todo";
}

export function seedForSeedCount(seeds: number | undefined): number | undefined {
  return seeds === 1 ? SINGLE_RUN_SEED : undefined;
}

export function resolveSeedCount(seeds: number | undefined): number {
  const value = seeds ?? DEFAULT_INIT_SEEDS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`seeds must be a positive integer, got ${value}`);
  }
  return value;
}
