# Light Protocol v1 Source Feasibility Evidence

This artifact copies the exact T05 command output used by the Sprint 36
compatibility report. No new Light v1 build, test, or integration command was
run while writing the report.

## Checkout And Dirty State

Command:

```bash
cd /home/ailton/Work/riptide/case-studies/light-protocol-v1 && git rev-parse HEAD
```

Exit: 0

```text
9230a38975f6c6c279781c756f62572bfcfa847c
```

Command:

```bash
cd /home/ailton/Work/riptide/case-studies/light-protocol-v1 && git status --short --branch
```

Exit: 0

```text
## main...origin/main
```

## Package Layout

Command:

```bash
find . -maxdepth 2 -type f \( -name 'Cargo.toml' -o -name 'Anchor.toml' -o -name 'package.json' -o -name 'README*' -o -name 'Makefile' -o -name '*.sh' \) -printf '%P\n' | sort
```

Exit: 0

```text
README.md
program/Anchor.toml
program/Cargo.toml
program/deploy_program.sh
```

Command:

```bash
cargo metadata --manifest-path program/Cargo.toml --no-deps --format-version 1 | jq -r '.packages[] | "\(.name) \(.version) \(.manifest_path | sub(".*/light-protocol-v1/"; ""))"'
```

Exit: 0

```text
light_protocol_program 0.1.0 program/Cargo.toml
```

## Tooling And Program Artifact

Command:

```bash
sed -n '1,260p' program/Cargo.toml
```

Exit: 0

```text
[package]
name = "light_protocol_program"
version = "0.1.0"
edition = "2018"

[patch.crates-io]
ark-ff = { git = "https://github.com/Lightprotocol/algebra", branch="release-0.3.0" }
ark-bn254 = {git = "https://github.com/Lightprotocol/curves", branch="release-0.3.0"}
ark-ec = { git = "https://github.com/Lightprotocol/algebra", branch="release-0.3.0"}
ark-serialize = { git = "https://github.com/Lightprotocol/algebra", branch="release-0.3.0"}

[features]
no-entrypoint = []
test-bpf = []

[dependencies]
solana-program = "1.8.16"
ark-crypto-primitives = { version = "^0.3.0", default-features = true, features = [ "r1cs" ] }
arkworks-gadgets = "0.3.14"

[dev-dependencies]
solana-program-test = "1.7.12"
solana-sdk = "1.7.12"
ark-groth16 ={ version = "^0.3.0", default-features = false , features = ["std"]}

[lib]
crate-type = ["cdylib", "lib"]
```

Command:

```bash
find program -maxdepth 4 -type f -printf '%P\n' | sort | sed -n '1,240p'
```

Exit: 0

```text
Anchor.toml
Cargo.lock
Cargo.toml
deploy_program.sh
dist/program/light_protocol_program-keypair.json
dist/program/light_protocol_program.so
src/groth16_verifier/groth16_processor.rs
src/instructions.rs
src/lib.rs
src/nullifier_state.rs
src/poseidon_merkle_tree/processor.rs
src/poseidon_merkle_tree/state.rs
src/poseidon_merkle_tree/state_roots.rs
src/processor.rs
src/state.rs
src/user_account/instructions.rs
src/user_account/state.rs
tests/offchain_final_exponentiation.rs
tests/offchain_merkle_tree.rs
tests/onchain.rs
tests/test_data/deposit.txt
tests/test_data/deposit_with_wrong_proof.txt
tests/test_data/internal_transfer.txt
tests/test_data/proof_bytes_254.txt
tests/test_data/public_inputs_254_bytes.txt
tests/test_data/verification_key_bytes_254.txt
tests/test_data/withdraw.txt
tests/test_utils/mod.rs
```

Command:

```bash
find . -path './.git' -prune -o -type f \( -name '*.so' -o -name '*.json' -o -name '*idl*' -o -name '*.ts' -o -name '*.js' \) -printf '%P\n' | sort | sed -n '1,240p'
```

Exit: 0

```text
program/dist/program/light_protocol_program-keypair.json
program/dist/program/light_protocol_program.so
```

Command:

```bash
sha256sum program/dist/program/light_protocol_program.so
```

Exit: 0

```text
69c722355727dead6cf30d0eb22346f296904c2031626edd767b60ad08f30e0f  program/dist/program/light_protocol_program.so
```

Command:

```bash
solana address -k program/dist/program/light_protocol_program-keypair.json
```

Exit: 0

