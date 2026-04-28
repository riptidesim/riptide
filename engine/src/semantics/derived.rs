use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::adapter::{SemanticExpression, SemanticRole, Semantics};

use super::{
    error::EvalError,
    eval::{evaluate, Context},
    expr::{Expr, ExprKind},
    Value,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DerivedObservationError {
    DerivedObservationCycle { path: Vec<String> },
    UnknownIdentifier { name: String },
    MissingParsedExpression { name: String },
    Evaluation { name: String, error: EvalError },
}

impl fmt::Display for DerivedObservationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DerivedObservationCycle { path } => {
                write!(f, "DerivedObservationCycle({path:?})")
            }
            Self::UnknownIdentifier { name } => {
                write!(f, "unknown semantic identifier `{name}`")
            }
            Self::MissingParsedExpression { name } => {
                write!(
                    f,
                    "derived observation `{name}` has no parsed expression AST"
                )
            }
            Self::Evaluation { name, error } => {
                write!(f, "derived observation `{name}` evaluation failed: {error}")
            }
        }
    }
}

impl std::error::Error for DerivedObservationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Evaluation { error, .. } => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedObservationResult {
    pub observations: BTreeMap<String, Value>,
    pub context: Context,
}

pub fn build_derived_order(
    derived: &BTreeMap<String, SemanticExpression>,
    roles: &BTreeMap<String, SemanticRole>,
) -> Result<Vec<String>, DerivedObservationError> {
    let derived_names: BTreeSet<&str> = derived.keys().map(String::as_str).collect();
    let mut dependencies: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut dependents: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for (name, expression) in derived {
        let ast = expression.ast.as_ref().ok_or_else(|| {
            DerivedObservationError::MissingParsedExpression { name: name.clone() }
        })?;
        let mut deps = BTreeSet::new();
        for path in expr_identifiers(ast) {
            if path.len() == 1 {
                let ident = path[0].as_str();
                if derived_names.contains(ident) {
                    deps.insert(ident.to_string());
                } else {
                    return Err(DerivedObservationError::UnknownIdentifier {
                        name: ident.to_string(),
                    });
                }
            } else if !role_field_exists(roles, &path) {
                return Err(DerivedObservationError::UnknownIdentifier {
                    name: path.join("."),
                });
            }
        }
        dependencies.insert(name.clone(), deps);
    }

    for (name, deps) in &dependencies {
        dependents.entry(name.clone()).or_default();
        for dep in deps {
            dependents
                .entry(dep.clone())
                .or_default()
                .insert(name.clone());
        }
    }

    let mut ready: BTreeSet<String> = dependencies
        .iter()
        .filter_map(|(name, deps)| {
            if deps.is_empty() {
                Some(name.clone())
            } else {
                None
            }
        })
        .collect();
    let mut order = Vec::with_capacity(derived.len());
    let mut remaining = dependencies;

    while let Some(name) = ready.pop_first() {
        if remaining.remove(&name).is_none() {
            continue;
        }
        order.push(name.clone());
        if let Some(children) = dependents.get(&name) {
            for child in children {
                if let Some(child_deps) = remaining.get_mut(child) {
                    child_deps.remove(&name);
                    if child_deps.is_empty() {
                        ready.insert(child.clone());
                    }
                }
            }
        }
    }

    if !remaining.is_empty() {
        return Err(DerivedObservationError::DerivedObservationCycle {
            path: find_cycle(&remaining),
        });
    }

    Ok(order)
}

pub fn evaluate_derived_observations(
    semantics: &Semantics,
    role_context: &Context,
) -> Result<DerivedObservationResult, DerivedObservationError> {
    let mut context = role_context.clone();
    let mut observations = BTreeMap::new();
    let order: Vec<String> = if semantics.derived_order.is_empty() {
        semantics.derived.keys().cloned().collect()
    } else {
        semantics.derived_order.clone()
    };

    for name in order {
        let expression = semantics.derived.get(&name).ok_or_else(|| {
            DerivedObservationError::MissingParsedExpression { name: name.clone() }
        })?;
        let ast = expression.ast.as_ref().ok_or_else(|| {
            DerivedObservationError::MissingParsedExpression { name: name.clone() }
        })?;
        let value =
            evaluate(ast, &context).map_err(|error| DerivedObservationError::Evaluation {
                name: name.clone(),
                error,
            })?;
        context.insert(name.clone(), value);
        observations.insert(name, value);
    }

    Ok(DerivedObservationResult {
        observations,
        context,
    })
}

pub fn expr_identifiers(expr: &Expr) -> BTreeSet<Vec<String>> {
    let mut out = BTreeSet::new();
    collect_identifiers(expr, &mut out);
    out
}

