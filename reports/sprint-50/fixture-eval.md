# Guided-sim fixture eval — polished deliverable — 2026-06-12

Extends the Sprint 48 eval (`reports/sprint-48/fixture-eval.md`, raw verdict +
honesty gates) to the Sprint 50 acceptance gate: a cold run of the full
`sim run → sim surface → assess --brief --input` flow against the three
guided-sim case studies (`~/Work/riptide/case-studies/{anemone,agio,defunds}`,
private, outside this repo) must produce a *trustworthy, sendable* deliverable
on the first run. Per fixture, this eval asserts:

1. the honest polished narrative shape for the actual evidence: a
   **non-generic finding title** naming the fired invariant when an invariant
   fired, or the explicit no-finding held-case fallback when zero invariants
   fired, plus a **boundary-style recommendation** with no knob phrasing
   (`Keep `/`keeping parameters`/`tune the campaign`);
2. `brief.html` + `brief.pdf` emitted with the five sections
   (*What we did / What we found / What to do / Scope & limits / Reproduce*);
3. the three execution-honesty gates green
   (positive_control / lifecycle_executed / determinism);
4. `brief.html` byte-stable across re-runs (sha256 equality).

- CLI: 0.11.0 built from `feat/sprint-50-self-serve-deliverable` (narrative
  reframe `c57e560` + `--brief` `47bdba7` + skill input authoring `d61738a` +
  the brief print-density fix below), `cd cli && npm run build`.
- `--input` per fixture: the skill-authored `assessment-input.json` already
  present at each case-study root (anemone/agio authored during the Sprint 48
  bring-up, defunds during its onboarding) — the same editorial layer the
  updated skill now authors programmatically.
- Sweep artifacts regenerated from scratch per fixture
  (`.riptide/sim/artifacts/eval-sweep`), surfaces rebuilt to
  `.riptide/eval-assess`. Every surface hash is **byte-identical to the
  Sprint 48 pin** (determinism across a CLI version bump and a five-week gap).
- Full successful stdout transcripts are checked in under
  `reports/sprint-50/raw-logs/`:
  - `raw-logs/anemone-20260612.log`
  - `raw-logs/agio-20260612.log`
  - `raw-logs/defunds-20260612.log`
  These include the complete `sim run` stdout, `sim surface` stdout,
  every `assess --brief --input` rerun, `sha256sum`, `pdfinfo`, section grep,
  and knob-phrasing grep.

## Defect found and fixed by this eval

The first Agio `assess --brief` render produced a **2-page** `brief.pdf` (the
reproduce-hash line + footer spilled onto page 2) — Agio's richer
`assessment-input.json` is ~420 bytes denser than Anemone's, and the one-page
promise broke exactly on the flagship demo target. Read-checking the HTML would
not have caught this; rendering the PDF did. Fix: print-media-only density
tightening in `cli/src/assess/render-brief.ts` (`@media print` font-size /
line-height / section margins; screen layout untouched). After the fix:
`npm --prefix cli test -- assess` → **147 pass / 0 fail**; Agio and Anemone
briefs both render exactly 1 PDF page (`pdfinfo Pages: 1`); byte-determinism
re-proven post-fix for all three fixtures (hashes below are post-fix).

## Verdict summary

| Fixture | Verdict | Narrative shape | Gates | brief.html sha256 (stable across runs) | brief.pdf | Knob grep |
| --- | --- | --- | --- | --- | --- | --- |
| anemone | ✅ `ready_to_send` (declared) | `lp_outflow_material` fires as `rate_shock_bps` deepens | ✅✅✅ | `0ed07f31…` (3 runs identical) | 1 page | 0 |
| agio | ✅ `ready_to_send` (declared) | `lender_bad_debt` fires as `collateral_price_drop_bps` deepens | ✅✅✅ | `ed15d450…` (2 runs identical) | 1 page | 0 |
| defunds | ✅ `ready_to_send` (declared) | No finding under the declared inputs. (0 fires — honest held-case fallback) | ✅✅✅ | `f5ad71a4…` (2 runs identical) | 1 page | 0 |

