//! Third-party / target-vs-agent dispatch scaffolding.
//!
//! The generic persona model can only express an agent acting on *its own*
//! accounts: the signer and the operated-on position/order have the same owner.
//! Liquidations, keeper cranks, matchers, and settlers break that assumption —
//! actor `A` signs an instruction that operates on actor `B`'s position/order.
//! The account set then mixes two ownership roles, and hand-rolling it invites
//! three recurring mistakes:
//!
//! 1. marking the target `B` (or one of B's accounts) as a *signer* — the real
//!    instruction is permissionless/third-party precisely because B does not
//!    sign;
//! 2. forgetting to mark the actor `A` as a signer at all;
//! 3. letting some shared/program account sneak in as a signer.
//!
//! [`ThirdPartyDispatch`] builds the `Vec<AccountMeta>` for "A signs, operates
//! on B's accounts" and enforces, at [`build`](ThirdPartyDispatch::build) time,
//! that the actor is the sole transaction-level signer and the target never
//! signs. The account *order* is the caller's (it must match the program's IDL
//! account order); the helper only owns the signer/writable *roles*.
//!
//! This mirrors the hand-written liquidation sets from the shipped IRS and
//! lending sims (actor = liquidator, target = position owner), generalized so a
//! generated sim crate wires it instead of re-deriving the role bits.

use anyhow::{bail, Result};
use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey, signature::Keypair};

use crate::World;

/// Builder for a third-party action's account set: actor `A` signs and operates
/// on target `B`'s position/order.
///
/// Push accounts in the program's declared IDL order using the role methods,
/// then [`build`](Self::build) to get the validated metas. Use
/// [`actor`](Self::actor) as the transaction signer
/// (`world.transaction()…signer(dispatch.actor())`).
#[derive(Debug, Clone)]
pub struct ThirdPartyDispatch {
    actor: Pubkey,
    target: Pubkey,
    metas: Vec<AccountMeta>,
    actor_signed: bool,
}

impl ThirdPartyDispatch {
    /// Begin a dispatch where `actor` (A) acts on `target` (B)'s accounts.
    ///
    /// # Panics
    /// If `actor == target`: that is ordinary self-service, which the generic
    /// persona model already expresses — this helper is only for the
    /// distinct-owner case.
    pub fn new(actor: Pubkey, target: Pubkey) -> Self {
        assert_ne!(
            actor, target,
            "third-party dispatch requires distinct actor and target; \
             actor == target is self-service (use the generic path)"
        );
        Self {
            actor,
            target,
            metas: Vec::new(),
            actor_signed: false,
        }
    }

    /// The acting signer A.
    pub fn actor(&self) -> Pubkey {
        self.actor
    }

    /// The target owner B being acted upon.
    pub fn target(&self) -> Pubkey {
        self.target
    }

    /// The actor `A` as the signing account (`is_signer = true`). `writable` is
    /// usually `true` when A receives a liquidation bonus / pays gas-side state,
    /// `false` when A is a pure authority. Must be called exactly once.
    pub fn actor_signer(&mut self, writable: bool) -> &mut Self {
        self.actor_signed = true;
        self.metas.push(AccountMeta {
            pubkey: self.actor,
            is_signer: true,
            is_writable: writable,
        });
        self
    }

    /// An account owned/controlled by the actor A (never a signer here — A's
    /// signature is carried by [`actor_signer`](Self::actor_signer)). E.g. the
    /// liquidator's token account that receives seized collateral.
    pub fn actor_account(&mut self, pubkey: Pubkey, writable: bool) -> &mut Self {
        self.push_non_signer(pubkey, writable)
    }

    /// The target owner `B` itself, as a non-signer account (B is referenced but
    /// does not authorize the action).
    pub fn target_owner(&mut self, writable: bool) -> &mut Self {
        let target = self.target;
        self.push_non_signer(target, writable)
    }

    /// An account owned by the target B — B's position/order PDA, B's token
    /// account, etc. Always a non-signer (this is the whole point: A operates on
    /// B's accounts without B's signature).
    pub fn target_account(&mut self, pubkey: Pubkey, writable: bool) -> &mut Self {
        self.push_non_signer(pubkey, writable)
    }

    /// A shared protocol / sysvar / program account (vault, market, token
    /// program, …). Never a signer.
    pub fn shared(&mut self, pubkey: Pubkey, writable: bool) -> &mut Self {
        self.push_non_signer(pubkey, writable)
    }

    /// Escape hatch for an account whose role does not fit the helpers above.
    /// `is_signer = true` is rejected unless `pubkey == actor`, preserving the
    /// single-signer invariant.
    pub fn account(&mut self, pubkey: Pubkey, is_signer: bool, is_writable: bool) -> &mut Self {
        if is_signer && pubkey == self.actor {
            self.actor_signed = true;
        }
        self.metas.push(AccountMeta {
            pubkey,
            is_signer,
            is_writable,
        });
        self
    }

    fn push_non_signer(&mut self, pubkey: Pubkey, writable: bool) -> &mut Self {
        self.metas.push(AccountMeta {
            pubkey,
            is_signer: false,
            is_writable: writable,
        });
        self
    }

