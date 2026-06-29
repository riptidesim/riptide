# Riptide Vision

Riptide exists to make economic safety claims reproducible.

Every Solana protocol lives in a region defined by market conditions, user behavior, oracle paths, liquidity, leverage, and protocol parameters. Unit tests check points. Audits reason about code. Riptide maps regions by running declared experiments against the real compiled program.

## Lab, Not Oracle

Riptide is a lab, not an oracle.

The developer chooses the experiment: adapter, personas, scenario, seed, ticks, and invariants. Riptide runs that experiment deterministically and records what happened. A red cell in a grid is not a bug report by itself; it is a reproducible point in parameter space where the declared invariant failed or the observed metric moved into a dangerous range.

The value is not "Riptide says this protocol is unsafe." The value is "any reviewer can rerun this exact experiment and get the same bytes."

## Who It Is For

- **Protocol teams** choosing launch parameters, liquidation settings, oracle assumptions, queue limits, or risk caps.
- **Auditors and security researchers** turning economic concerns into rerunnable artifacts.
- **Risk reviewers** who need more than a screenshot and less than a full custom simulator.
- **Builders with non-DeFi economies** who still have shared state under pressure: games, markets, auctions, reward loops, and resource systems.

## The Operating Model

Riptide keeps the experiment in plain files:

1. **Adapter**: how to call and observe the program.
2. **Personas**: how agents behave.
3. **Scenario**: what market or system pressure is applied.
4. **Parameters**: which dimensions are swept.
5. **Invariants**: what must stay true.
6. **Evidence pack**: what a reviewer can rerun.

The engine runs those files against the real BPF program in LiteSVM and emits deterministic artifacts: JSON results, dashboard data, markdown traces, and canonical hashes.

## What Riptide Is Not

- Not a validator replacement: LiteSVM does not model gossip, voting, PoH, or consensus behavior.
- Not an audit replacement: it produces evidence for declared simulations, not a security certification.
- Not a fuzzer: it runs bounded experiments you declare instead of generating arbitrary inputs.
- Not a prediction engine: it maps modeled regions; it does not forecast mainnet.

## Where To Read Next

- [README](README.md) for the project tour and quick start.
- [Architecture](docs/architecture.md) for the guided-simulation model and determinism contract.
- [Guided simulation](docs/guided-sim.md) for the authoring-to-assessment flow.
