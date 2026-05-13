# Sprint 34 Phase 1 Baseline And Target Boundary

Captured: 2026-05-13

## Baseline

Command:

```text
$ cd /home/ailton/Work/riptide/riptide && git status --short --branch
## main...origin/main [ahead 2]
```

Detailed dirty check:

```text
$ cd /home/ailton/Work/riptide/riptide && git status --porcelain=v1 -uall
```

No stdout was produced. The Sprint 34 code-repo baseline starts with no dirty
tracked or untracked paths. `main` is two commits ahead of `origin/main`; that
is branch position, not a dirty path.

## Dirty Path Classification

Initial code-repo dirty paths:

| Classification | Paths |
| --- | --- |
| Sprint 34-owned | none at baseline |
| User/concurrent work | none at baseline |
| Generated output | none at baseline |
| Scratch | none at baseline |

Post-baseline Sprint 34-owned paths may include this report, the Sprint 34
Obsidian task notes, and the clean-checkout CI gate files. They are not part of
the pre-implementation dirty-state capture.

## Stash Evidence

```text
$ cd /home/ailton/Work/riptide/riptide && git stash list
stash@{0}: On main: park concurrent Studio agent probe before Sprint 32 close
stash@{1}: On main: park follow-up Studio first-run wizard before Sprint 32 close
stash@{2}: On main: park follow-up Studio frontend api before Sprint 32 close
stash@{3}: On main: park follow-up Studio source changes before Sprint 32 close
stash@{4}: On main: park out-of-scope Studio work before Sprint 32 close
stash@{5}: WIP on main: 6e1ad19 Skip bound-oracle accounts from the generic observation loop
```

These stashes are pre-existing parked work. Phase 1 does not apply, drop, or
rewrite them.

## Process Evidence

```text
$ cd /home/ailton/Work/riptide/riptide && pgrep -af 'claude|task-master-ai|riptide studio|npm|cargo build|cargo test|node .*riptide|codex'
2409 node /home/ailton/.local/share/mise/installs/node/24.11.1/bin/codex --sandbox danger-full-access
2416 /home/ailton/.local/share/mise/installs/node/24.11.1/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex --sandbox danger-full-access
9487 systemd-inhibit --what=idle --mode=block --who codex --why Codex is running an active turn -- sleep 2147483647
```

No active `claude`, `task-master-ai`, `riptide studio`, `npm`, or `cargo`
writer process was observed.

## First Target Set

This is a target boundary for later Phase 2 work, not an execution claim.

| Target | Why in first set | Starting boundary |
| --- | --- | --- |
| `/home/ailton/Work/riptide/case-studies/raydium-cp-swap` | Live/prod-adjacent Solana AMM repo with local `.riptide` adapter, scenario, harness, campaign, packs, IDL, and SBF artifact present. Current local git status showed only `## master...origin/master [ahead 1]`. | First runnable target for Phase 2. Current evidence is generic local simulation only; no semantic AMM support claim until commands are rerun and reviewed. |
| `/home/ailton/Work/riptide/case-studies/anchor-uniswap-v2` | Existing demo-ready guided-sim row from the case-study corpus, useful as an AMM guided-sim control surface. | Boundary/control target only until its pre-existing sibling-repo `.riptide` churn is intentionally owned or parked. Do not normalize or revert that repo in Phase 1. |
| `fixtures/campaigns/lending/solend-shape-liquidation-safety` and `fixtures/replays/lending-whale-bad-debt` | Committed lending campaign/replay fixtures provide a stable CI-local lending path without relying on the currently dirty sibling `case-studies/lending` checkout. | Use committed fixtures for Phase 1/T02 and as a later lending control. This does not claim current `case-studies/lending` is clean or runnable. |

Deferred first-set candidates: `mango-v4`, `protocol-v2`, `whirlpools`,
`solana-program-library`, `liquid-staking-program`, `marinade-liquid-stake-fork`,
`perpetuals`, and `stablecoin-protocol`. Their current known blockers are
missing IDL/artifacts, incomplete account binding, missing semantic mapping, or
missing Riptide primitives; they belong in the Phase 2 matrix, not the Phase 1
CI gate.

## Read-Only Live-Mainnet Boundary

Phase 1 performs no live-mainnet actions. Later live/prod-adjacent target work
must stay inside this boundary unless the user explicitly changes scope:

- Allowed: read public source, committed local artifacts, local IDLs, local SBF
  outputs, local `.riptide` workspaces, local replay/campaign/guided-sim output,
  and documented read-only public state fetches.
- Not allowed: private keys, signing, deployment, RPC transactions, account
  mutation, validator/mainnet writes, publishing, or claiming protocol support
  from source inspection alone.
- Claim language: "Riptide ran these declared local inputs and observed these
  outputs" is allowed after execution evidence exists. "Riptide supports live
  protocol X" is not allowed without an exact adapter/state boundary, run
  evidence, and documented limitations.