```text
4Dcx88YhY6YD4ojbGtK1e1x344WPhurHM6GxX1JCDkAU
```

Command:

```bash
find program -path './program/.git' -prune -o -type f \( -name '*idl*' -o -path '*/target/idl/*' -o -path '*/idl/*' \) -printf '%P\n' | sort
```

Exit: 0

```text
```

## Test And Fixture Surface

Command:

```bash
rg -n "^#\[tokio::test\]|async fn .*should|fn .*should|#\[test\]" program/tests | sed -n '1,220p'
```

Exit: 0

```text
program/tests/onchain.rs:955:#[test]
program/tests/onchain.rs:956:fn pvk_should_match() {
program/tests/onchain.rs:1151:#[tokio::test]
program/tests/onchain.rs:1152:async fn deposit_should_succeed() {
program/tests/onchain.rs:1335:#[tokio::test]
program/tests/onchain.rs:1336:async fn internal_transfer_should_succeed() {
program/tests/onchain.rs:1523:#[tokio::test]
program/tests/onchain.rs:1524:async fn withdrawal_should_succeed() {
program/tests/onchain.rs:1683:#[tokio::test]
program/tests/onchain.rs:1684:async fn double_spend_should_not_succeed() {
program/tests/onchain.rs:1824:#[tokio::test]
program/tests/onchain.rs:1826:async fn deposit_with_wrong_proof_should_not_succeed() {
program/tests/onchain.rs:1951:#[tokio::test]
program/tests/onchain.rs:1953:async fn deposit_with_wrong_amount_should_not_succeed() {
program/tests/onchain.rs:2114:#[tokio::test]
program/tests/onchain.rs:2115:async fn compute_prepared_inputs_should_succeed() {
program/tests/onchain.rs:2256:#[tokio::test]
program/tests/onchain.rs:2257:async fn compute_miller_output_should_succeed() {
program/tests/onchain.rs:2314:#[tokio::test]
program/tests/onchain.rs:2315:async fn compute_final_exponentiation_should_succeed() {
program/tests/onchain.rs:2369:#[tokio::test]
program/tests/onchain.rs:2370:async fn submit_proof_with_wrong_root_should_not_succeed() {
program/tests/onchain.rs:2500:#[tokio::test]
program/tests/onchain.rs:2501:async fn search_root_at_last_root_index_should_succeed() {
program/tests/onchain.rs:2616:#[tokio::test]
program/tests/onchain.rs:2617:async fn signer_acc_not_in_first_place_should_not_succeed() {
program/tests/onchain.rs:2750:#[tokio::test]
program/tests/onchain.rs:2751:async fn submit_proof_with_wrong_signer_should_not_succeed() {
program/tests/onchain.rs:2883:#[tokio::test]
program/tests/onchain.rs:2885:async fn withdrawal_wrong_recipient_should_not_succeed() {
program/tests/onchain.rs:3052:#[tokio::test]
program/tests/onchain.rs:3053:async fn wrong_merkle_tree_should_not_succeed() {
program/tests/onchain.rs:3175:#[tokio::test]
program/tests/onchain.rs:3176:async fn wrong_integrity_hash_should_not_succeed() {
program/tests/onchain.rs:3247:#[tokio::test]
program/tests/onchain.rs:3248:async fn merkle_tree_insert_should_succeed() {
program/tests/onchain.rs:3328:#[tokio::test]
program/tests/onchain.rs:3329:async fn merkle_tree_init_with_wrong_signer_should_not_succeed() {
```

Command:

```bash
wc -c program/tests/test_data/* program/dist/program/light_protocol_program.so
```

Exit: 0

```text
   2812 program/tests/test_data/deposit.txt
   2812 program/tests/test_data/deposit_with_wrong_proof.txt
   2941 program/tests/test_data/internal_transfer.txt
   1263 program/tests/test_data/proof_bytes_254.txt
    782 program/tests/test_data/public_inputs_254_bytes.txt
   5609 program/tests/test_data/verification_key_bytes_254.txt
   2936 program/tests/test_data/withdraw.txt
1116352 program/dist/program/light_protocol_program.so
1135507 total
```

## Classification

Compatibility level: static feasibility / needs-feature before run evidence.

Light v1 has local proof/test fixtures and a checked-in `.so`, but the runtime
model is not a normal one-instruction adapter surface. A complete transfer spans
a fixed 1502-instruction order with temporary storage state, Groth16 verifier
phases, Merkle tree updates, nullifier PDAs, and token/SOL movement.
