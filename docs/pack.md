# Reviewer-ready evidence pack

Every `riptide run` and `riptide replay` invocation emits a
reviewer-forwardable evidence pack under `.riptide/pack/<run-id>/`.
The pack is the single directory a reviewer forwards to an auditor,
risk-committee engineer, or security reader when they need to see
what Riptide actually ran — without the session context the
operator had.

**Simulation evidence, not audit signoff.** The pack documents what
the simulator observed. It does not constitute a security review or
certify any program.

## Shape

```
.riptide/pack/<run-id>/
├── manifest.json        — machine-readable index (adapter, scenario, hash, invariants, exit, paths)
├── summary.md           — executive summary (3–7 lines)
├── trace.md             — reviewer-grade technical trace (events of interest, per-tick)
├── rerun.sh             — verbatim POSIX-sh rerun recipe
├── inputs/
│   └── paths.json       — repo-relative references to adapter / config / trajectory inputs
└── outputs/
    └── paths.json       — repo-relative references to simulation-result.json (and last-run.json if applicable)
```

All paths in the pack are **repo-relative**. The pack never embeds
absolute host paths, `$HOME`, hostnames, or `/tmp/` locations — the
emitter rejects any file that would, so a leaked pack fails loud
instead of carrying a leaked identifier onto a reviewer's machine.

`rerun.sh` is POSIX sh-compatible (no `bash`-only features) so it
runs on macOS stock shell, Linux `dash`, and Alpine containers.

## `manifest.json` reference

```json
{
  "schema_version": 1,
  "kind": "replay-multi",
  "run_id": "replay-multi-lst-lending-contagion-proof-upstream",
  "scenario": "replay:multi:lst-lending-contagion-proof-upstream",
  "adapter": "multi-component: liquid-staking × lending_pool",
  "component_adapters": {
    "lending": "fixtures/replays/lending-whale-bad-debt/adapter.toml",
    "liquid_staking": "fixtures/replays/liquid-staking-depeg-redemption-run/adapter.toml"
  },
  "total_ticks": 4,
  "agents": 16,
  "event_count": 13,
  "canonical_hash": "d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb",
  "invariant_firings": [
    {
      "name": "liquid_staking:no_slash_during_healthy_run",
      "firings": 2,
      "first_tick": 3,
      "field": "liquid_staking.pool.cumulative_slashed",
      "op": "==",
      "value": 0.0
    },
    {
      "name": "lending:no_bad_debt",
      "firings": 1,
      "first_tick": 4,
      "field": "lending.pool.bad_debt",
      "op": "==",
      "value": 0.0
    }
  ],
  "exit_code": 1,
  "inputs": {
    "config": "fixtures/replays/lst-lending-contagion-proof/config.json",
    "trajectory_dirs": {
      "lending": "fixtures/replays/lst-lending-contagion-proof/lending",
      "liquid_staking": "fixtures/replays/lst-lending-contagion-proof/liquid-staking"
    },
    "component_adapters": {
      "lending": "fixtures/replays/lending-whale-bad-debt/adapter.toml",
      "liquid_staking": "fixtures/replays/liquid-staking-depeg-redemption-run/adapter.toml"
    }
  },
  "outputs": {
    "simulation_result": "fixtures/replays/lst-lending-contagion-proof/riptide-output/replays/lst-lending-contagion-proof/simulation-result.json"
  },
  "simulation_boundaries": [
    "Multi-component replay boots two declared components into one shared LiteSVM world.",
    "Per-tick ordering: each component runs in declaration order; bridges sourced from a component are applied to their downstream target before the next component ticks.",
    "Bridges are scalar observation -> scalar oracle write with an explicit transform; no arbitrary cross-program transaction graph.",
    "Qualified snapshot keys `<component>.<field>` expose per-component state to invariants without ambiguity."
  ]
}
```

Key surfaces:

- `kind` — `simulation-run` (single primitive), `replay` (single-component replay), or `replay-multi` (cross-protocol replay with a bridge).
- `canonical_hash` — SHA256 of the `SimulationResult` with `run_config.output_path` replaced by the literal `__canonical__`. Matches Sprint 10 / Sprint 11 proof hashes byte-identically.
- `invariant_firings` — declaration-order array; `firings=0` rows indicate declared-but-held invariants (reviewer-grade clarity that the absence of firings is deliberate, not an omission).
- `exit_code` — `0` when all declared invariants held, `1` when one or more fired. Mirrors the engine's exit code policy.
- `inputs` / `outputs` — relative-path references to the files the run read from and wrote to. The pack does not duplicate those files; it indexes them.

## Rerun workflow

```sh
sh .riptide/pack/<run-id>/rerun.sh
```

The script `cd`s to the repository root and executes the invocation the
pack was emitted for. Reviewers can run it cold from a fresh checkout
after `cargo build --release -p riptide-engine` and `cargo build-sbf`
for the required programs.

The canonical hash in `manifest.json` is byte-identical between runs
on the same committed inputs. A diff in the hash signals a real
observable change — either a deliberate fixture update (regenerate
the expected pinning), a program recompile that shifted behavior, or
a regression.

## Byte-stability contract

The pack is byte-stable for byte-stable input:

- no run timestamps
- no random state leaked into filenames or content
- no environment-variable lookups in the rendered files
- deterministic map-key ordering (BTreeMap alphabetical on the engine side, preserved on round-trip through the CLI)

The engine test
[`engine/tests/pack_byte_stability_contagion.rs`](../engine/tests/pack_byte_stability_contagion.rs)
pins the Sprint 11 contagion proof's per-file SHA256s and asserts
back-to-back runs emit byte-identical packs.

## Invocation points

- `riptide run [pattern-or-path]` — one pack per scenario, placed at `.riptide/pack/<run-id>/` relative to the current working directory.
- `riptide replay <config>` — one pack per replay invocation, placed at `.riptide/pack/<run-id>/`.
- `riptide-engine pack --result <file> --pack-dir <dir> [...]` — engine-side entrypoint the CLI drives; also callable directly for integration tests or custom tooling.
