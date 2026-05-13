# Sprint 36 Confidential Transfer Compatibility

This file currently contains only Phase 2 Token-2022 route/evidence notes. T06 will expand it into the full compatibility report after Token-2022 evidence/blocker and Light Protocol v1 feasibility are both ready.

## Token-2022 Phase 2 Route

Route decision: static blocker.

Primary facts:

- Local Token-2022 checkout: `/home/ailton/Work/riptide/case-studies/token-2022-confidential-transfer`, HEAD `2d18d97f083627d3f13ce43b16fa4305cbfac4de`.
- Program id from `interface/idl.json`: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
- The checkout exposes a Codama/Shank `interface/idl.json` with confidential-transfer instruction nodes, but no built `target/deploy/spl_token_2022.so`.
- Confidential-transfer state is in Token-2022 TLV extensions (`ConfidentialTransferMint`, `ConfidentialTransferAccount`), not normal Anchor account fields.
- Configure/withdraw/transfer paths require proof-context instructions or context state accounts via the instructions sysvar/context records.

First missing Riptide primitive: a bounded guided transaction-sequence harness for non-Anchor SPL Token-2022 flows that can create and order Token-2022 setup instructions, proof-context instructions or context-state accounts, and TLV extension observations.

Phase 2 does not create a new semantic class, a broad transaction-template system, a dynamic-account system, or a Token-2022 `.riptide` adapter.

## Token-2022 Phase 2 Evidence

Raw command output:

- `reports/real-world-scale/artifacts/confidential-transfer/token-2022/static-blocker-commands.txt`

Key retained outputs:

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

The confidential instruction shape in the raw artifact shows the bounded Token-2022 path is not a single generic action: setup/configure/withdraw/transfer flows require the instructions sysvar or context state accounts plus proof/context record accounts. Phase 2 therefore records the blocker rather than layering a speculative adapter on top.
