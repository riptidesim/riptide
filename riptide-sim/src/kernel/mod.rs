//! Reusable simulation kernel.
//!
//! The persona decision brain (`persona`), the kernel data types (`types`), and
//! the bounded expression evaluator (`semantics`) were extracted from the
//! engine so guided sims can compose the same primitives directly over the
//! real-program [`crate::World`]. None of these modules perform I/O, time
//! access, or network access; they are pure decision/evaluation logic.

pub mod persona;
pub mod semantics;
pub mod types;
