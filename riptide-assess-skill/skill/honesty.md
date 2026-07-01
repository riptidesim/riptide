# Honesty Discipline (non-negotiable)

This is the credibility spine of every assessment — read it before delivering
any result. The runtime enforces the first three rules as execution-honesty
gates; the rest are framing rules only you can keep.

Riptide has no automatic oracle for "is this finding real and honestly framed",
so the report's credibility rests on these rules. The runtime enforces the first
three as execution-honesty gates — evaluated at `riptide sim surface`, warned at
`riptide sim run`, and **blocking** at `riptide assess` — and the rest are
framing rules the gates cannot check, so following them is on you.

1. **Positive control.** Every sweep declares a coordinate whose outcome is
   known-correct (`[sim.positive_control]`, usually axis value `0`: no shock,
   fresh-and-true attestation paying exact pro-rata) and that coordinate must
   pass. Without it a flat surface is unfalsifiable. *Enforced: the
   `positive_control` gate blocks emit when the declaration is missing, the
   coordinate never ran, or it fired an invariant.*
2. **Real-program execution — never mock.** Flows execute the target program's
   real `.so`. Constructed external-account bytes (oracle prices, attestations)
   are the stress input, not a mock of the target; the target program itself is
   never stubbed or reimplemented. A flat result is only robustness if the
   intended lifecycle actually ran on-chain. *Enforced: the `lifecycle_executed`
   gate blocks emit when declared `[sim.lifecycle] required_flows` never executed
   successfully — "no-op, not robustness".*
3. **Determinism.** Fixed seeds, fixed amounts, no wall clock, no network. The
   same command must reproduce the same bytes. *Enforced: the `determinism` gate
   re-hashes `risk-surface.json` at emit against the hash recorded at surface
   time, and `riptide assess` refuses to overwrite an existing
   `assessment.json`/`assessment.md` that does not match the freshly rendered
   bytes.*
4. **Scope and boundary framing.** The result is evidence over the declared
   region — one configuration, the swept axis, the listed flows — not a safety
   statement. Name what was held fixed, what was out of scope (e.g. an oracle's
   own staleness guards when you drive the price directly, an external reserve
   that is inert in stub mode), and say "evidence over the declared region",
   never "safe".
5. **Robustness is a valid result — never manufacture a finding.** A flat
   surface with the positive control passing and the lifecycle executed is a
   real, publishable robustness result. State the structural reason the guard
   holds rather than asserting safety, and do not tighten thresholds or distort
   scenarios until something fires.
6. **The fire-threshold is a stated risk line; the gradient is the signal.** The
   invariant's threshold (1% of reserve, 1% of debt value) is a chosen reporting
   line, not a discovered boundary. Report where the metric starts moving and
   where it crosses the line — both are surface facts.
7. **Exogenous-axis cover-framing.** The swept axis is an exogenous stress (a
   market crash, a markdown), not a protocol knob. The auto-generated finding
   title and any "keep `<axis>` in {…}" safe-region line must be reframed in your
   delivery as "the onset sits at X on the axis" — a fact about where the risk
   begins, never a tuning instruction to the protocol team. No gate can check
   this; it is a delivery-step rule.

## When it hits a wall — fail fast, file an issue

If a protocol surface cannot be modeled — FHE/MPC/ZK, external-venue execution,
off-chain matching the sim cannot drive — do **not** paper over it. Name it as an
explicit **scope boundary** in the assessment (verdict `unsupported` for that
surface) and state what evidence the rest of the run still produced.

If a blocker is in Riptide itself (a CLI validation gap, a missing builder, a
runtime limitation), report the blocked state with the exact failed command, the
error summary, what you repaired, and the smallest missing fact — then file or
link an issue at `https://github.com/riptidesim/riptide/issues`. Never substitute
a hand-written report for a blocked assess gate.
