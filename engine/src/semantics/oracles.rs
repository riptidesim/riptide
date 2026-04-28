use std::collections::BTreeMap;
use std::fmt;

use crate::adapter::Semantics;

use super::{eval::Context, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MultiOracleError {
    MissingField { path: String },
    NonNumericField { path: String },
    MultiOracleWeightsAllZero { role: String },
    IntegerOverflow { role: String },
}

impl fmt::Display for MultiOracleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingField { path } => write!(f, "missing oracle field `{path}`"),
            Self::NonNumericField { path } => write!(f, "oracle field `{path}` is not numeric"),
            Self::MultiOracleWeightsAllZero { role } => {
                write!(f, "MultiOracleWeightsAllZero(role={role})")
            }
            Self::IntegerOverflow { role } => {
                write!(f, "multi-oracle calculation overflowed for role `{role}`")
            }
        }
    }
}

impl std::error::Error for MultiOracleError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultiOracleEvaluation {
    pub synthetic_observations: BTreeMap<String, Value>,
    pub context: Context,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OracleTickValue {
    price: u128,
    weight: Option<u64>,
}

pub fn evaluate_multi_oracles(
    semantics: &Semantics,
    role_context: &Context,
) -> Result<MultiOracleEvaluation, MultiOracleError> {
    let mut context = role_context.clone();
    let mut synthetic_observations = BTreeMap::new();

    for (role, bindings) in &semantics.oracles {
        let mut prices = Vec::with_capacity(bindings.len());
        for (index, binding) in bindings.iter().enumerate() {
            let price = resolve_numeric_field(role_context, &[format!("{role}.{index}.price")])?;
            let confidence = resolve_field(role_context, &[format!("{role}.{index}.confidence")])?;
            let staleness = resolve_field(role_context, &[format!("{role}.{index}.staleness")])?;

            context.insert(format!("{role}.{index}.price"), Value::U128(price));
            context.insert(format!("{role}.{index}.confidence"), confidence);
            context.insert(format!("{role}.{index}.staleness"), staleness);
            prices.push(OracleTickValue {
                price,
                weight: binding.weight,
            });
        }

        if prices.is_empty() {
            continue;
        }

        let synthetic = if prices.iter().any(|value| value.weight.is_some()) {
            (
                format!("{role}.weighted_price"),
                Value::U128(weighted_price(role, &prices)?),
            )
        } else {
            (
                format!("{role}.median_price"),
                Value::U128(median_price(role, &prices)?),
            )
        };
        context.insert(synthetic.0.clone(), synthetic.1);
        synthetic_observations.insert(synthetic.0, synthetic.1);
    }

    Ok(MultiOracleEvaluation {
        synthetic_observations,
        context,
    })
}

fn resolve_field(context: &Context, candidates: &[String]) -> Result<Value, MultiOracleError> {
    for candidate in candidates {
        if let Some(value) = context.get(candidate).copied() {
            return Ok(value);
        }
    }
    Err(MultiOracleError::MissingField {
        path: candidates
            .last()
            .cloned()
            .unwrap_or_else(|| "<unknown>".into()),
    })
}

fn resolve_numeric_field(
    context: &Context,
    candidates: &[String],
) -> Result<u128, MultiOracleError> {
    let value = resolve_field(context, candidates)?;
    let path = candidates
        .iter()
        .find(|candidate| context.contains_key(*candidate))
        .cloned()
        .unwrap_or_else(|| "<unknown>".into());
    numeric_to_u128(value).ok_or(MultiOracleError::NonNumericField { path })
}

fn numeric_to_u128(value: Value) -> Option<u128> {
    match value {
        Value::U128(value) => Some(value),
        Value::I128(value) if value >= 0 => Some(value as u128),
        Value::I128(_) | Value::Bool(_) => None,
    }
}

fn weighted_price(role: &str, prices: &[OracleTickValue]) -> Result<u128, MultiOracleError> {
    let mut weighted_sum = 0u128;
    let mut weight_sum = 0u128;
    for value in prices {
        let weight = value.weight.unwrap_or(0) as u128;
        weight_sum = weight_sum
            .checked_add(weight)
            .ok_or_else(|| MultiOracleError::IntegerOverflow { role: role.into() })?;
        weighted_sum = weighted_sum
            .checked_add(
                value
                    .price
                    .checked_mul(weight)
                    .ok_or_else(|| MultiOracleError::IntegerOverflow { role: role.into() })?,
            )
            .ok_or_else(|| MultiOracleError::IntegerOverflow { role: role.into() })?;
    }
    if weight_sum == 0 {
        return Err(MultiOracleError::MultiOracleWeightsAllZero { role: role.into() });
    }
    Ok(weighted_sum / weight_sum)
}

fn median_price(role: &str, prices: &[OracleTickValue]) -> Result<u128, MultiOracleError> {
    let mut ordered: Vec<(u128, usize)> = prices
        .iter()
        .enumerate()
        .map(|(index, value)| (value.price, index))
        .collect();
    ordered.sort_by_key(|(price, index)| (*price, *index));

    let mid = ordered.len() / 2;
    if ordered.len() % 2 == 1 {
        return Ok(ordered[mid].0);
    }

    let lower = ordered[mid - 1].0;
    let upper = ordered[mid].0;
    lower
        .checked_add(upper)
        .map(|sum| sum / 2)
        .ok_or_else(|| MultiOracleError::IntegerOverflow { role: role.into() })
}

#[cfg(test)]
mod tests {
    use crate::{
        adapter::{OracleBinding, Semantics},
        semantics::Value,
    };