Surface hashes vs Sprint 48 pins: anemone `c69d4027…`, agio `de748996…`,
defunds `cb9bc99c…` — all byte-identical to the committed case-study surfaces
and the Sprint 48 eval log.

Defunds note on assertion (1): with zero invariant fires there is no fired
invariant to name; the explicit no-finding held-case fallback is the specified
behavior, and the recommendation still reads as a resilience boundary
(entire-region branch, pasted below) with the explicit caveat "Stresses beyond
the swept region were not tested."

## Per-fixture transcript excerpts

The full command transcripts are the raw logs linked per fixture. The inline
blocks below are shortened excerpts so this eval remains scannable.

### anemone

Full transcript: `reports/sprint-50/raw-logs/anemone-20260612.log`.

```
$ riptide sim run .riptide/sim --flows 20 --out .riptide/sim/artifacts/eval-sweep
  [excerpt: full 24-iteration stdout is in the raw log; tail:]
riptide sim iteration=22 seed=5252525252525252525252525252525252525252525252524452525252525252
riptide sim anemone shock_bps=490
riptide sim iteration=23 seed=5252525252525252525252525252525252525252525252524552525252525252
riptide sim anemone shock_bps=490

$ riptide sim surface .riptide/sim/artifacts/eval-sweep --sim .riptide/sim --out .riptide/eval-assess
riptide sim surface: wrote cartography artifacts to /home/ailton/Work/riptide/case-studies/anemone/.riptide/eval-assess
  campaign-summary.json (id guided-sim-59b0a9875a186dff)
  risk-surface.json
  retention-manifest.json
  execution-honesty gates: pass
    ✓ positive_control: positive control rate_shock_bps=0 passed across 4 iteration(s).
    ✓ lifecycle_executed: all 5 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 c69d402734a32b82…).
  next: riptide assess .riptide/eval-assess

$ riptide assess .riptide/eval-assess --brief --input .riptide/assessment-input.json --protocol-name Anemone --out /tmp/s50-anemone-c
Assessment generated: Anemone

Result
  Verdict: ready_to_send (declared)
  Runs: 24/24 completed, 12 invariant-failed (50%)
  Risk surface: 6/6 cells populated, worst cell 100%, most sensitive `rate_shock_bps`
  Safe region: bounded region at or under 5%
  Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism

Artifacts
  Assessment: /tmp/s50-anemone-c/assessment.json
  Report: /tmp/s50-anemone-c/assessment.md
  Brief: /tmp/s50-anemone-c/brief.html
  Brief PDF: /tmp/s50-anemone-c/brief.pdf

Hashes
  Assessment digest: 96c7ecbcb4f9e599d871bbbd05b1b00580ac7b17e5c617c8d47d06d8643368a3
  Campaign digest: 59b0a9875a186dff34b7e75a7d5524b5a5b02ebfeab2eea959bf902b7d68f361
  risk-surface.json sha256: c69d402734a32b82672f476b7bca033207ed4e8668ec6884a2a89596c7e26f1b

$ sha256sum /tmp/s50-anemone-a/brief.html /tmp/s50-anemone-b/brief.html /tmp/s50-anemone-c/brief.html
0ed07f31158a880439c40fb6ff349619ce4b48f5acce76a239ce92e243ea70e5  /tmp/s50-anemone-a/brief.html
0ed07f31158a880439c40fb6ff349619ce4b48f5acce76a239ce92e243ea70e5  /tmp/s50-anemone-b/brief.html
0ed07f31158a880439c40fb6ff349619ce4b48f5acce76a239ce92e243ea70e5  /tmp/s50-anemone-c/brief.html

$ pdfinfo /tmp/s50-anemone-c/brief.pdf | grep Pages
Pages:           1
```

Five sections present (verbatim `grep -oE '>[0-9]</span>[A-Za-z &;]+' brief.html`):

