# Riptide Vision

Riptide exists to make economic safety claims reproducible.

Every Solana protocol lives in a region defined by market conditions, user behavior, oracle paths, liquidity, leverage, and protocol parameters. Unit tests check points. Audits reason about code. Riptide maps regions by running declared experiments against the real compiled program.

## Lab, Not Oracle

Riptide is a lab, not an oracle.

The `/riptide-assess` Skill declares the experiment (the region, the stress axis, the invariants and the seeds) and lists every choice it made in the Scope Declaration, where a Steering Hint can override it. The Engine runs that experiment deterministically and records what happened. A Breach is not a bug report by itself; it is a reproducible point in the declared region where a Firing-Checked invariant failed.

The value is not "Riptide says this protocol is unsafe." The value is "any reviewer can rerun this exact experiment and get the same bytes."

## Who It Is For

- **Protocol teams** choosing launch parameters, liquidation settings, oracle assumptions, queue limits, or risk caps.
- **Auditors and security researchers** turning economic concerns into rerunnable artifacts.
- **Risk reviewers** who need more than a screenshot and less than a full custom simulator.
- **Builders with non-DeFi economies** who still have shared state under pressure: games, markets, auctions, reward loops, and resource systems.

## The Operating Model

The Skill keeps the experiment in plain files in the `.riptide/` Workspace, which the user commits:

1. **Adapter**: how to call and observe the program.
2. **Guided simulation**: the flows, actors and pressure applied.
3. **Sweep**: which dimensions are swept, over which seeds.
4. **Invariants**: what must stay true, each proven able to fire.
5. **Assessment**: the Engine Output and the Assessment Context a reviewer can rerun.

The Engine runs those files against the real BPF program in LiteSVM and emits byte-deterministic Engine Output.

## What Riptide Is Not

- Not a validator replacement: LiteSVM does not model gossip, voting, PoH, or consensus behavior.
- Not an audit replacement: it produces evidence for declared simulations, not a security certification.
- Not a fuzzer: it runs bounded, declared experiments instead of generating arbitrary inputs.
- Not a prediction engine: it maps modeled regions; it does not forecast mainnet.

## Where To Read Next

- [README](README.md) to install the Skill and read an Assessment.
- [CONTRIBUTING](CONTRIBUTING.md) and [Architecture](docs/architecture.md) to work on the Engine or the Skill.
