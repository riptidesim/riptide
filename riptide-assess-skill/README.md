# Riptide Assess — the Riptide Skill

The Riptide Skill turns a Solana program repo into a reproducible
**Assessment**: deterministic, fixed-seed simulations of the program's real
compiled binary, with the exact commands that reproduce every figure. It is
simulation evidence over a declared region, not an audit signoff, not formal
verification and not a mainnet prediction.

## Use

Install the skill in your agent host, open your program repo, and run:

```text
/riptide-assess
```

That is the only command. Add an optional Steering Hint to narrow it:

```text
/riptide-assess programs/vault
/riptide-assess focus on liquidation cascades
/riptide-assess deep
```

The Skill runs start to finish without pausing for input. Every assumption it
makes in place of an answer is listed in the Scope Declaration at the top of
the Assessment, with the Steering Hint that overrides it. Everything it writes
lives under `.riptide/`; commit that directory so anyone can rerun the
Assessment.

## What you get

- **Assessment** — `assessment.md` / `assessment.json` rendered by the Engine,
  plus the agent-written Assessment Context: Scope Declaration, Depth,
  Coverage (instructions and actors exercised), Gaps (what was not exercised,
  and why), invariants with their provenance and Firing Check results, and
  Breaches with seed replay commands and Causal Traces.
- **Blocker Report** — instead of an Assessment when nothing could be
  simulated, naming what would unblock it.
- **Out-of-Scope Note** — within a minute, when the target is not an Economic
  Protocol, pointing to code-level auditing tools instead.

## Prerequisites

`cargo`, the Solana SBF toolchain (`cargo-build-sbf`) and `node >= 20`. The
Skill checks for them first and names anything missing.

## Structure

```
riptide-assess-skill/
├── skill/
│   ├── SKILL.md                 # The command, Steering Hint, Scope Declaration, Depth, stage list
│   ├── classify-and-scope.md    # Classify + Scope
│   ├── family-library.md        # Per-family personas, Floor Invariants, stress scenarios
│   ├── worst-case-playbook.md   # Per-archetype worst case to hunt
│   ├── setup.md                 # Setup: Workspace, adapter, sim crate, setup seams, sweep
│   ├── authoring-patterns.md    # Oracle bytes, third-party dispatch, sweep scaffold
│   ├── run-and-surface.md       # Run + Surface
│   ├── firing-check.md          # Firing Check
│   ├── repair.md                # Repair
│   ├── report.md                # Report: Assessment, Blocker Report, Out-of-Scope Note
│   ├── causal-trace.md          # Causal Trace for each Breach
│   ├── honesty.md               # The honesty rules and execution-honesty gates
│   ├── resources.md             # References + file index
│   └── agents/openai.yaml       # Host display metadata
├── examples/
│   ├── assessment-input.json    # Example Engine Output input
│   └── assessment-context.json  # Example Assessment Context
├── install.sh                   # Engine bootstrap (idempotent)
├── README.md
└── LICENSE                      # MIT
```

## License

MIT License — see [LICENSE](LICENSE) for details.
