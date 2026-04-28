use std::{cmp::Ordering, collections::BTreeMap, fmt};

use crate::{
    adapter::{CollectionDef, CollectionFormula, Semantics},
    semantics::{
        error::EvalError,
        eval::{evaluate, Context},
        Value,
    },
};

pub mod worst;

use worst::{WorstDirection, WorstDirectionError};

pub type RoleCollectionContexts = BTreeMap<String, Vec<Context>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectionValueKind {
    U128,
    I128,
    Bool,
    Unknown,
}

impl CollectionValueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::U128 => "u128",
            Self::I128 => "i128",
            Self::Bool => "bool",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_value(value: Value) -> Self {
        match value {
            Value::U128(_) => Self::U128,
            Value::I128(_) => Self::I128,
            Value::Bool(_) => Self::Bool,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmptyCollectionSentinel {
    pub value_kind: CollectionValueKind,
}

impl EmptyCollectionSentinel {
    pub fn new(value_kind: CollectionValueKind) -> Self {
        Self { value_kind }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionEvaluation {
    pub name: String,
    pub formula: CollectionFormula,
    pub value: Value,
    pub samples: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectionEvaluationError {
    UnknownFormula {
        name: String,
        formula: String,
    },
    MissingParsedExpression {
        name: String,
    },
    Evaluation {
        name: String,
        index: usize,
        error: EvalError,
    },
    EmptyCollection {
        name: String,
        over: String,
        formula: CollectionFormula,
        sentinel: EmptyCollectionSentinel,
    },
    TypeMismatch {
        name: String,
        index: usize,
        expected: String,
        found: String,
    },
    IntegerOverflow {
        name: String,
        formula: CollectionFormula,
    },
    WorstDirection {
        name: String,
        error: WorstDirectionError,
    },
}

impl fmt::Display for CollectionEvaluationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownFormula { name, formula } => {
                write!(f, "collection `{name}` uses unknown formula `{formula}`")
            }
            Self::MissingParsedExpression { name } => {
                write!(f, "collection `{name}` has no parsed expression AST")
            }
            Self::Evaluation { name, index, error } => write!(
                f,
                "collection `{name}` item {index} expression evaluation failed: {error}"
            ),
            Self::EmptyCollection {
                name,
                over,
                formula,
                sentinel,
            } => write!(
                f,
                "collection `{name}` over `{over}` is empty for formula `{}`; empty sentinel kind is `{}`",
                formula.as_str(),
                sentinel.value_kind.as_str()
            ),
            Self::TypeMismatch {
                name,
                index,
                expected,
                found,
            } => write!(
                f,
                "collection `{name}` item {index} type mismatch: expected {expected}, found {found}"
            ),
            Self::IntegerOverflow { name, formula } => write!(
                f,
                "collection `{name}` overflowed while applying formula `{}`",
                formula.as_str()
            ),
            Self::WorstDirection { name, error } => {
                write!(f, "collection `{name}` failed to resolve worst direction: {error}")
            }
        }
    }
}

impl std::error::Error for CollectionEvaluationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Evaluation { error, .. } => Some(error),
            Self::WorstDirection { error, .. } => Some(error),
            _ => None,
        }
    }
}

pub fn evaluate_semantic_collections(
    semantics: &Semantics,
    role_collections: &RoleCollectionContexts,
) -> Result<BTreeMap<String, CollectionEvaluation>, CollectionEvaluationError> {
    evaluate_semantic_collections_with_empty_kind(
        semantics,
        role_collections,
        CollectionValueKind::Unknown,
    )
}

pub fn evaluate_semantic_collections_with_empty_kind(
    semantics: &Semantics,
    role_collections: &RoleCollectionContexts,
    empty_value_kind: CollectionValueKind,
) -> Result<BTreeMap<String, CollectionEvaluation>, CollectionEvaluationError> {
    let mut out = BTreeMap::new();
    for (name, collection) in &semantics.collections {
        let contexts = role_collections
            .get(&collection.over)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let evaluation = evaluate_collection(
            semantics.class.as_deref(),
            name,
            collection,
            contexts,
            empty_value_kind,
        )?;
        out.insert(name.clone(), evaluation);
    }
    Ok(out)
}

