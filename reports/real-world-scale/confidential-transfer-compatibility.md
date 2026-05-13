# Sprint 36 Confidential Transfer Compatibility

Captured: 2026-05-13

This report answers a narrow compatibility question: can Riptide run, or
precisely classify, a CLOAK-like confidential-transfer / ZK-heavy Solana target
from local public artifacts without touching CLOAK private code?

The answer from this sprint is: **not through today's generic Riptide path**.
Token-2022 Confidential Transfers are blocked by a missing guided
transaction-sequence harness for non-Anchor SPL flows. Light Protocol v1 is a
source-backed feasibility row that also needs sequence/harness work before
Riptide can claim run evidence.

This is simulation/compatibility evidence, not audit signoff, proof-system
soundness, broad privacy-protocol support, CLOAK support, live protocol support,
or a mainnet claim.

## Target Matrix

| Target | Status | HEAD | Local evidence | Blocker | Next action |
| --- | --- | --- | --- | --- | --- |
| Token-2022 Confidential Transfers | `blocked` | `2d18d97f083627d3f13ce43b16fa4305cbfac4de` | Local source audit plus static blocker commands. Raw artifact: `reports/real-world-scale/artifacts/confidential-transfer/token-2022/static-blocker-commands.txt`. | No checked-in `target/deploy/spl_token_2022.so`; `interface/idl.json` is a Codama/Shank `programNode`, not the root `instructions`/`accounts` shape Riptide's generic path consumes; confidential state lives in SPL TLV extensions; configure/withdraw/transfer paths need ordered proof-context instructions or context-state accounts. | Add a bounded guided transaction-sequence harness for Token-2022 setup/proof-context/TLV flows, then rerun the smallest local slice. |
| Light Protocol v1 | `needs-feature` | `9230a38975f6c6c279781c756f62572bfcfa847c` | Clean checkout, checked-in `.so`, test/proof fixtures, and source facts. Raw artifact: `reports/real-world-scale/artifacts/confidential-transfer/light-v1/source-feasibility.md`. | No checked-in IDL; old Solana/Anchor tooling; checked-in program id/keypair provenance mismatch; transfer model spans a fixed 1502-instruction state machine with temporary accounts, Groth16 verifier phases, Merkle updates, nullifier PDAs, and token/SOL movement. | Treat as static feasibility until Riptide has a guided sequence/transaction-template path that can drive the multi-instruction state machine. |
| Current Light Protocol | `out-of-scope` | `0687860ae2718f20a861993f08f909630e85b12b` from T01 reachability | Reachability only. No current-Light source or artifact integration was attempted in this sprint. | Explicit sprint cut. | Future sprint only if explicitly rescoped; do not infer support from the reachable repo. |
| CLOAK private code | `out-of-scope` | N/A | No CLOAK code was requested, inspected, or adapted. | Explicit sprint cut and trust boundary. | Future trial needs user-provided local artifacts and explicit approval. This report only shapes the trial checklist. |
| Elusiv/Arcium via `arcium-hq/elusiv` | `out-of-scope` | Unreachable in T01 | T01 `git ls-remote` returned repository-not-found output. | Repository remained unavailable for this sprint's target lock. | Leave cut unless a reachable public repo is provided and explicitly scoped. |

## Token-2022 Confidential Transfers

Classification: **blocked by missing Riptide primitive**.

Local checkout:

- Path: `/home/ailton/Work/riptide/case-studies/token-2022-confidential-transfer`
- HEAD: `2d18d97f083627d3f13ce43b16fa4305cbfac4de`
- Program id from `interface/idl.json`: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`

Retained command output:

- `reports/real-world-scale/artifacts/confidential-transfer/token-2022/static-blocker-commands.txt`

Key retained stdout:

```text
riptide_workspace_exists=false
```

```text
missing_token_2022_program_artifact=target/deploy/spl_token_2022.so
```

```text
root_has_instructions=false
root_has_accounts=false
root_has_program=true
program_kind=programNode
program_name=token-2022
program_origin=shank
program_instruction_count=91
program_account_count=3
```

The source audit found real confidential-transfer instruction and state facts:

- Instruction names include initialize/configure/approve/deposit/apply pending
  balance/withdraw/transfer/transfer with fee.
- Account layouts for confidential balances live in `ConfidentialTransferMint`
  and `ConfidentialTransferAccount` TLV extension structs, not normal Anchor
  accounts in the JSON IDL.
- Configure, withdraw, transfer, and transfer-with-fee paths use proof-context
  instructions or context state accounts through instruction offsets/context
  records.

First missing Riptide primitive:

```text
bounded guided transaction-sequence harness for non-Anchor SPL Token-2022 flows
that can create and order Token-2022 setup instructions, proof-context
instructions or context-state accounts, and TLV extension observations
```

No Token-2022 `.riptide` workspace, adapter, semantic class, transaction-template
system, or dynamic-account system was created in this sprint. That is intentional:
the honest result is a precise blocker, not a speculative adapter.

## Light Protocol v1

Classification: **static feasibility / needs-feature before run evidence**.

Local checkout:

- Path: `/home/ailton/Work/riptide/case-studies/light-protocol-v1`
- HEAD: `9230a38975f6c6c279781c756f62572bfcfa847c`
- Raw command evidence: `reports/real-world-scale/artifacts/confidential-transfer/light-v1/source-feasibility.md`

Positive local facts:

- The checkout is clean and pinned to the reachable T01 HEAD.
- A checked-in program artifact exists at
  `program/dist/program/light_protocol_program.so`.
- The source includes fixtures for deposit, wrong proof, internal transfer,
  withdraw, proof bytes, public inputs, and verification key bytes.
- Tests name deposit, internal-transfer, withdrawal, double-spend, wrong-proof,
  wrong-root, wrong-signer, and wrong-recipient cases.

Compatibility friction:

- There is no checked-in IDL.
- The repo uses old Solana/Anchor-era dependencies and Git-patched arkworks
  crates.
- `Anchor.toml` and `deploy_program.sh` name program id
  `2c54pLrGpQdGxJWUAoME6CReBrtDbsx5Tqx4nLZZo6av`, while the checked-in keypair
  address resolves to `4Dcx88YhY6YD4ojbGtK1e1x344WPhurHM6GxX1JCDkAU`.
- The README/source describe a 1502-instruction computation path, not a simple
  one-instruction generic adapter surface.

Light v1 is useful as a proxy for older open-source ZK/private-transfer
complexity, but this sprint did not produce Light v1 Riptide run evidence.

## Cut Targets

Current Light Protocol was only checked for reachability in T01. Full integration
of `Lightprotocol/light-protocol` is cut from this sprint.

CLOAK private code was not requested, inspected, adapted, or inferred. This
report does not claim CLOAK support. It only records what a future private
artifact trial would need before Riptide could run or classify it.

Elusiv/Arcium through `arcium-hq/elusiv` was unreachable in T01:

```text
remote: Repository not found.
fatal: repository 'https://github.com/arcium-hq/elusiv.git/' not found
```

No replacement target was added.

## Future CLOAK Trial Boundary

For a future CLOAK trial, the useful output from this sprint is a checklist, not
a support claim. A runnable trial would need:

- local program artifacts and an instruction/account schema that Riptide can
  consume or normalize;
- a bounded setup/transaction-sequence harness when the flow needs ordered
  proof-context, state-init, or multi-instruction verification steps;
- local fixtures for proof/context inputs and account state, with no live RPC
  writes or hosted proving dependency;
- explicit observation boundaries for encrypted/TLV/compressed state fields;
- exact stdout and retained artifacts for any run, review, or blocker.

Even with those inputs, Riptide would report deterministic local simulation
evidence. It would not certify cryptographic proof soundness, live-mainnet
safety, user-fund safety, or complete privacy-protocol coverage.

## Verification

The T06 report gate is:

```bash
cd /home/ailton/Work/riptide/riptide && test -s reports/real-world-scale/confidential-transfer-compatibility.md
```

Its stdout/stderr is recorded in the T06 Obsidian task note after the gate run.
