//! Adapter-agnostic invariant descriptors.
//!
//! The engine evaluates `[[semantics.invariants]]` against `crate::adapter`
//! types. Guided sims have no adapter at runtime, so this module carries the
//! same evaluation over a self-contained [`SemanticsDescriptor`] built from
//! parsed expression sources. The engine's adapter `Semantics` can convert into
//! this shape (a later phase) without the evaluator depending on the adapter.

use super::error::{EvalError, ExprError};
use super::eval::{evaluate, Context};
use super::expr::{parse, Expr};
use super::Value;

/// Invariant severity. Mirrors the adapter's `SemanticInvariantSeverity`:
/// `Error` is a hard correctness bound (a fire fails the iteration), `Warn`
/// is a recorded risk signal that lets the iteration complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Severity {
    #[default]
    Error,
    Warn,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
        }
    }
}

/// A single declared invariant: a boolean expression that must hold.
#[derive(Debug, Clone)]
pub struct InvariantDecl {
    pub name: String,
    pub source: String,
    pub expr: Expr,
    pub severity: Severity,
}

/// A self-contained set of declared invariants for one protocol surface.
#[derive(Debug, Clone, Default)]
pub struct SemanticsDescriptor {
    pub class: Option<String>,
    pub invariants: Vec<InvariantDecl>,
}

impl SemanticsDescriptor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_class(mut self, class: impl Into<String>) -> Self {
        self.class = Some(class.into());
        self
    }

    /// Parse an invariant from its source expression and add it. Returns the
    /// parse error if the expression is malformed (caught at sim startup, not
    /// mid-run).
    pub fn invariant(
        &mut self,
        name: impl Into<String>,
        source: impl Into<String>,
        severity: Severity,
    ) -> Result<&mut Self, ExprError> {
        let source = source.into();
        let expr = parse(&source)?;
        self.invariants.push(InvariantDecl {
            name: name.into(),
            source,
            expr,
            severity,
        });
        Ok(self)
    }
}

/// A falsified invariant on a given tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvariantFire {
    pub name: String,
    pub tick: u32,
    pub severity: Severity,
}

/// Evaluate every declared invariant against `context`. An invariant whose
/// expression evaluates to `false` produces a fire; a non-boolean result is an
/// evaluation error (a malformed invariant, surfaced rather than silently
/// skipped).
pub fn evaluate_expression_invariants(
    descriptor: &SemanticsDescriptor,
    context: &Context,
    tick: u32,
) -> Result<Vec<InvariantFire>, EvalError> {
    let mut fires = Vec::new();
    for invariant in &descriptor.invariants {
        let holds = match evaluate(&invariant.expr, context)? {
            Value::Bool(value) => value,
            other => {
                return Err(EvalError::TypeMismatch {
                    expected: "bool".into(),
                    found: other.kind_name().into(),
                    span: invariant.expr.span,
                });
            }
        };
        if !holds {
            fires.push(InvariantFire {
                name: invariant.name.clone(),
                tick,
                severity: invariant.severity,
            });
        }
    }
    Ok(fires)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor() -> SemanticsDescriptor {
        let mut d = SemanticsDescriptor::new().with_class("lending.v1");
        d.invariant("backed", "debt_value <= collateral_value", Severity::Warn)
            .unwrap();
        d.invariant("healthy", "health_factor >= 1", Severity::Error)
            .unwrap();
        d
    }

    #[test]
    fn fires_false_invariants_in_declaration_order() {
        let d = descriptor();
        let context = Context::from([
            ("collateral_value".into(), Value::U128(100)),
            ("debt_value".into(), Value::U128(120)),
            ("health_factor".into(), Value::U128(0)),
        ]);

        let fires = evaluate_expression_invariants(&d, &context, 7).unwrap();
        assert_eq!(fires.len(), 2);
        assert_eq!(fires[0].name, "backed");
        assert_eq!(fires[0].severity, Severity::Warn);
        assert_eq!(fires[1].name, "healthy");
        assert_eq!(fires[1].severity, Severity::Error);
        assert_eq!(fires[1].tick, 7);
    }

    #[test]
    fn true_invariants_do_not_fire() {
        let d = descriptor();
        let context = Context::from([
            ("collateral_value".into(), Value::U128(100)),
            ("debt_value".into(), Value::U128(80)),
            ("health_factor".into(), Value::U128(2)),
        ]);

        let fires = evaluate_expression_invariants(&d, &context, 1).unwrap();
        assert!(fires.is_empty());
    }

    #[test]
    fn non_boolean_result_is_an_error() {
        let mut d = SemanticsDescriptor::new();
        d.invariant("bad_shape", "debt_value + 1", Severity::Error)
            .unwrap();
        let context = Context::from([("debt_value".into(), Value::U128(80))]);

        let err = evaluate_expression_invariants(&d, &context, 1).unwrap_err();
        assert!(matches!(err, EvalError::TypeMismatch { .. }));
    }
}
