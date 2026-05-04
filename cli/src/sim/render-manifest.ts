export function renderBootstrapManifest(): string {
  return `# Riptide guided simulation bootstrap manifest.
#
# This file is applied by the generated simulation before src/flows.rs init code.
# Use it for Trident-style external dependencies: sibling programs, local account
# snapshots, and explicit account forks. Protocol-specific layouts stay in your
# sim crate under src/flows.rs and src/services/.

# Load a sibling or dependency program from a local .so at a fixed address.
# Omit address only when the .so has a sibling <program>-keypair.json and should
# also become World::program_id.
#
# [[sim.programs]]
# address = "11111111111111111111111111111111"
# program = "../target/deploy/dependency.so"

# Load a local account snapshot. The JSON may be a Solana getAccountInfo response,
# a solana-account-style { "account": ... } object, or Riptide's cached snapshot
# format. Account data must be base64 encoded.
#
# [[sim.accounts]]
# address = "11111111111111111111111111111111"
# filename = "fixtures/accounts/dependency-account.json"

# Fork an account snapshot from RPC and cache it locally for deterministic reruns.
# cluster accepts "mainnet", "m", "devnet", "d", "testnet", "t", or a custom
# RPC URL. Keep overwrite=false for stable, reviewable runs.
#
# [[sim.fork]]
# address = "11111111111111111111111111111111"
# cluster = "mainnet"
# filename = "fork-cache/mainnet/dependency-account.json"
# overwrite = false
`;
}
