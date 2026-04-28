use std::collections::BTreeMap;
use std::fmt;

use crate::adapter::{SemanticInvariant, SemanticInvariantSeverity, Semantics};

use super::{
    derived::expr_identifiers,
    error::EvalError,
    eval::{evaluate, Context},
    Value,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpressionInvariantFire {
    pub tick: u32,
    pub index: usize,
    pub name: String,
    pub expr: String,
    pub observed: BTreeMap<String, Value>,
    pub severity: SemanticInvariantSeverity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExpressionInvariantError {
    InvariantEvaluationError { name: String, error: EvalError },
    MissingParsedExpression { name: String },
}

impl fmt::Display for ExpressionInvariantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvariantEvaluationError { name, error } => {
                write!(
                    f,
                    "InvariantEvaluationError{{name: {name}, error: {error}}}"
                )
            }
            Self::MissingParsedExpression { name } => {
                write!(
                    f,
                    "expression invariant `{name}` has no parsed expression AST"
                )
            }
        }
    }
}

impl std::error::Error for ExpressionInvariantError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvariantEvaluationError { error, .. } => Some(error),
            Self::MissingParsedExpression { .. } => None,
        }
    }
}

pub fn evaluate_expression_invariants(
    semantics: &Semantics,
    context: &Context,
    tick: u32,
) -> Result<Vec<ExpressionInvariantFire>, ExpressionInvariantError> {
    let mut fires = Vec::new();
    for (index, invariant) in semantics.invariants.iter().enumerate() {
        let ast = invariant.expr.ast.as_ref().ok_or_else(|| {
            ExpressionInvariantError::MissingParsedExpression {
                name: invariant.name.clone(),
            }
        })?;
        let result = evaluate(ast, context).map_err(|error| {
            ExpressionInvariantError::InvariantEvaluationError {
                name: invariant.name.clone(),
                error,
            }
        })?;
        let holds = match result {
            Value::Bool(value) => value,
            other => {
                return Err(ExpressionInvariantError::InvariantEvaluationError {
                    name: invariant.name.clone(),
                    error: EvalError::TypeMismatch {
                        expected: "bool".into(),
                        found: other.kind_name().into(),
                        span: ast.span,
                    },
                });
            }
        };
        if !holds {
            fires.push(ExpressionInvariantFire {
                tick,
                index,
                name: invariant.name.clone(),
                expr: invariant.expr.source.clone(),
                observed: observed_values(ast, context),
                severity: invariant.severity,
            });
        }
    }
    Ok(fires)
}

pub fn build_expression_invariants_summary(
    invariants: &[SemanticInvariant],
    fires: &[ExpressionInvariantFire],
) -> serde_json::Value {
    let entries: Vec<serde_json::Value> = invariants
        .iter()
        .enumerate()
        .map(|(index, invariant)| {
            let matching: Vec<&ExpressionInvariantFire> =
                fires.iter().filter(|fire| fire.index == index).collect();
            let first_tick = matching.iter().map(|fire| fire.tick).min();
            let mut entry = serde_json::Map::new();
            entry.insert(
                "name".into(),
                serde_json::Value::from(invariant.name.clone()),
            );
            entry.insert(
                "expr".into(),
                serde_json::Value::from(invariant.expr.source.clone()),
            );
            entry.insert(
                "severity".into(),
                serde_json::Value::from(invariant.severity.as_str()),
            );
            let firing_count = matching.len() as u64;
            let first_tick_value = first_tick
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null);
            entry.insert("firing_count".into(), serde_json::Value::from(firing_count));
            entry.insert("firings".into(), serde_json::Value::from(firing_count));
            entry.insert("first_tick".into(), first_tick_value.clone());
            entry.insert("first_fired_tick".into(), first_tick_value);
            entry.insert(
                "observed".into(),
                serde_json::Value::Array(
                    matching
                        .iter()
                        .take(3)
                        .map(|fire| {
                            let mut observed = serde_json::Map::new();
                            observed.insert("tick".into(), serde_json::Value::from(fire.tick));
                            observed.insert(
                                "values".into(),
                                serde_json::Value::Object(
                                    fire.observed
                                        .iter()
                                        .map(|(key, value)| (key.clone(), value.to_json()))
                                        .collect(),
                                ),
                            );
                            serde_json::Value::Object(observed)
                        })
                        .collect(),
                ),
            );
            serde_json::Value::Object(entry)
        })
        .collect();
    serde_json::Value::Array(entries)
}