```
>1</span>What we did
>2</span>What we found
>3</span>What to do
>4</span>Scope &amp; limits
>5</span>Reproduce
```

Finding title (assessment.md, verbatim): `- **Main finding:** \`lp_outflow_material\` fires as \`rate_shock_bps\` deepens`

Recommendation (brief §3 *What to do*, rendered text, verbatim):

> lp_outflow_material held while rate_shock_bps stayed at or below 200 and began
> to fire beyond that bound. This bounds the protocol's observed resilience to
> rate_shock_bps under the tested configuration: a safe region observed at or
> under the 5% failure-rate threshold within the declared, fixed-seed swept
> region — an observed boundary, not a parameter to set.

`grep -cE 'Keep |keeping parameters|tune the campaign'` over `brief.html` and
`assessment.md`: **0** and **0**.

### agio

Full transcript: `reports/sprint-50/raw-logs/agio-20260612.log`.

```
$ riptide sim run .riptide/sim --flows 12 --out .riptide/sim/artifacts/eval-sweep
  [excerpt: full 28-iteration stdout, including compiler warnings, is in the raw log; tail:]
riptide sim iteration=26 seed=5252525252525252525252525252525252525252525252524852525252525252
riptide sim agio collateral_price_drop_bps=6000
riptide sim iteration=27 seed=5252525252525252525252525252525252525252525252524952525252525252
riptide sim agio collateral_price_drop_bps=6000

$ riptide sim surface .riptide/sim/artifacts/eval-sweep --sim .riptide/sim --out .riptide/eval-assess
riptide sim surface: wrote cartography artifacts to /home/ailton/Work/riptide/case-studies/agio/program/.riptide/eval-assess
  campaign-summary.json (id guided-sim-e9b6b620cc6fd896)
  risk-surface.json
  retention-manifest.json
  execution-honesty gates: pass
    ✓ positive_control: positive control collateral_price_drop_bps=0 passed across 4 iteration(s).
    ✓ lifecycle_executed: all 3 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 de748996f19bb373…).
  next: riptide assess .riptide/eval-assess

$ riptide assess .riptide/eval-assess --brief --input .riptide/assessment-input.json --protocol-name "Agio Network" --out /tmp/s50-agio-a
Assessment generated: Agio Network

Result
  Verdict: ready_to_send (declared)
  Runs: 28/28 completed, 12 invariant-failed (42.8571%)
  Risk surface: 7/7 cells populated, worst cell 100%, most sensitive `collateral_price_drop_bps`
  Safe region: bounded region at or under 5%
  Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism

Artifacts
  Assessment: /tmp/s50-agio-a/assessment.json
  Report: /tmp/s50-agio-a/assessment.md
  Brief: /tmp/s50-agio-a/brief.html
  Brief PDF: /tmp/s50-agio-a/brief.pdf

Hashes
  Assessment digest: 5706f69e8702450482dec8c7aabfa77fe1089c172e58477d57c796279a331b10
  Campaign digest: e9b6b620cc6fd89696689574827a14397a486cc689996042b16c4896dfd28e73
  risk-surface.json sha256: de748996f19bb373ef7afb03152cac0880456b37dd40f59d964271e6a5eec8fa

$ sha256sum /tmp/s50-agio-a/brief.html /tmp/s50-agio-b/brief.html
ed15d450a568be423ead6eaaa72d1261a03512639eb6cfbe65c3711ee95bfb77  /tmp/s50-agio-a/brief.html
ed15d450a568be423ead6eaaa72d1261a03512639eb6cfbe65c3711ee95bfb77  /tmp/s50-agio-b/brief.html

$ pdfinfo /tmp/s50-agio-a/brief.pdf | grep Pages
Pages:           1     (was 2 before the print-density fix — the defect this eval caught)
```

Five sections present (same grep, verbatim):

```
>1</span>What we did
>2</span>What we found
>3</span>What to do
>4</span>Scope &amp; limits
>5</span>Reproduce
```

Finding title (assessment.md, verbatim): `- **Main finding:** \`lender_bad_debt\` fires as \`collateral_price_drop_bps\` deepens`

