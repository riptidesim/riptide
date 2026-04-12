//! `Harness` implementation backed by a live `solana-test-validator`.
//!
//! The engine CLI builds a `ValidatorHarness`, which owns the RPC client,
//! the admin keypair, the deployed `LendingProgramClient`, and one
//! position account per agent. All state-changing operations submit a real
//! transaction; observations re-read account data via RPC.

use borsh::BorshDeserialize;
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use solana_transaction::Transaction;

use super::harness::{Harness, HarnessError, PoolObservation, PositionObservation};
use crate::{
    harness::lending::{LendingPoolState, LendingProgramClient, PositionState},
    scenario::OracleUpdate,
};

/// Validator-backed harness. The admin is also the payer for every agent
/// tx in the tick loop (agents don't own SOL — the admin owns the position
/// accounts and signs as the position owner). This is fine for the MVP: the
/// on-chain program checks `owner == signer`, so each position is stored
/// under a unique admin-derived key (see `agent_keypair`).
pub struct ValidatorHarness {
    pub rpc: RpcClient,
    pub client: LendingProgramClient,
    pub pool: Pubkey,
    pub oracle: Pubkey,
    pub admin: Keypair,
    pub agents: Vec<Keypair>,
    pub positions: Vec<Pubkey>,
}

impl ValidatorHarness {
    pub fn new(
        rpc: RpcClient,
        client: LendingProgramClient,
        pool: Pubkey,
        oracle: Pubkey,
        admin: Keypair,
        agents: Vec<Keypair>,
        positions: Vec<Pubkey>,
    ) -> Self {
        debug_assert_eq!(agents.len(), positions.len());
        Self {
            rpc,
            client,
            pool,
            oracle,
            admin,
            agents,
            positions,
        }
    }

    fn send(&self, ix: Instruction, extra_signer: Option<&Keypair>) -> Result<(), HarnessError> {
        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| HarnessError::Infra(format!("blockhash: {e}")))?;
        let mut signers: Vec<&Keypair> = vec![&self.admin];
        if let Some(s) = extra_signer {
            if s.pubkey() != self.admin.pubkey() {
                signers.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.admin.pubkey()),
            &signers,
            blockhash,
        );
        match self.rpc.send_and_confirm_transaction(&tx) {
            Ok(_) => Ok(()),
            Err(e) => {
                let msg = e.to_string();
                // Crude classifier: program-rejected errors carry "custom
                // program error"; everything else is considered infra.
                if msg.contains("custom program error") || msg.contains("InstructionError") {
                    Err(HarnessError::ProgramRejected(msg))
                } else {
                    Err(HarnessError::Infra(msg))
                }
            }
        }
    }
}

impl Harness for ValidatorHarness {
    fn agent_count(&self) -> usize {
        self.agents.len()
    }

    fn push_oracle_price(&mut self, update: &OracleUpdate) -> Result<(), HarnessError> {
        let ix = self.client.set_oracle_price(
            self.admin.pubkey(),
            self.oracle,
            update.as_u64(),
            update.exponent,
        );
        self.send(ix, None)
    }

    fn observe_pool(&self) -> Result<PoolObservation, HarnessError> {
        let data = self
            .rpc
            .get_account_data(&self.pool)
            .map_err(|e| HarnessError::Infra(format!("pool fetch: {e}")))?;
        let state = LendingPoolState::try_from_slice(&data)
            .map_err(|e| HarnessError::Infra(format!("pool decode: {e}")))?;
        Ok(PoolObservation {
            total_deposits: state.total_deposits,
            total_borrows: state.total_borrows,
            bad_debt: state.bad_debt,
        })
    }

    fn observe_position(&self, agent_idx: usize) -> Result<PositionObservation, HarnessError> {
        let key = self
            .positions
            .get(agent_idx)
            .ok_or_else(|| HarnessError::Infra(format!("position idx {agent_idx}")))?;
        let data = self
            .rpc
            .get_account_data(key)
            .map_err(|e| HarnessError::Infra(format!("position fetch: {e}")))?;
        let state = PositionState::try_from_slice(&data)
            .map_err(|e| HarnessError::Infra(format!("position decode: {e}")))?;
        Ok(PositionObservation {
            collateral: state.collateral,
            debt: state.debt,
            liquidated: state.liquidated,
        })
    }

    fn deposit(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        let ix = self
            .client
            .deposit(agent.pubkey(), self.pool, self.positions[agent_idx], amount);
        self.send(ix, Some(&agent))
    }

    fn withdraw(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        // Always pass the oracle so the on-chain health-factor check
        // succeeds regardless of whether the position currently has debt.
        let ix = self.client.withdraw(
            agent.pubkey(),
            self.pool,
            self.positions[agent_idx],
            Some(self.oracle),
            amount,
        );
        self.send(ix, Some(&agent))
    }

    fn borrow(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        let ix = self.client.borrow(
            agent.pubkey(),
            self.pool,
            self.positions[agent_idx],
            self.oracle,
            amount,
        );
        self.send(ix, Some(&agent))
    }

    fn repay(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        let ix = self
            .client
            .repay(agent.pubkey(), self.pool, self.positions[agent_idx], amount);
        self.send(ix, Some(&agent))
    }

    fn liquidate(
        &mut self,
        liquidator_idx: usize,
        target_idx: usize,
        repay_amount: u64,
    ) -> Result<(), HarnessError> {
        let liquidator = self.agents[liquidator_idx].insecure_clone();
        let ix = self.client.liquidate(
            liquidator.pubkey(),
            self.pool,
            self.positions[target_idx],
            self.positions[liquidator_idx],
            self.oracle,
            repay_amount,
        );
        self.send(ix, Some(&liquidator))
    }
}
