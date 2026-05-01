# Agent-scaling benchmark

How many agents can Riptide drive, and how fast? This doc pins a concrete
ceiling, not a handwave. The harness and raw TSV are committed alongside.

## Headline

**Riptide runs 1000 agents for 30 ticks in ~3 seconds on a standard
laptop, using ~62 MB of RAM. Output is byte-deterministic across reruns.**

Machine: Intel Core i7-1165G7 (4 cores / 8 threads, 11th gen, 2.80 GHz base)
· 15 GiB RAM · Linux 6.19.14-arch1-1 · Arch Linux.

Scenario: AMM scratch (`scripts/amm-scratch.sh` shape), constant-product
pool, five-persona library (`lp-provider`, `arbitrageur`, `sandwich-attacker`,
`swapper`, `rug-puller`), fixed seed 42, `baseline` scenario, 30 ticks.

## Results (refreshed 2026-04-29)

| Agents | Wall-clock (s) | Peak RSS (MB) | Determinism hash (sha256)                                          | Status |
|-------:|---------------:|--------------:|:-------------------------------------------------------------------|:-------|
|     10 |           0.05 |           ~0  | `631a1b1cee47f7f241135858c0992fb016edb09395d90363d0b27cb07ea80dab` | ok     |
|     50 |           0.20 |          23.7 | `acdd794fec2b8d7ff178c085f332bcb16ef4829f0db3bb094b357260f529eef6` | ok     |
|    100 |           0.35 |          25.4 | `80ea5ed2486827a822fd311dd6b2546580dfdd9cd94ba45b125a54635e965998` | ok     |
|    250 |           0.75 |          30.4 | `d24b2087a3fdbd0b92946b5f26bc5869736e78ef2036e1fafa871be44a5c0cd7` | ok     |
|    500 |           1.71 |          39.4 | `e0eff42d6ceb65b801fa98d3f0c5a5102a9054bb975a30246bef883bfb27634d` | ok     |
|   1000 |           3.06 |          62.2 | `9390718df0d6543866c1f7f051e63b818548ac89d7e1bcc963bc477288430840` | ok     |

Hashes match byte-for-byte against the previous (2026-04-19) run despite
the wall-clock improvement — engine output is reproducible across the
oracle / generic-binding / external-lending-adapter commits landed since.
Raw TSV is at [`agent-scaling-results.tsv`](./agent-scaling-results.tsv)
(overwritten per run — rerun to refresh). Wall-clock varies 20–30% across
back-to-back runs depending on background CPU load.

## Wall-clock vs. agents

```
wall (s)
  3.5 |
      |                                                        *
  3.0 |
      |
  2.5 |
      |
  2.0 |
      |                                          *
  1.5 |
      |
  1.0 |                                *
      |
  0.5 |                       *
      |             *
  0.0 |   *  *
      +-------+-------+-------+-------+-------+-------+
         10     50    100    250    500   1000    agents
```

Wall-clock is close to linear in agents: ~3.1 ms per agent amortized at 1000,
dropping below 2 ms per agent at smaller counts where fixed bootstrap cost
dominates. No superlinear blow-up emerged in the 10–1000 range, no OOM, no
timeout, no engine error at 1000.

## Interpretation

The headline ceiling (1000 agents, 30 ticks, ~3 s, ~62 MB) is the largest
count this harness ran, not the largest count Riptide can physically run —
it's the largest point we measured before declaring the curve well-behaved.
The scaling shape (linear wall-clock, gently-linear memory, deterministic)
says nothing is pathological at 1000, so the practical bottleneck for
higher counts is laptop RAM and patience, not a failure mode inside the
engine.

Per-tick cost at 1000 agents is ~100 ms. 30 ticks (≈12 simulated seconds
of mainnet, since each tick advances one Solana slot ≈ 400 ms) is enough
to express the AMM scratch scenario end-to-end; longer runs scale
proportionally (a 1000-agent × 300-tick run projects to ~30 s on this
hardware; a 500-agent × 750-tick "5-minute oracle drawdown" projects to
~40–60 s).

What this benchmark does *not* prove: (a) behavior above 1000 agents, (b)
behavior on SVM backends other than LiteSVM, (c) performance parity with
other SVMs (`solana-test-validator` is ~1000× slower on the same lending
workload — that's an infrastructure-overhead finding, not an engine
finding). Only the in-process LiteSVM path is measured here.

## Reproducing

From a fresh clone with the engine + AMM-fork `.so` built:

```bash
cargo build --release -p riptide-engine
cargo build-sbf --manifest-path programs/amm/Cargo.toml
bash scripts/agent-scaling-benchmark.sh
```

Output prints to stdout as the runs execute; a TSV copy lands at
[`agent-scaling-results.tsv`](./agent-scaling-results.tsv). Six agent counts
(10 / 50 / 100 / 250 / 500 / 1000) run sequentially; total elapsed on the
headline hardware is ~8–10 seconds depending on background load.

Each row captures wall-clock (monotonic), peak RSS (max `VmHWM` from
`/proc/<pid>/status`, sampled every 50 ms), and sha256 of the engine's
`simulation-result.json` output (which is the authoritative byte fingerprint
of the run). Timeouts, crashes, and non-zero engine exits are reported as
rows, not silently skipped — a clean OOM at 1000 agents would be a valid
result and would show up as `status=timeout` or `status=engine_exit_<rc>`.

## Harness

[`../../scripts/agent-scaling-benchmark.sh`](../../scripts/agent-scaling-benchmark.sh)

No new dependencies. Uses `bash`, `python3`, `awk`, `sed`, `sha256sum`, and
`/proc/<pid>/status` — deliberately avoids `gnu-time` because Arch ships
without `/usr/bin/time`. The sidecar-adapter pattern (truncate `amm.toml`
at `# === SIDECAR-CUT ===`, rewrite to absolute paths, append the five
persona TOMLs) is inherited from `amm-scratch.sh`.
