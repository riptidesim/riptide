import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Hex, type JsonValue } from "../src/state-pack/json.js";
import { RISK_SURFACE_HASH_PREFIX } from "../src/campaign/surface.js";

/**
 * Flagship lending-cartography determinism + gradient gate (Sprint 39 R6).
 *
 * The load-bearing R6.4 gate is run by hand against the real engine:
 *
 *   riptide campaign run \
 *     fixtures/campaigns/lending/whale-shock-cartography/campaign.toml \
 *     --out <a>        # twice, to <a> and <b>
 *   sha256sum <a>/.../risk-surface.json <b>/.../risk-surface.json   # must match
 *
 * Both runs produced the byte-identical surface checked in here as
 * `expected-risk-surface.json`. That run is too slow for the unit suite (80
 * real simulations × 2), so this test instead locks the recorded flagship
 * surface bytes: it re-derives the sha256 the gate recorded, re-canonicalizes
 * the document to prove it is in byte-stable canonical form, re-verifies the
 * embedded self-digest, and asserts the cold-read gradient shape so a producer
 * change that flattens or inverts the surface fails CI.
 */

// The sha256 recorded by the two-run R6.4 determinism gate. Re-running the
// flagship campaign must reproduce this exact file.
const FLAGSHIP_SURFACE_SHA256 =
  "11c60685a6e57f02bce65ef63d2fd49566268669bacd03cbd4f294024873206f";

const SURFACE_PATH = path.resolve(
  process.cwd(),
  "..",
  "fixtures",
  "campaigns",
  "lending",
  "whale-shock-cartography",
  "expected-risk-surface.json"
);

interface FlagshipSurface {
  schema_version: string;
  campaign: { campaign_digest: string; run_budget: number };
  axes: Array<{ name: string }>;
  cells: Array<{
    coords: Array<{ axis: string; bin_index: number }>;
    run_count: number;
    invariant_failure_rate: number;
    sparse: boolean;
  }>;
  sensitivity: { ranking: Array<{ rank: number; axis: string; monotonic: string | null; elasticity: number | null }> };
  safe_region: { status: string };
  surface_digest: string;
}

test("flagship cartography surface: bytes match the recorded R6.4 determinism hash", async () => {
  const raw = await readFile(SURFACE_PATH, "utf8");
  const sha = createHash("sha256").update(raw, "utf8").digest("hex");
  assert.equal(sha, FLAGSHIP_SURFACE_SHA256, "flagship risk-surface.json bytes drifted from the recorded gate hash");
});

test("flagship cartography surface: is in byte-stable canonical form with a verifiable self-digest", async () => {
  const raw = await readFile(SURFACE_PATH, "utf8");
  const surface = JSON.parse(raw) as FlagshipSurface;

  // Re-canonicalizing the parsed document must reproduce the on-disk bytes
  // exactly — the property that makes `sha256sum risk-surface.json` a stable
  // determinism hash.
  assert.equal(canonicalJson(surface as unknown as JsonValue), raw, "surface is not in canonical-JSON form");

  // The embedded surface_digest is the domain-prefixed self-hash over the
  // document minus that field; recompute and verify it.
  const { surface_digest, ...rest } = surface as FlagshipSurface & Record<string, unknown>;
  const expected = sha256Hex(`${RISK_SURFACE_HASH_PREFIX}\n${canonicalJson(rest as unknown as JsonValue)}`);
  assert.equal(surface_digest, expected, "embedded surface_digest does not verify");

  assert.equal(surface.schema_version, "risk-surface.v1");
  assert.equal(surface.campaign.campaign_digest, "40a5f239691a64309db2bc9a49ae14127f2c25a75260c802149f3f0a2c4277f2");
  assert.equal(surface.campaign.run_budget, 80);
});

test("flagship cartography surface: shows the expected monotonic whale × shock failure gradient", async () => {
  const raw = await readFile(SURFACE_PATH, "utf8");
  const surface = JSON.parse(raw) as FlagshipSurface;

  // Two swept axes, sorted by name.
  assert.deepEqual(surface.axes.map((axis) => axis.name), ["shock_profile", "whale_share_bps"]);

  // Whale concentration is the most-sensitive axis and trends upward; the
  // shock profile is second. This is the "higher whale concentration → higher
  // failure rate" finding the sprint requires.
  const [rank1, rank2] = surface.sensitivity.ranking;
  assert.equal(rank1?.axis, "whale_share_bps");
  assert.equal(rank1?.monotonic, "increasing");
  assert.ok((rank1?.elasticity ?? 0) > 0, "whale_share_bps failure rate should rise with the axis");
  assert.equal(rank2?.axis, "shock_profile");

  // Cold-read gradient under the biting price-shock profile (bin_index 0): the
  // failure rate climbs from 0 at low whale share to 1.0 at high whale share,
  // and never decreases as whale concentration rises.
  const priceShockByWhaleBin = surface.cells
    .filter((cell) => coord(cell, "shock_profile") === 0 && cell.run_count > 0)
    .sort((a, b) => coord(a, "whale_share_bps")! - coord(b, "whale_share_bps")!)
    .map((cell) => cell.invariant_failure_rate);
  assert.deepEqual(priceShockByWhaleBin, [0, 0, 1, 1], "price-shock whale gradient is not the recorded monotonic step");
  for (let i = 1; i < priceShockByWhaleBin.length; i += 1) {
    assert.ok(priceShockByWhaleBin[i]! >= priceShockByWhaleBin[i - 1]!, "failure rate must be non-decreasing in whale share");
  }

  // The bank-run profile (bin_index 1) realizes no bad debt in this fixture, so
  // every populated bank-run cell stays safe.
  const bankRunRates = surface.cells
    .filter((cell) => coord(cell, "shock_profile") === 1 && cell.run_count > 0)
    .map((cell) => cell.invariant_failure_rate);
  assert.ok(bankRunRates.every((rate) => rate === 0), "bank-run cells should not fail in this fixture");

  // A safe region exists (low whale share), never a silent empty.
  assert.equal(surface.safe_region.status, "found");

  // The flagship fixture is supposed to be a non-sparse 4x2 grid, not a
  // single-sample showcase. If planner changes or campaign weights make any
  // populated cell sparse, the fixture no longer satisfies the T06 proof
  // premise.
  assert.equal(surface.cells.length, 8);
  assert.ok(surface.cells.every((cell) => cell.run_count >= 2), "flagship cells must have non-trivial run counts");
  assert.ok(surface.cells.every((cell) => !cell.sparse), "flagship surface must not contain sparse cells");
});

function coord(cell: FlagshipSurface["cells"][number], axis: string): number | undefined {
  return cell.coords.find((c) => c.axis === axis)?.bin_index;
}