Recommendation (brief §3 *What to do*, rendered text, verbatim):

> lender_bad_debt held while collateral_price_drop_bps stayed at or below 3000
> and began to fire beyond that bound. This bounds the protocol's observed
> resilience to collateral_price_drop_bps under the tested configuration: a safe
> region observed at or under the 5% failure-rate threshold within the declared,
> fixed-seed swept region — an observed boundary, not a parameter to set.

§2 *What we found* leads with what held (rendered text, verbatim):

> ✓ Held — recommended parameter region (collateral_price_drop_bps in {0, 1000,
> 2000, 3000}). No declared invariant fired under the inputs that fell inside
> the recommended bounds. […] ▲ lender_bad_debt fires as
> collateral_price_drop_bps deepens. 12 of 28 completed run(s) (42.8571%) fired
> a declared invariant; the worst surface cell reached a 100% invariant-failure
> rate.

`grep -cE 'Keep |keeping parameters|tune the campaign'` over `brief.html` and
`assessment.md`: **0** and **0**.

### defunds

Full transcript: `reports/sprint-50/raw-logs/defunds-20260612.log`.

```
$ riptide sim run .riptide/sim --flows 12 --out .riptide/sim/artifacts/eval-sweep
  [excerpt: full 28-iteration stdout, including compiler warnings, is in the raw log; tail:]
riptide sim iteration=26 seed=5252525252525252525252525252525252525252525252524852525252525252
riptide sim defunds nav_markdown_bps=5000
riptide sim iteration=27 seed=5252525252525252525252525252525252525252525252524952525252525252
riptide sim defunds nav_markdown_bps=5000

$ riptide sim surface .riptide/sim/artifacts/eval-sweep --sim .riptide/sim --out .riptide/eval-assess
riptide sim surface: wrote cartography artifacts to /home/ailton/Work/riptide/case-studies/defunds/.riptide/eval-assess
  campaign-summary.json (id guided-sim-ef1c9a79e2556af9)
  risk-surface.json
  retention-manifest.json
  execution-honesty gates: pass
    ✓ positive_control: positive control nav_markdown_bps=0 passed across 4 iteration(s).
    ✓ lifecycle_executed: all 9 declared lifecycle flow(s) executed on-chain.
    ✓ determinism: surface hash recorded for re-verification (sha256 cb9bc99c579fd454…).
  next: riptide assess .riptide/eval-assess

$ riptide assess .riptide/eval-assess --brief --input .riptide/assessment-input.json --protocol-name Defunds --out /tmp/s50-defunds-a
Assessment generated: Defunds

Result
  Verdict: ready_to_send (declared)
  Runs: 28/28 completed, 0 invariant-failed (0%)
  Risk surface: 7/7 cells populated, worst cell 0%, most sensitive `nav_markdown_bps`
  Safe region: entire declared region at or under 5%
  Execution honesty: pass
    ✓ positive_control
    ✓ lifecycle_executed
    ✓ determinism

Artifacts
  Assessment: /tmp/s50-defunds-a/assessment.json
  Report: /tmp/s50-defunds-a/assessment.md
  Brief: /tmp/s50-defunds-a/brief.html
  Brief PDF: /tmp/s50-defunds-a/brief.pdf

Hashes
  Assessment digest: ad08a83e78c02721948501c07aa42f84188e9d2b46fab4968f3a0f62eb79b55d
  Campaign digest: ef1c9a79e2556af9539d02ddf22ba2da8a6a99f76eff2fed6c77f8fdf11d295e
  risk-surface.json sha256: cb9bc99c579fd454bc7097a3b4f4e172b373351fb25286229cd64fc79161f629

$ sha256sum /tmp/s50-defunds-a/brief.html /tmp/s50-defunds-b/brief.html
f5ad71a4a8c973c3f55d747d335a7932af4bf78458b400c8d18f1335d61012ca  /tmp/s50-defunds-a/brief.html
f5ad71a4a8c973c3f55d747d335a7932af4bf78458b400c8d18f1335d61012ca  /tmp/s50-defunds-b/brief.html

$ pdfinfo /tmp/s50-defunds-a/brief.pdf | grep Pages
Pages:           1
```

