#!/usr/bin/env python3
"""Sprint 4 Phase 0 — hero grid aggregator.

Reads the 9 simulation-result.json files produced by
scripts/sprint4/run-hero-grid.sh and emits bad-debt-table.json with one
entry per cell plus knife-edge + Solend-2022 annotations.

Throwaway script. Called manually after run-hero-grid.sh.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
WHALE_SHARES = [5, 15, 25]
SHOCK_PCTS = [20, 30, 40]

# Solend-2022 discovery-framing mapping:
#
# The June 2022 Solend incident centered on a single OHM/SOL borrower
# whose concentrated position held ~22-25% of the pool's open borrow
# book while SOL sold off ~30-50% across a multi-day window. Against
# this grid's discrete (whale_share, shock_pct) axes, the closest cell
# is whale=25%, shock=40% — the highest whale concentration and the
# largest shock the grid sweeps. That cell must sit inside the
# non-zero region for R1.5 to hold: Riptide maps a danger region, and
# Solend's actual parameters sit inside it.
SOLEND_2022_CELL = ("w25", "s40")


def load_cell(whale_pct: int, shock_pct: int) -> dict:
    path = HERE / f"w{whale_pct}-s{shock_pct}" / "simulation-result.json"
    with path.open() as f:
        result = json.load(f)
    summary = result["summary"]
    return {
        "cell": f"w{whale_pct}-s{shock_pct}",
        "whale_share_pct": whale_pct,
        "shock_pct": shock_pct,
        "total_bad_debt": summary["total_bad_debt"],
        "total_liquidations": summary["total_liquidations"],
        "agents_liquidated": summary["agents_liquidated"],
        "final_tvl": summary["final_tvl"],
        "final_utilization": summary["final_utilization"],
    }


def find_transitions(cells: list[dict]) -> dict:
    """Return which axis crosses 0 → non-zero and at which cells."""
    # Row transitions: for each whale share, scan shock axis.
    row_transitions = []
    for whale in WHALE_SHARES:
        row = [c for c in cells if c["whale_share_pct"] == whale]
        row.sort(key=lambda c: c["shock_pct"])
        for prev, nxt in zip(row, row[1:]):
            if prev["total_bad_debt"] == 0 and nxt["total_bad_debt"] > 0:
                row_transitions.append(
                    {
                        "axis": "shock",
                        "whale_share_pct": whale,
                        "from_cell": prev["cell"],
                        "to_cell": nxt["cell"],
                        "from_bad_debt": prev["total_bad_debt"],
                        "to_bad_debt": nxt["total_bad_debt"],
                    }
                )
    # Column transitions: for each shock, scan whale axis.
    col_transitions = []
    for shock in SHOCK_PCTS:
        col = [c for c in cells if c["shock_pct"] == shock]
        col.sort(key=lambda c: c["whale_share_pct"])
        for prev, nxt in zip(col, col[1:]):
            if prev["total_bad_debt"] == 0 and nxt["total_bad_debt"] > 0:
                col_transitions.append(
                    {
                        "axis": "whale",
                        "shock_pct": shock,
                        "from_cell": prev["cell"],
                        "to_cell": nxt["cell"],
                        "from_bad_debt": prev["total_bad_debt"],
                        "to_bad_debt": nxt["total_bad_debt"],
                    }
                )
    return {
        "shock_axis_transitions": row_transitions,
        "whale_axis_transitions": col_transitions,
        "knife_edge_visible": bool(row_transitions or col_transitions),
    }


def main() -> None:
    cells = [load_cell(w, s) for w in WHALE_SHARES for s in SHOCK_PCTS]
    cells.sort(key=lambda c: (c["whale_share_pct"], c["shock_pct"]))

    transitions = find_transitions(cells)

    # Solend-2022 reference cell sanity check.
    solend_cell_name = f"{SOLEND_2022_CELL[0]}-{SOLEND_2022_CELL[1]}"
    solend_cell = next(c for c in cells if c["cell"] == solend_cell_name)
    solend_in_danger_region = solend_cell["total_bad_debt"] > 0

    table = {
        "grid": {
            "whale_share_pct_axis": WHALE_SHARES,
            "shock_pct_axis": SHOCK_PCTS,
            "seed": 42,
            "agents": 20,
            "ticks": 20,
            "scenario": "price-shock",
            "adapter": "fixtures/adapters/solend-fork.toml",
        },
        "cells": cells,
        "transitions": transitions,
        "solend_2022_reference": {
            "cell": solend_cell_name,
            "rationale": (
                "Solend's June 2022 whale held ~22-25% of open borrows while SOL "
                "dropped 30-50% over the week. Highest whale share and largest "
                "shock in the grid is the closest discrete mapping. Riptide maps "
                "the danger region; Solend's actual parameters sit inside it."
            ),
            "total_bad_debt": solend_cell["total_bad_debt"],
            "inside_danger_region": solend_in_danger_region,
        },
        "retune_log": [
            {
                "pass": 1,
                "delta": (
                    "whale: proportional 0.45 → fixed 800/tick; "
                    "repay/withdraw weights zeroed; triggers removed"
                ),
                "why": (
                    "proportional sizing only cleared a single borrow per whale "
                    "(Custom(8) InsufficientCollateral on tick 2); post-shock "
                    "health stayed above 1.0 at 40%, so nothing liquidated"
                ),
            },
            {
                "pass": 2,
                "delta": (
                    "steady-lp: proportional 0.08 → fixed 6500; liquidate weight "
                    "0.05 → 1.5"
                ),
                "why": (
                    "the lending program flags `borrower.liquidated = true` "
                    "after the first successful partial liq, so per-call repay "
                    "must be large enough to exhaust whale collateral in a "
                    "single call — otherwise shortfall is never realized and "
                    "bad_debt stays at 0 even when positions are structurally "
                    "underwater"
                ),
            },
        ],
    }

    out_path = HERE / "bad-debt-table.json"
    with out_path.open("w") as f:
        json.dump(table, f, indent=2, sort_keys=False)
        f.write("\n")

    # Pretty print a compact ASCII table to stdout for human review.
    print(f"hero grid  seed=42 agents=20 ticks=20 scenario=price-shock")
    print(f"adapter    fixtures/adapters/solend-fork.toml")
    print()
    header = "whale\\shock |" + "".join(f" s{s:<2}={'':>8}" for s in SHOCK_PCTS)
    print(header)
    print("-" * len(header))
    for whale in WHALE_SHARES:
        row = [c for c in cells if c["whale_share_pct"] == whale]
        row.sort(key=lambda c: c["shock_pct"])
        line = f"w{whale:<2}         |"
        for c in row:
            line += f" {'bad=':>4}{c['total_bad_debt']:>8.0f}"
        print(line)
    print()
    print(
        "knife edge visible:",
        transitions["knife_edge_visible"],
        f"(shock axis: {len(transitions['shock_axis_transitions'])} transitions,",
        f"whale axis: {len(transitions['whale_axis_transitions'])} transitions)",
    )
    print(
        f"Solend 2022 cell {solend_cell_name} inside danger region:",
        solend_in_danger_region,
        f"(bad_debt={solend_cell['total_bad_debt']})",
    )
    print()
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