    use super::*;

    fn semantics(bindings: Vec<OracleBinding>) -> Semantics {
        Semantics {
            class: Some("lending.v1".into()),
            roles: BTreeMap::new(),
            derived: BTreeMap::new(),
            invariants: Vec::new(),
            extensions: BTreeMap::new(),
            oracles: BTreeMap::from([("oracle".into(), bindings)]),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: None,
            derived_order: Vec::new(),
        }
    }

    fn binding(weight: Option<u64>) -> OracleBinding {
        OracleBinding {
            program_id: "11111111111111111111111111111111".into(),
            account: "So11111111111111111111111111111111111111112".into(),
            confidence: "oracle.confidence".into(),
            staleness: "oracle.staleness".into(),
            weight,
        }
    }

    #[test]
    fn emits_weighted_price_and_indexed_fields() {
        let semantics = semantics(vec![binding(Some(3)), binding(Some(1))]);
        let context = BTreeMap::from([
            ("oracle.0.price".into(), Value::U128(80)),
            ("oracle.1.price".into(), Value::U128(120)),
            ("oracle.0.confidence".into(), Value::U128(7)),
            ("oracle.1.confidence".into(), Value::U128(8)),
            ("oracle.0.staleness".into(), Value::U128(2)),
            ("oracle.1.staleness".into(), Value::U128(3)),
        ]);

        let result = evaluate_multi_oracles(&semantics, &context).unwrap();

        assert_eq!(
            result.synthetic_observations.get("oracle.weighted_price"),
            Some(&Value::U128(90))
        );
        assert_eq!(
            result.context.get("oracle.1.price"),
            Some(&Value::U128(120))
        );
        assert_eq!(
            result.context.get("oracle.0.confidence"),
            Some(&Value::U128(7))
        );
    }

    #[test]
    fn emits_median_price_when_weights_are_absent() {
        let semantics = semantics(vec![binding(None), binding(None), binding(None)]);
        let context = BTreeMap::from([
            ("oracle.0.price".into(), Value::U128(120)),
            ("oracle.1.price".into(), Value::U128(90)),
            ("oracle.2.price".into(), Value::U128(110)),
            ("oracle.0.confidence".into(), Value::U128(0)),
            ("oracle.1.confidence".into(), Value::U128(0)),
            ("oracle.2.confidence".into(), Value::U128(0)),
            ("oracle.0.staleness".into(), Value::U128(0)),
            ("oracle.1.staleness".into(), Value::U128(0)),
            ("oracle.2.staleness".into(), Value::U128(0)),
        ]);

        let result = evaluate_multi_oracles(&semantics, &context).unwrap();

        assert_eq!(
            result.synthetic_observations.get("oracle.median_price"),
            Some(&Value::U128(110))
        );
    }
}
