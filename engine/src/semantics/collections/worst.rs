use std::collections::BTreeSet;
use std::fmt;

use crate::semantics::expr::{Expr, ExprKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorstDirection {
    Min,
    Max,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorstDirectionError {
    UnknownSemanticClass { class: Option<String> },
    UnknownLendingMetric { metric_hint: String },
    AmbiguousLendingMetrics { metrics: Vec<String> },
}

impl fmt::Display for WorstDirectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSemanticClass { class } => {
                let class = class.as_deref().unwrap_or("<missing>");
                write!(
                    f,
                    "no collection `worst` direction is defined for semantic class `{class}`"
                )
            }
            Self::UnknownLendingMetric { metric_hint } => write!(
                f,
                "lending.v1 collection `worst` has no direction for metric `{metric_hint}`"
            ),
            Self::AmbiguousLendingMetrics { metrics } => write!(
                f,
                "lending.v1 collection `worst` matched conflicting metrics: {}",
                metrics.join(", ")
            ),
        }
    }
}

impl std::error::Error for WorstDirectionError {}

pub fn resolve_direction(
    class: Option<&str>,
    collection_name: &str,
    expr: &Expr,
) -> Result<WorstDirection, WorstDirectionError> {
    match class {
        Some("lending.v1") => lending_v1_direction(collection_name, expr),
        other => Err(WorstDirectionError::UnknownSemanticClass {
            class: other.map(str::to_string),
        }),
    }
}

fn lending_v1_direction(
    collection_name: &str,
    expr: &Expr,
) -> Result<WorstDirection, WorstDirectionError> {
    let metrics = lending_metric_candidates(collection_name, expr);
    let has_min_metric = metrics
        .iter()
        .any(|metric| lending_metric_direction(metric) == Some(WorstDirection::Min));
    let has_max_metric = metrics
        .iter()
        .any(|metric| lending_metric_direction(metric) == Some(WorstDirection::Max));

    match (has_min_metric, has_max_metric) {
        (true, false) => Ok(WorstDirection::Min),
        (false, true) => Ok(WorstDirection::Max),
        (true, true) => Err(WorstDirectionError::AmbiguousLendingMetrics {
            metrics: metrics.into_iter().collect(),
        }),
        (false, false) => Err(WorstDirectionError::UnknownLendingMetric {
            metric_hint: collection_name.to_string(),
        }),
    }
}

fn lending_metric_direction(metric: &str) -> Option<WorstDirection> {
    match metric {
        "health_factor" | "collateral_ratio" => Some(WorstDirection::Min),
        "bad_debt_ratio" | "utilization" => Some(WorstDirection::Max),
        _ => None,
    }
}

fn lending_metric_candidates(collection_name: &str, expr: &Expr) -> BTreeSet<String> {
    let mut candidates = BTreeSet::new();
    collect_metric_hint(collection_name, &mut candidates);
    collect_expr_metric_hints(expr, &mut candidates);
    candidates
}

fn collect_metric_hint(value: &str, out: &mut BTreeSet<String>) {
    for metric in [
        "health_factor",
        "collateral_ratio",
        "bad_debt_ratio",
        "utilization",
    ] {
        if value == metric || value.ends_with(&format!("_{metric}")) {
            out.insert(metric.to_string());
        }
    }
}

fn collect_expr_metric_hints(expr: &Expr, out: &mut BTreeSet<String>) {
    match &expr.kind {
        ExprKind::Identifier(path) => {
            if let Some(last) = path.last() {
                collect_metric_hint(last, out);
            }
        }
        ExprKind::Unary { expr, .. } => collect_expr_metric_hints(expr, out),
        ExprKind::Binary { left, right, .. } => {
            collect_expr_metric_hints(left, out);
            collect_expr_metric_hints(right, out);
        }
        ExprKind::Call { args, .. } => {
            for arg in args {
                collect_expr_metric_hints(arg, out);
            }
        }
        ExprKind::Literal(_) | ExprKind::Decimal(_) => {}
    }
}