fn observed_values(expr: &super::expr::Expr, context: &Context) -> BTreeMap<String, Value> {
    let mut observed = BTreeMap::new();
    for path in expr_identifiers(expr) {
        let key = path.join(".");
        if let Some(value) = context.get(&key).copied() {
            observed.insert(key, value);
        }
    }
    observed
}

#[cfg(test)]
mod tests {
    use crate::{
        adapter::{SemanticExpression, SemanticInvariantSeverity},
        semantics::{expr::parse, Value},
    };

    use super::*;

    fn expression(source: &str) -> SemanticExpression {
        let ast = parse(source).unwrap();
        SemanticExpression {
            source: source.into(),
            span: Some(ast.span),
            ast: Some(ast),
        }
    }

    fn invariant(name: &str, expr: &str, severity: SemanticInvariantSeverity) -> SemanticInvariant {
        SemanticInvariant {
            name: name.into(),
            expr: expression(expr),
            severity,
            description: None,
        }
    }

    #[test]
    fn fires_false_boolean_in_declaration_order() {
        let semantics = Semantics {
            class: Some("lending.v1".into()),
            roles: BTreeMap::new(),
            derived: BTreeMap::new(),
            invariants: vec![
                invariant(
                    "first",
                    "debt_value <= collateral_value",
                    SemanticInvariantSeverity::Warn,
                ),
                invariant(
                    "second",
                    "health_factor >= 1",
                    SemanticInvariantSeverity::Error,
                ),
            ],
            extensions: BTreeMap::new(),
            oracles: BTreeMap::new(),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: None,
            derived_order: Vec::new(),
        };
        let context = BTreeMap::from([
            ("collateral_value".into(), Value::U128(100)),
            ("debt_value".into(), Value::U128(120)),
            ("health_factor".into(), Value::U128(0)),
        ]);

        let fires = evaluate_expression_invariants(&semantics, &context, 7).unwrap();
        assert_eq!(fires.len(), 2);
        assert_eq!(fires[0].name, "first");
        assert_eq!(fires[1].name, "second");
        assert_eq!(fires[0].severity, SemanticInvariantSeverity::Warn);
        assert_eq!(fires[0].observed["debt_value"], Value::U128(120));
    }

    #[test]
    fn true_boolean_does_not_fire() {
        let semantics = Semantics {
            class: Some("lending.v1".into()),
            roles: BTreeMap::new(),
            derived: BTreeMap::new(),
            invariants: vec![invariant(
                "healthy",
                "debt_value <= collateral_value",
                SemanticInvariantSeverity::Error,
            )],
            extensions: BTreeMap::new(),
            oracles: BTreeMap::new(),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: None,
            derived_order: Vec::new(),
        };
        let context = BTreeMap::from([
            ("collateral_value".into(), Value::U128(100)),
            ("debt_value".into(), Value::U128(80)),
        ]);

        let fires = evaluate_expression_invariants(&semantics, &context, 1).unwrap();
        assert!(fires.is_empty());
    }

    #[test]
    fn non_boolean_result_is_evaluation_error() {
        let semantics = Semantics {
            class: Some("lending.v1".into()),
            roles: BTreeMap::new(),
            derived: BTreeMap::new(),
            invariants: vec![invariant(
                "bad_shape",
                "debt_value + 1",
                SemanticInvariantSeverity::Error,
            )],
            extensions: BTreeMap::new(),
            oracles: BTreeMap::new(),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: None,
            derived_order: Vec::new(),
        };
        let context = BTreeMap::from([("debt_value".into(), Value::U128(80))]);

        let err = evaluate_expression_invariants(&semantics, &context, 1).unwrap_err();
        assert!(matches!(
            err,
            ExpressionInvariantError::InvariantEvaluationError { .. }
        ));
    }
}
