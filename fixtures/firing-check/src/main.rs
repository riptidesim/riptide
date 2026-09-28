// A sim crate with two invariants over the same collateral, used to pin both
// Firing Check outcomes. `vault_backed` reads the vault the violation zeroes,
// so it fires. `decoy_backed` is wired to the wrong account: it reads a decoy
// the flows never touch, so it cannot see the violation and does not fire.

use std::process::ExitCode;

use riptide_sim::kernel::semantics::{SemanticsDescriptor, Severity};
use riptide_sim::solana_account::Account;
use riptide_sim::solana_sdk::pubkey::Pubkey;
use riptide_sim::{
    riptide_sim, run_expression_invariants, ContextBuilder, FiringCheck, Violation, World,
};

const COLLATERAL_OFFSET: usize = 8;
const COLLATERAL_WIDTH: usize = 8;

pub struct Simulation {
    world: World,
    vault: Pubkey,
    decoy: Pubkey,
}

impl Default for Simulation {
    fn default() -> Self {
        Self {
            world: World::new(Pubkey::new_from_array([7; 32])),
            vault: Pubkey::new_from_array([1; 32]),
            decoy: Pubkey::new_from_array([2; 32]),
        }
    }
}

impl Simulation {
    fn install(&mut self, key: Pubkey, collateral: u64) -> riptide_sim::anyhow::Result<()> {
        let mut data = vec![0u8; COLLATERAL_OFFSET + COLLATERAL_WIDTH];
        data[COLLATERAL_OFFSET..].copy_from_slice(&collateral.to_le_bytes());
        self.world.set_account(
            key,
            Account {
                lamports: 1_000_000,
                data,
                owner: Pubkey::new_from_array([9; 32]),
                executable: false,
                rent_epoch: 0,
            },
        )
    }

    fn collateral(&self, key: &Pubkey) -> u128 {
        self.world
            .get_account(key)
            .and_then(|account| {
                account
                    .data
                    .get(COLLATERAL_OFFSET..COLLATERAL_OFFSET + COLLATERAL_WIDTH)
                    .map(|bytes| {
                        let mut amount = [0u8; COLLATERAL_WIDTH];
                        amount.copy_from_slice(bytes);
                        u64::from_le_bytes(amount)
                    })
            })
            .unwrap_or(0) as u128
    }
}

#[riptide_sim]
impl Simulation {
    #[init]
    fn init(&mut self) -> riptide_sim::anyhow::Result<()> {
        self.install(self.vault, 1_000)?;
        self.install(self.decoy, 1_000)
    }

    #[flow]
    fn deposit(&mut self) -> riptide_sim::anyhow::Result<()> {
        let vault = self.vault;
        let deposited = self.collateral(&vault) as u64 + 10;
        self.world.mutate_account(&vault, |account| {
            account.data[COLLATERAL_OFFSET..].copy_from_slice(&deposited.to_le_bytes());
        })
    }

    #[end]
    fn end(&mut self) -> riptide_sim::anyhow::Result<()> {
        let context = ContextBuilder::new()
            .u128("vault.collateral", self.collateral(&self.vault))
            .u128("decoy.collateral", self.collateral(&self.decoy))
            .build();
        let mut descriptor = SemanticsDescriptor::new();
        descriptor.invariant("vault_backed", "vault.collateral > 0", Severity::Error)?;
        descriptor.invariant("decoy_backed", "decoy.collateral > 0", Severity::Error)?;
        run_expression_invariants(&mut self.world, &descriptor, &context, 0)
    }

    #[violations]
    fn violations(&mut self) -> Vec<FiringCheck> {
        let zero_vault = || Violation::zero_field(self.vault, COLLATERAL_OFFSET, COLLATERAL_WIDTH);
        vec![
            FiringCheck::new("vault_backed", zero_vault()),
            FiringCheck::new("decoy_backed", zero_vault()),
        ]
    }
}

fn main() -> ExitCode {
    riptide_sim::run::<Simulation>()
}