pub fn evaluate_collection(
    semantic_class: Option<&str>,
    name: &str,
    collection: &CollectionDef,
    contexts: &[Context],
    empty_value_kind: CollectionValueKind,
) -> Result<CollectionEvaluation, CollectionEvaluationError> {
    let formula = collection_formula(name, collection)?;
    if contexts.is_empty() {
        return Err(CollectionEvaluationError::EmptyCollection {
            name: name.to_string(),
            over: collection.over.clone(),
            formula,
            sentinel: EmptyCollectionSentinel::new(empty_value_kind),
        });
    }

    let expr = collection.expr_ast.as_ref().ok_or_else(|| {
        CollectionEvaluationError::MissingParsedExpression {
            name: name.to_string(),
        }
    })?;

    let worst_direction = if formula == CollectionFormula::Worst {
        Some(
            worst::resolve_direction(semantic_class, name, expr).map_err(|error| {
                CollectionEvaluationError::WorstDirection {
                    name: name.to_string(),
                    error,
                }
            })?,
        )
    } else {
        None
    };

    let values = contexts
        .iter()
        .enumerate()
        .map(|(index, context)| {
            evaluate(expr, context).map_err(|error| CollectionEvaluationError::Evaluation {
                name: name.to_string(),
                index,
                error,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let value = match formula {
        CollectionFormula::Sum => sum_values(name, formula, &values)?,
        CollectionFormula::Min => extreme_value(name, &values, WorstDirection::Min)?,
        CollectionFormula::Max => extreme_value(name, &values, WorstDirection::Max)?,
        CollectionFormula::Worst => extreme_value(
            name,
            &values,
            worst_direction.expect("worst direction resolved above"),
        )?,
    };

    Ok(CollectionEvaluation {
        name: name.to_string(),
        formula,
        value,
        samples: values.len(),
    })
}

fn collection_formula(
    name: &str,
    collection: &CollectionDef,
) -> Result<CollectionFormula, CollectionEvaluationError> {
    collection
        .formula_ref
        .or_else(|| CollectionFormula::parse(&collection.formula))
        .ok_or_else(|| CollectionEvaluationError::UnknownFormula {
            name: name.to_string(),
            formula: collection.formula.clone(),
        })
}

fn sum_values(
    name: &str,
    formula: CollectionFormula,
    values: &[Value],
) -> Result<Value, CollectionEvaluationError> {
    let mut accumulator = match values[0] {
        Value::U128(value) => SumAccumulator::U128(value),
        Value::I128(value) => SumAccumulator::I128(value),
        Value::Bool(_) => {
            return Err(type_mismatch(
                name,
                0,
                "integer",
                CollectionValueKind::Bool.as_str(),
            ))
        }
    };

    for (index, value) in values.iter().copied().enumerate().skip(1) {
        accumulator = accumulator.add(value).map_err(|error| match error {
            SumError::TypeMismatch { found } => type_mismatch(name, index, "integer", found),
            SumError::Overflow => CollectionEvaluationError::IntegerOverflow {
                name: name.to_string(),
                formula,
            },
        })?;
    }

    Ok(accumulator.into_value())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SumAccumulator {
    U128(u128),
    I128(i128),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SumError {
    TypeMismatch { found: &'static str },
    Overflow,
}

impl SumAccumulator {
    fn add(self, value: Value) -> Result<Self, SumError> {
        match (self, value) {
            (Self::U128(left), Value::U128(right)) => left
                .checked_add(right)
                .map(Self::U128)
                .ok_or(SumError::Overflow),
            (Self::U128(left), Value::I128(right)) => {
                let left = i128::try_from(left).map_err(|_| SumError::Overflow)?;
                left.checked_add(right)
                    .map(Self::I128)
                    .ok_or(SumError::Overflow)
            }
            (Self::I128(left), Value::U128(right)) => {
                let right = i128::try_from(right).map_err(|_| SumError::Overflow)?;
                left.checked_add(right)
                    .map(Self::I128)
                    .ok_or(SumError::Overflow)
            }
            (Self::I128(left), Value::I128(right)) => left
                .checked_add(right)
                .map(Self::I128)
                .ok_or(SumError::Overflow),
            (_, Value::Bool(_)) => Err(SumError::TypeMismatch { found: "bool" }),
        }
    }

    fn into_value(self) -> Value {
        match self {
            Self::U128(value) => Value::U128(value),
            Self::I128(value) => Value::I128(value),
        }
    }
}

fn extreme_value(
    name: &str,
    values: &[Value],
    direction: WorstDirection,
) -> Result<Value, CollectionEvaluationError> {
    ensure_numeric(name, 0, values[0])?;
    let mut best = values[0];

    for (index, value) in values.iter().copied().enumerate().skip(1) {
        ensure_numeric(name, index, value)?;
        let ordering = compare_numeric(best, value);
        let replace = match direction {
            WorstDirection::Min => ordering == Ordering::Greater,
            WorstDirection::Max => ordering == Ordering::Less,
        };
        if replace {
            best = value;
        }
    }

    Ok(best)
}

fn ensure_numeric(name: &str, index: usize, value: Value) -> Result<(), CollectionEvaluationError> {
    if matches!(value, Value::Bool(_)) {
        Err(type_mismatch(name, index, "integer", "bool"))
    } else {
        Ok(())
    }
}

fn compare_numeric(left: Value, right: Value) -> Ordering {
    match (left, right) {
        (Value::U128(left), Value::U128(right)) => left.cmp(&right),
        (Value::I128(left), Value::I128(right)) => left.cmp(&right),
        (Value::U128(_), Value::I128(right)) if right < 0 => Ordering::Greater,
        (Value::I128(left), Value::U128(_)) if left < 0 => Ordering::Less,
        (Value::U128(left), Value::I128(right)) => left.cmp(&(right as u128)),
        (Value::I128(left), Value::U128(right)) => (left as u128).cmp(&right),
        (Value::Bool(_), _) | (_, Value::Bool(_)) => {
            unreachable!("bool values are rejected before comparison")
        }
    }
}

fn type_mismatch(
    name: &str,
    index: usize,
    expected: &str,
    found: &str,
) -> CollectionEvaluationError {
    CollectionEvaluationError::TypeMismatch {
        name: name.to_string(),
        index,
        expected: expected.to_string(),
        found: found.to_string(),
    }
}