    /// Validate the third-party invariants and return the account metas in
    /// insertion order:
    /// - the actor A appears as a signer exactly once;
    /// - the target B never signs;
    /// - no account other than A is a signer.
    pub fn build(&self) -> Result<Vec<AccountMeta>> {
        let actor_signer_count = self
            .metas
            .iter()
            .filter(|m| m.is_signer && m.pubkey == self.actor)
            .count();
        if !self.actor_signed || actor_signer_count == 0 {
            bail!(
                "third-party dispatch has no actor signer: call actor_signer() so A authorizes the action"
            );
        }
        if actor_signer_count > 1 {
            bail!(
                "third-party dispatch marks the actor A as a signer more than once; call actor_signer() exactly once"
            );
        }
        for meta in &self.metas {
            if meta.is_signer && meta.pubkey != self.actor {
                if meta.pubkey == self.target {
                    bail!(
                        "third-party dispatch marks the target B as a signer; a third-party \
                         action must not require the target's signature"
                    );
                }
                bail!(
                    "third-party dispatch has a signer ({}) other than the actor; only A may sign",
                    meta.pubkey
                );
            }
        }
        Ok(self.metas.clone())
    }

    /// Convenience: validate, then return both the metas and the single actor
    /// signer to hand to `world.transaction()…signer(actor)`.
    pub fn build_with_signer(&self) -> Result<(Vec<AccountMeta>, Pubkey)> {
        Ok((self.build()?, self.actor))
    }
}

/// Register an actor keypair as a transaction signer in the world and return its
/// pubkey, the A side of an A-acts-on-B dispatch. Thin wrapper over
/// [`World::register_keypair`] that documents intent at the call site.
pub fn register_actor(world: &mut World, keypair: Keypair) -> Pubkey {
    world.register_keypair(keypair)
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::signature::Signer;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn liquidation_set_makes_actor_the_sole_signer() {
        // Third-party liquidate_position: liquidator (A) acts on owner (B).
        let liquidator = pk(1);
        let owner = pk(2);
        let mut dispatch = ThirdPartyDispatch::new(liquidator, owner);
        dispatch
            .shared(pk(10), false) // protocol_state
            .shared(pk(11), true) // market
            .target_account(pk(12), true) // owner's swap_position PDA
            .shared(pk(13), true) // collateral_vault
            .target_owner(true) // owner B
            .target_account(pk(14), true) // owner's token account
            .actor_account(pk(15), true) // liquidator's token account
            .actor_signer(false); // liquidator signs (authority only)

        let metas = dispatch.build().unwrap();
        let signers: Vec<_> = metas.iter().filter(|m| m.is_signer).collect();
        assert_eq!(signers.len(), 1, "exactly one signer");
        assert_eq!(signers[0].pubkey, liquidator);
        // The target owner and its position are present but never sign.
        assert!(metas
            .iter()
            .any(|m| m.pubkey == owner && !m.is_signer && m.is_writable));
        assert!(metas.iter().all(|m| !(m.pubkey == owner && m.is_signer)));
    }

    #[test]
    fn target_as_signer_is_rejected() {
        let actor = pk(1);
        let target = pk(2);
        let mut dispatch = ThirdPartyDispatch::new(actor, target);
        dispatch.actor_signer(true).account(target, true, true);
        let err = dispatch.build().unwrap_err().to_string();
        assert!(err.contains("marks the target B as a signer"), "{err}");
    }

    #[test]
    fn missing_actor_signer_is_rejected() {
        let mut dispatch = ThirdPartyDispatch::new(pk(1), pk(2));
        dispatch.target_owner(true).shared(pk(10), false);
        let err = dispatch.build().unwrap_err().to_string();
        assert!(err.contains("no actor signer"), "{err}");
    }

    #[test]
    fn duplicate_actor_signer_is_rejected() {
        let actor = pk(1);
        let target = pk(2);
        let mut dispatch = ThirdPartyDispatch::new(actor, target);
        dispatch
            .actor_signer(true)
            .target_owner(false)
            .account(actor, true, false);
        let err = dispatch.build().unwrap_err().to_string();
        assert!(err.contains("more than once"), "{err}");
    }

    #[test]
    fn third_party_signer_other_than_actor_is_rejected() {
        let mut dispatch = ThirdPartyDispatch::new(pk(1), pk(2));
        dispatch.actor_signer(true).account(pk(9), true, false);
        let err = dispatch.build().unwrap_err().to_string();
        assert!(err.contains("other than the actor"), "{err}");
    }

    #[test]
    fn registered_actor_is_a_world_signer() {
        let mut world = World::default();
        let keypair = Keypair::new_from_array([7; 32]);
        let expected = keypair.pubkey();
        let actor = register_actor(&mut world, keypair);
        assert_eq!(actor, expected);
        assert!(world.keypair(&actor).is_some());
    }

    #[test]
    #[should_panic(expected = "distinct actor and target")]
    fn self_service_is_rejected() {
        ThirdPartyDispatch::new(pk(1), pk(1));
    }
}