fn collect_identifiers(expr: &Expr, out: &mut BTreeSet<Vec<String>>) {
    match &expr.kind {
        ExprKind::Identifier(path) => {
            out.insert(path.clone());
        }
        ExprKind::Unary { expr, .. } => collect_identifiers(expr, out),
        ExprKind::Binary { left, right, .. } => {
            collect_identifiers(left, out);
            collect_identifiers(right, out);
        }
        ExprKind::Call { args, .. } => {
            for arg in args {
                collect_identifiers(arg, out);
            }
        }
        ExprKind::Literal(_) | ExprKind::Decimal(_) => {}
    }
}

fn role_field_exists(roles: &BTreeMap<String, SemanticRole>, path: &[String]) -> bool {
    if path.len() != 2 {
        return false;
    }
    roles
        .get(&path[0])
        .map(|role| role.fields.contains_key(&path[1]))
        .unwrap_or(false)
}

fn find_cycle(graph: &BTreeMap<String, BTreeSet<String>>) -> Vec<String> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mark {
        Visiting,
        Visited,
    }

    fn visit(
        name: &str,
        graph: &BTreeMap<String, BTreeSet<String>>,
        marks: &mut BTreeMap<String, Mark>,
        stack: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if matches!(marks.get(name), Some(Mark::Visited)) {
            return None;
        }
        if matches!(marks.get(name), Some(Mark::Visiting)) {
            let start = stack.iter().position(|node| node == name).unwrap_or(0);
            let mut cycle = stack[start..].to_vec();
            cycle.push(name.to_string());
            return Some(cycle);
        }

        marks.insert(name.to_string(), Mark::Visiting);
        stack.push(name.to_string());
        if let Some(deps) = graph.get(name) {
            for dep in deps {
                if graph.contains_key(dep) {
                    if let Some(cycle) = visit(dep, graph, marks, stack) {
                        return Some(cycle);
                    }
                }
            }
        }
        stack.pop();
        marks.insert(name.to_string(), Mark::Visited);
        None
    }

    let mut marks = BTreeMap::new();
    let mut stack = Vec::new();
    for name in graph.keys() {
        if let Some(cycle) = visit(name, graph, &mut marks, &mut stack) {
            return cycle;
        }
    }
    graph.keys().cloned().collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{
        adapter::{SemanticExpression, SemanticFieldType, SemanticRole},
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

    fn role(fields: &[&str]) -> SemanticRole {
        SemanticRole {
            source: "account.test".into(),
            fields: fields
                .iter()
                .map(|field| ((*field).to_string(), SemanticFieldType::U128))
                .collect(),
            binding: None,
        }
    }

    #[test]
    fn topo_order_is_lexicographic_for_independent_nodes() {
        let derived = BTreeMap::from([
            ("z_value".into(), expression("position.debt_amount")),
            ("a_value".into(), expression("position.collateral_amount")),
            ("m_value".into(), expression("a_value + z_value")),
        ]);
        let roles = BTreeMap::from([(
            "position".into(),
            role(&["collateral_amount", "debt_amount"]),
        )]);

        let order = build_derived_order(&derived, &roles).unwrap();
        assert_eq!(order, vec!["a_value", "z_value", "m_value"]);
    }

    #[test]
    fn detects_named_cycles() {
        let derived = BTreeMap::from([
            ("health".into(), expression("buffer + 1")),
            ("buffer".into(), expression("health + 1")),
        ]);
        let roles = BTreeMap::new();

        let err = build_derived_order(&derived, &roles).unwrap_err();
        let DerivedObservationError::DerivedObservationCycle { path } = err else {
            panic!("expected cycle");
        };
        assert!(path.contains(&"health".to_string()));
        assert!(path.contains(&"buffer".to_string()));
    }

    #[test]
    fn evaluates_in_topological_order() {
        let mut semantics = Semantics {
            class: Some("lending.v1".into()),
            roles: BTreeMap::new(),
            derived: BTreeMap::from([
                ("debt_value".into(), expression("position.debt_amount")),
                (
                    "collateral_value".into(),
                    expression("position.collateral_amount * oracle.price"),
                ),
                (
                    "max_borrow_value".into(),
                    expression("collateral_value * reserve.max_ltv_bps / 10000"),
                ),
            ]),
            invariants: Vec::new(),
            extensions: BTreeMap::new(),
            oracles: BTreeMap::new(),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: None,
            derived_order: Vec::new(),
        };
        semantics.derived_order = vec![
            "collateral_value".into(),
            "debt_value".into(),
            "max_borrow_value".into(),
        ];
        let context = BTreeMap::from([
            ("position.collateral_amount".into(), Value::U128(10)),
            ("position.debt_amount".into(), Value::U128(500)),
            ("oracle.price".into(), Value::U128(100)),
            ("reserve.max_ltv_bps".into(), Value::U128(7_000)),
        ]);

        let result = evaluate_derived_observations(&semantics, &context).unwrap();
        assert_eq!(
            result.observations.get("collateral_value"),
            Some(&Value::U128(1_000))
        );
        assert_eq!(
            result.observations.get("max_borrow_value"),
            Some(&Value::U128(700))
        );
        assert_eq!(
            result.context.get("collateral_value"),
            Some(&Value::U128(1_000))
        );
    }
}