Five sections present (same grep, verbatim — `>1</span>Every populated cell
held the invariant` is the numbered *What-to-do* list item, not a section):

```
>1</span>What we did
>2</span>What we found
>3</span>What to do
>1</span>Every populated cell held the invariant
>4</span>Scope &amp; limits
>5</span>Reproduce
```

Finding title (assessment.md, verbatim): `- **Main finding:** No finding under the declared inputs.`
(0 invariant fires — the specified held-case fallback; nothing to name.)

Recommendation (brief §3 *What to do*, rendered text, verbatim —
entire-region resilience branch):

> Every populated cell held the invariant-failure rate at or under the 5%
> threshold: the tested swept nav_markdown_bps range stayed within the
> protocol's observed resilience under this configuration, and no failure
> boundary was crossed inside the declared, fixed-seed swept region. Stresses
> beyond the swept region were not tested.

§2 *What we found* (rendered text, verbatim):

> ✓ Held — deposit (NAV-floored, par share pricing). No declared invariant
> fired under these inputs. Evidence is bounded to the declared, fixed-seed
> parameter region and run budget.

`grep -cE 'Keep |keeping parameters|tune the campaign'` over `brief.html` and
`assessment.md`: **0** and **0**.

## Regenerated case-study briefs (R4.2)

The tool-generated `brief.html` + `brief.pdf` from the runs above were
installed into each case-study root, **replacing the hand-made Agio
`brief.html`** (the hand-authored purple-accent one-pager that previously
proved the layout; the installed brief is the tool's teal-accent render):

```
$ sha256sum case-studies/{anemone,defunds}/.riptide/brief.html case-studies/agio/program/.riptide/brief.html
0ed07f31158a880439c40fb6ff349619ce4b48f5acce76a239ce92e243ea70e5  anemone/.riptide/brief.html
ed15d450a568be423ead6eaaa72d1261a03512639eb6cfbe65c3711ee95bfb77  agio/program/.riptide/brief.html
f5ad71a4a8c973c3f55d747d335a7932af4bf78458b400c8d18f1335d61012ca  defunds/.riptide/brief.html

$ grep -cE 'Keep |keeping parameters|tune the campaign' case-studies/anemone/.riptide/brief.html case-studies/agio/program/.riptide/brief.html case-studies/defunds/.riptide/brief.html
anemone/.riptide/brief.html:0
agio/program/.riptide/brief.html:0
defunds/.riptide/brief.html:0
```

No scope cut taken — all three fixtures ran, all three briefs regenerated.
Case-study artifacts stay outside this repo; this log is the in-repo evidence.

## Pin confirmation

This phase runs the tool; the only source change is the brief print-density fix
(presentation-only, outside every byte gate). Confirmed:

- Scoped diff vs `main` over the frozen-pin surfaces is **empty**:
  `git diff --name-only main -- fixtures engine riptide-sim riptide-sim-macros programs` → no output
  (full branch diff touches only `cli/`, `skills/riptide-assess/SKILL.md`, `.gitignore`).
  The five frozen engine/surface pins (`60f72ade…`, `1518bcfd…`, `5de060cd…`,
  `6c59db5e…`, `11c60685…`) are untouched by construction.
- Flagship assess pins re-asserted in-suite (post-fix run, verbatim):

```
✔ flagship assessment: assessment.md + assessment.json bytes match the recorded gate hashes
✔ flagship assessment: re-rendering is byte-identical (the R6.4 determinism property)
```

- The three guided-sim surface hashes reproduced byte-identically to their
  Sprint 48 pins (`c69d4027…` / `de748996…` / `cb9bc99c…`), which doubles as
  cross-version determinism evidence for the sweep → surface path.
- `npm --prefix cli test -- assess` after the density fix: **147 pass / 0 fail**.
