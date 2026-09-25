---
status: accepted
---

# Deterministic Engine Output, agent-authored Assessment Context

An Assessment has two layers. **Engine Output** (`campaign-summary.json`, `risk-surface.json`, the mechanical `assessment.json`) stays deterministic and byte-pinned. **Assessment Context** (Scope Declaration, Coverage, Gaps, invariant provenance, Delta) is written by the agent into a separate file. The final `assessment.md` is composed from both and is checked only for structure: required sections present, and every Breach has a replay command. We chose this because a fully agentic Skill produces prose and judgments that can't be reproduced byte-for-byte, while the numbers must still be reproducible.

Without a human reviewing invariants, "held" is only trustworthy if the invariant is proven able to fail. So every invariant must pass a **Firing Check**, meaning an injected violation makes it fire, before it counts as evidence. An invariant that can't be shown to fire is reported as a Gap.

## Considered Options

- **Fold agent fields into `assessment.json` and re-pin.** Rejected. It would make the pinned file nondeterministic and end byte-pinning.
- **Deterministic templates for all of `assessment.md`.** Rejected. It fights the agentic model.
- **Trust agent-authored invariants and just disclose them.** Rejected. An invariant that holds trivially would turn into a false robustness claim.
