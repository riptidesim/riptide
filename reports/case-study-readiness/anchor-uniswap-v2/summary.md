# Anchor-Uniswap-V2 Case-Study Readiness Corpus Addendum

Generated on May 5, 2026.

This is the canonical addendum to the readiness-corpus row for
`0xNineteen/anchor-uniswap-v2` with the guided-sim status. It
does not promote the repository above the existing corpus level. The live
generated readiness command currently sees local WIP run-collection noise in
AUV2, so this addendum preserves the L4 baseline and adds only the new
guided-sim status note.

## Corpus snapshot update

| Candidate | Level | E2E kind | Evidence path | Status note | Main blocker |
| --- | --- | --- | --- | --- | --- |
| `0xNineteen/anchor-uniswap-v2` | L4 | generic | corpus baseline; `.riptide/sim/` | guided-sim wired (declared invariants only, not exhaustive coverage) | No semantic E2E run; migrate the adapter to `amm.v1` before any L5+ claim. |

## Boundaries

- AUV2 remains L4 generic-E2E in the readiness corpus.
- The new `.riptide/sim/` integration is guided-sim evidence, not
  semantic E2E, risk-slice E2E, campaign readiness, or full protocol
  coverage.
- Declared guided-sim invariants are observable in the generated
  artifacts, but they are not exhaustive coverage.
- Other case-study repositories remain unchanged by this note.
