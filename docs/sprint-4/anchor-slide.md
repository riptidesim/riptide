# Pitch Deck — Anchor Slide (hero grid)

> **Status:** Shipped in the live HTML deck as slide 6 of 11 (2026-04-14).
>
> The authoritative Sprint 3+ pitch deck is the HTML at `../../docs/pitch/riptide-pitch-v2.html` (deployed via `../../docs/pitch/pitch-deploy/index.html`). The Sprint 4 anchor slide has been inserted between "How It Works" (slide 5) and "Innovation" (now slide 7) as `<section id="slide-6" aria-label="Hero Grid">`, using the existing `.innovation-table`, `.callout`, and `.highlight-cell` CSS classes. Downstream slide IDs and counters were renumbered accordingly.
>
> **Re-export note.** The `Riptide Pitch Deck.pptx` and `Riptide Pitch Deck.pdf` binaries next to the HTML in `docs/pitch/` are both from 2026-04-04 and are stale with respect to the HTML source (the HTML was reworked 2026-04-12/04-13). Sprint 4 left them as-is; re-exporting the binary deck from the HTML is a housekeeping task, not a hero-week deliverable.
>
> This markdown file is preserved as the **framing-discipline reference** — it carries the canonical framing sentence, the load-bearing callout, the caveat pointer, and the forbidden-phrase rules in a grep-friendly format. It is the source of truth for cold-reader tests and for any future deck imports.

---

## Framing context (speaker note, not on slide)

> *"Two ways to use Riptide: write your own experiments if you already know what you're testing for, or let the `riptide-scenarios` skill propose a starter catalog based on your program. Both run deterministically against your real code and surface the knife edges. Zero setup inside Claude Code."*

This slide is the Path A outcome demo — a hand-authored parameter-boundary discovery grid on the Solend fork.

## Slide title

**Mapping the danger region — Solend-fork whale × shock grid**

## Slide body — 3×3 bad-debt table

Bad debt in quote-asset units, post-shock, end of run. Same seed (`42`), same pool config, same engine binary, nine runs against `fixtures/adapters/solend-fork.toml`.

| whale \ shock | **20 %** | **30 %** | **40 %** |
|---|---:|---:|---:|
| **5 % whale share**  | 0 | 0 | 720 |
| **15 % whale share** | 0 | 0 | 2 160 |
| **25 % whale share** | 0 | 0 | **3 600** |

The bolded cell (`w25-s40`) is the closest discrete match to Solend's June 2022 operating point — whale share ~22–25 % of open borrows on SOL, shock in the 30–50 % band.

## Slide callout (load-bearing)

> *"Riptide maps the danger region; Solend's actual parameters sit inside it."*

## Slide footer — caveat (lab, not oracle)

> **Riptide is a lab, not an oracle.** The dev picks the experiment; Riptide runs it deterministically; the grid maps a parameter region, not a verdict on the program. Full canonical caveat at [`docs/sprint-4/hero-grid.md#caveat--lab-not-oracle`](./hero-grid.md#caveat--lab-not-oracle).

---

## Framing discipline — do not drift

The slide is about **parameter-boundary discovery**. If a cold reader walks away thinking Riptide staged an after-the-fact hack narrative, the framing is off — rewrite before shipping.

- ✅ "Riptide mapped the region where the liquidation math loses headroom."
- ✅ "Solend's June 2022 parameters land inside that region."

The grid is an affirmative map of a parameter plane; the June 2022 coordinates happen to fall inside the region the map flags. No hack narrative is staged from the outside. The forbidden framings are listed (as a negative-example list) in [`docs/sprint-4/hero-grid.md`](./hero-grid.md) — read them there, not here, so this slide asset stays clean under automated framing-check greps.

## Source of truth

Full hero report, retune history, and reproducibility notes: [`docs/sprint-4/hero-grid.md`](./hero-grid.md). Raw artifact: [`fixtures/scenarios/solend-fork/hero-grid/results.json`](../../fixtures/scenarios/solend-fork/hero-grid/results.json).
