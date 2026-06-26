use std::{cmp::Ordering, collections::BTreeMap};

use super::{
    error::{EvalError, Span},
    expr::{BinaryOp, DecimalLiteral, Expr, ExprKind, UnaryOp},
    Value, RATIO_SCALE,
};

pub type Context = BTreeMap<String, Value>;

pub fn evaluate(expr: &Expr, context: &Context) -> Result<Value, EvalError> {
    Evaluator { context }.eval(expr)?.into_public(expr.span)
}

struct Evaluator<'a> {
    context: &'a Context,
}

impl Evaluator<'_> {
    fn eval(&self, expr: &Expr) -> Result<EvalValue, EvalError> {
        match &expr.kind {
            ExprKind::Literal(value) => Ok(EvalValue::Value(*value)),
            ExprKind::Decimal(decimal) => {
                Ratio::from_decimal(*decimal, expr.span).map(EvalValue::Ratio)
            }
            ExprKind::Identifier(path) => self.lookup(path, expr.span),
            ExprKind::Unary { op, expr: inner } => {
                let value = self.eval(inner)?;
                match op {
                    UnaryOp::Not => match value {
                        EvalValue::Value(Value::Bool(value)) => {
                            Ok(EvalValue::Value(Value::Bool(!value)))
                        }
                        other => Err(type_mismatch("bool", other.kind_name(), expr.span)),
                    },
                    UnaryOp::Neg => negate(value, expr.span),
                }
            }
            ExprKind::Binary { op, left, right } => match op {
                BinaryOp::And => self.eval_and(left, right, expr.span),
                BinaryOp::Or => self.eval_or(left, right, expr.span),
                BinaryOp::Eq | BinaryOp::NotEq => {
                    let left = self.eval(left)?;
                    let right = self.eval(right)?;
                    let equal = values_equal(left, right, expr.span)?;
                    Ok(EvalValue::Value(Value::Bool(
                        if matches!(op, BinaryOp::Eq) {
                            equal
                        } else {
                            !equal
                        },
                    )))
                }
                BinaryOp::Lt | BinaryOp::Lte | BinaryOp::Gt | BinaryOp::Gte => {
                    let left = self.eval(left)?;
                    let right = self.eval(right)?;
                    let ordering = compare_numeric(left, right, expr.span)?;
                    let ok = match op {
                        BinaryOp::Lt => ordering == Ordering::Less,
                        BinaryOp::Lte => matches!(ordering, Ordering::Less | Ordering::Equal),
                        BinaryOp::Gt => ordering == Ordering::Greater,
                        BinaryOp::Gte => matches!(ordering, Ordering::Greater | Ordering::Equal),
                        _ => unreachable!("comparison branch only"),
                    };
                    Ok(EvalValue::Value(Value::Bool(ok)))
                }
                BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div => {
                    let left = self.eval(left)?;
                    let right = self.eval(right)?;
                    eval_arithmetic(*op, left, right, expr.span)
                }
            },
            ExprKind::Call { name, args } => self.call(name, args, expr.span),
        }
    }

    fn lookup(&self, path: &[String], span: Span) -> Result<EvalValue, EvalError> {
        let joined = path.join(".");
        self.context
            .get(&joined)
            .copied()
            .map(EvalValue::Value)
            .ok_or_else(|| {
                if path.len() == 1 {
                    EvalError::UnknownIdentifier { name: joined, span }
                } else {
                    EvalError::MissingField { path: joined, span }
                }
            })
    }

    fn eval_and(&self, left: &Expr, right: &Expr, span: Span) -> Result<EvalValue, EvalError> {
        let left = self.eval(left)?;
        let EvalValue::Value(Value::Bool(left)) = left else {
            return Err(type_mismatch("bool", left.kind_name(), span));
        };
        if !left {
            return Ok(EvalValue::Value(Value::Bool(false)));
        }
        let right = self.eval(right)?;
        let EvalValue::Value(Value::Bool(right)) = right else {
            return Err(type_mismatch("bool", right.kind_name(), span));
        };
        Ok(EvalValue::Value(Value::Bool(right)))
    }

    fn eval_or(&self, left: &Expr, right: &Expr, span: Span) -> Result<EvalValue, EvalError> {
        let left = self.eval(left)?;
        let EvalValue::Value(Value::Bool(left)) = left else {
            return Err(type_mismatch("bool", left.kind_name(), span));
        };
        if left {
            return Ok(EvalValue::Value(Value::Bool(true)));
        }
        let right = self.eval(right)?;
        let EvalValue::Value(Value::Bool(right)) = right else {
            return Err(type_mismatch("bool", right.kind_name(), span));
        };
        Ok(EvalValue::Value(Value::Bool(right)))
    }

    fn call(&self, name: &str, args: &[Expr], span: Span) -> Result<EvalValue, EvalError> {
        match name {
            "min" | "max" => {
                expect_arity(2, args.len(), span)?;
                let left = self.eval(&args[0])?;
                let right = self.eval(&args[1])?;
                let ordering = compare_numeric(left, right, span)?;
                let pick_left = if name == "min" {
                    matches!(ordering, Ordering::Less | Ordering::Equal)
                } else {
                    matches!(ordering, Ordering::Greater | Ordering::Equal)
                };
                Ok(if pick_left { left } else { right })
            }
            "abs" => {
                expect_arity(1, args.len(), span)?;
                match self.eval(&args[0])? {
                    EvalValue::Value(Value::U128(value)) => {
                        Ok(EvalValue::Value(Value::U128(value)))
                    }
                    EvalValue::Value(Value::I128(value)) => {
                        let magnitude = value
                            .checked_abs()
                            .ok_or(EvalError::IntegerOverflow { span })?
                            as u128;
                        Ok(EvalValue::Value(Value::U128(magnitude)))
                    }
                    EvalValue::Ratio(_) => Err(type_mismatch("integer", "ratio", span)),
                    EvalValue::Value(Value::Bool(_)) => Err(type_mismatch("integer", "bool", span)),
                }
            }
            "bps_to_ratio" => {
                expect_arity(1, args.len(), span)?;
                let bps = match self.eval(&args[0])? {
                    EvalValue::Value(Value::U128(value)) => value,
                    EvalValue::Value(Value::I128(value)) if value >= 0 => value as u128,
                    EvalValue::Value(Value::I128(_)) => {
                        return Err(type_mismatch(
                            "non-negative integer basis points",
                            "negative i128",
                            span,
                        ))
                    }
                    EvalValue::Value(Value::Bool(_)) => {
                        return Err(type_mismatch(
                            "non-negative integer basis points",
                            "bool",
                            span,
                        ))
                    }
                    EvalValue::Ratio(_) => {
                        return Err(type_mismatch(
                            "non-negative integer basis points",
                            "ratio",
                            span,
                        ))
                    }
                };
                Ok(EvalValue::Ratio(Ratio::new(bps, 10_000)))
            }
            _ => Err(EvalError::UnknownHelper {
                name: name.to_string(),
                span,
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EvalValue {
    Value(Value),
    Ratio(Ratio),
}

impl EvalValue {
    fn into_public(self, span: Span) -> Result<Value, EvalError> {
        match self {
            Self::Value(value) => Ok(value),
            Self::Ratio(ratio) => ratio.to_scaled_u128(span).map(Value::U128),
        }
    }

    fn kind_name(&self) -> &'static str {
        match self {
            Self::Value(value) => value.kind_name(),
            Self::Ratio(_) => "ratio",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ratio {
    numerator: u128,
    denominator: u128,
}

impl Ratio {
    fn new(numerator: u128, denominator: u128) -> Self {
        debug_assert!(denominator > 0);
        let divisor = gcd(numerator, denominator);
        Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        }
    }

    fn from_u128(value: u128) -> Self {
        Self::new(value, 1)
    }

    fn from_i128(value: i128, span: Span) -> Result<Self, EvalError> {
        if value < 0 {
            return Err(type_mismatch(
                "non-negative integer or ratio",
                "negative i128",
                span,
            ));
        }
        Ok(Self::from_u128(value as u128))
    }

    fn from_decimal(decimal: DecimalLiteral, span: Span) -> Result<Self, EvalError> {
        let denominator = decimal
            .denominator()
            .ok_or(EvalError::IntegerOverflow { span })?;
        Ok(Self::new(decimal.mantissa, denominator))
    }

    fn to_scaled_u128(self, span: Span) -> Result<u128, EvalError> {
        checked_mul_div_u128(self.numerator, RATIO_SCALE, self.denominator)
            .ok_or(EvalError::IntegerOverflow { span })
    }
}

fn expect_arity(expected: usize, found: usize, span: Span) -> Result<(), EvalError> {
    if expected == found {
        Ok(())
    } else {
        Err(EvalError::Arity {
            expected,
            found,
            span,
        })
    }
}

fn negate(value: EvalValue, span: Span) -> Result<EvalValue, EvalError> {
    match value {
        EvalValue::Value(Value::U128(value)) if value == (i128::MAX as u128) + 1 => {
            Ok(EvalValue::Value(Value::I128(i128::MIN)))
        }
        EvalValue::Value(Value::U128(value)) if value <= i128::MAX as u128 => {
            Ok(EvalValue::Value(Value::I128(-(value as i128))))
        }
        EvalValue::Value(Value::U128(_)) => Err(EvalError::IntegerOverflow { span }),
        EvalValue::Value(Value::I128(value)) => value
            .checked_neg()
            .map(Value::I128)
            .map(EvalValue::Value)
            .ok_or(EvalError::IntegerOverflow { span }),
        EvalValue::Value(Value::Bool(_)) => Err(type_mismatch("integer", "bool", span)),
        EvalValue::Ratio(_) => Err(type_mismatch("integer", "ratio", span)),
    }
}

fn values_equal(left: EvalValue, right: EvalValue, span: Span) -> Result<bool, EvalError> {
    match (left, right) {
        (EvalValue::Value(Value::Bool(left)), EvalValue::Value(Value::Bool(right))) => {
            Ok(left == right)
        }
        (EvalValue::Value(Value::U128(left)), EvalValue::Value(Value::U128(right))) => {
            Ok(left == right)
        }
        (EvalValue::Value(Value::I128(left)), EvalValue::Value(Value::I128(right))) => {
            Ok(left == right)
        }
        (EvalValue::Value(Value::U128(left)), EvalValue::Value(Value::I128(right)))
        | (EvalValue::Value(Value::I128(right)), EvalValue::Value(Value::U128(left))) => {
            Ok(right >= 0 && left == right as u128)
        }
        (EvalValue::Ratio(left), EvalValue::Ratio(right)) => {
            Ok(compare_ratios(left, right) == Ordering::Equal)
        }
        (EvalValue::Ratio(left), EvalValue::Value(Value::U128(right)))
        | (EvalValue::Value(Value::U128(right)), EvalValue::Ratio(left)) => {
            Ok(compare_ratio_to_u128(left, right) == Ordering::Equal)
        }
        (EvalValue::Ratio(left), EvalValue::Value(Value::I128(right)))
        | (EvalValue::Value(Value::I128(right)), EvalValue::Ratio(left)) => {
            Ok(right >= 0 && compare_ratio_to_u128(left, right as u128) == Ordering::Equal)
        }
        (left, right) => Err(type_mismatch(
            "matching numeric or bool operands",
            &format!("{} and {}", left.kind_name(), right.kind_name()),
            span,
        )),
    }
}

fn compare_numeric(left: EvalValue, right: EvalValue, span: Span) -> Result<Ordering, EvalError> {
    match (left, right) {
        (EvalValue::Value(Value::Bool(_)), other) | (other, EvalValue::Value(Value::Bool(_))) => {
            Err(type_mismatch(
                "integer or ratio",
                &format!("{} and bool", other.kind_name()),
                span,
            ))
        }
        (EvalValue::Value(Value::U128(left)), EvalValue::Value(Value::U128(right))) => {
            Ok(left.cmp(&right))
        }
        (EvalValue::Value(Value::I128(left)), EvalValue::Value(Value::I128(right))) => {
            Ok(left.cmp(&right))
        }
        (EvalValue::Value(Value::U128(_)), EvalValue::Value(Value::I128(right))) if right < 0 => {
            Ok(Ordering::Greater)
        }
        (EvalValue::Value(Value::I128(left)), EvalValue::Value(Value::U128(_))) if left < 0 => {
            Ok(Ordering::Less)
        }
        (EvalValue::Value(Value::U128(left)), EvalValue::Value(Value::I128(right))) => {
            Ok(left.cmp(&(right as u128)))
        }
        (EvalValue::Value(Value::I128(left)), EvalValue::Value(Value::U128(right))) => {
            Ok((left as u128).cmp(&right))
        }
        (EvalValue::Ratio(left), EvalValue::Ratio(right)) => Ok(compare_ratios(left, right)),
        (EvalValue::Ratio(left), EvalValue::Value(Value::U128(right))) => {
            Ok(compare_ratio_to_u128(left, right))
        }
        (EvalValue::Value(Value::U128(left)), EvalValue::Ratio(right)) => {
            Ok(compare_ratio_to_u128(right, left).reverse())
        }
        (EvalValue::Ratio(_), EvalValue::Value(Value::I128(right))) if right < 0 => {
            Ok(Ordering::Greater)
        }
        (EvalValue::Value(Value::I128(left)), EvalValue::Ratio(_)) if left < 0 => {
            Ok(Ordering::Less)
        }
        (EvalValue::Ratio(left), EvalValue::Value(Value::I128(right))) => {
            Ok(compare_ratio_to_u128(left, right as u128))
        }
        (EvalValue::Value(Value::I128(left)), EvalValue::Ratio(right)) => {
            Ok(compare_ratio_to_u128(right, left as u128).reverse())
        }
    }
}

fn eval_arithmetic(
    op: BinaryOp,
    left: EvalValue,
    right: EvalValue,
    span: Span,
) -> Result<EvalValue, EvalError> {
    match (left, right) {
        (EvalValue::Value(Value::Bool(_)), other) | (other, EvalValue::Value(Value::Bool(_))) => {
            Err(type_mismatch(
                "integer or ratio",
                &format!("{} and bool", other.kind_name()),
                span,
            ))
        }
        (EvalValue::Ratio(left), EvalValue::Ratio(right)) => {
            eval_ratio_ratio(op, left, right, span)
        }
        (EvalValue::Ratio(left), EvalValue::Value(right)) => {
            eval_ratio_value(op, left, right, span)
        }
        (EvalValue::Value(left), EvalValue::Ratio(right)) => {
            eval_value_ratio(op, left, right, span)
        }
        (EvalValue::Value(Value::U128(left)), EvalValue::Value(Value::U128(right))) => {
            eval_u128(op, left, right, span)
        }
        (EvalValue::Value(left), EvalValue::Value(right)) => {
            let left = to_i128(left, span)?;
            let right = to_i128(right, span)?;
            eval_i128(op, left, right, span)
        }
    }
}

fn eval_u128(op: BinaryOp, left: u128, right: u128, span: Span) -> Result<EvalValue, EvalError> {
    match op {
        BinaryOp::Add => left
            .checked_add(right)
            .map(Value::U128)
            .map(EvalValue::Value)
            .ok_or(EvalError::IntegerOverflow { span }),
        BinaryOp::Sub if left >= right => Ok(EvalValue::Value(Value::U128(left - right))),
        BinaryOp::Sub => {
            let diff = right - left;
            if diff == (i128::MAX as u128) + 1 {
                Ok(EvalValue::Value(Value::I128(i128::MIN)))
            } else if diff <= i128::MAX as u128 {
                Ok(EvalValue::Value(Value::I128(-(diff as i128))))
            } else {
                Err(EvalError::IntegerOverflow { span })
            }
        }
        BinaryOp::Mul => left
            .checked_mul(right)
            .map(Value::U128)
            .map(EvalValue::Value)
            .ok_or(EvalError::IntegerOverflow { span }),
        BinaryOp::Div if right == 0 => Err(EvalError::DivideByZero { span }),
        BinaryOp::Div => Ok(EvalValue::Value(Value::U128(left / right))),
        _ => unreachable!("arithmetic branch only"),
    }
}

fn eval_i128(op: BinaryOp, left: i128, right: i128, span: Span) -> Result<EvalValue, EvalError> {
    match op {
        BinaryOp::Add => left
            .checked_add(right)
            .map(Value::I128)
            .map(EvalValue::Value)
            .ok_or(EvalError::IntegerOverflow { span }),
        BinaryOp::Sub => left
            .checked_sub(right)
            .map(Value::I128)
            .map(EvalValue::Value)
            .ok_or(EvalError::IntegerOverflow { span }),
        BinaryOp::Mul => left
            .checked_mul(right)
            .map(Value::I128)
            .map(EvalValue::Value)
            .ok_or(EvalError::IntegerOverflow { span }),
        BinaryOp::Div if right == 0 => Err(EvalError::DivideByZero { span }),
        BinaryOp::Div => left
            .checked_div(right)
            .map(Value::I128)
            .map(EvalValue::Value)
            .ok_or(EvalError::IntegerOverflow { span }),
        _ => unreachable!("arithmetic branch only"),
    }
}

fn eval_ratio_ratio(
    op: BinaryOp,
    left: Ratio,
    right: Ratio,
    span: Span,
) -> Result<EvalValue, EvalError> {
    match op {
        BinaryOp::Add => ratio_add(left, right, span).map(EvalValue::Ratio),
        BinaryOp::Sub => ratio_sub(left, right, span).map(EvalValue::Ratio),
        BinaryOp::Mul => ratio_mul(left, right, span).map(EvalValue::Ratio),
        BinaryOp::Div if right.numerator == 0 => Err(EvalError::DivideByZero { span }),
        BinaryOp::Div => ratio_div(left, right, span).map(EvalValue::Ratio),
        _ => unreachable!("arithmetic branch only"),
    }
}

fn eval_value_ratio(
    op: BinaryOp,
    left: Value,
    right: Ratio,
    span: Span,
) -> Result<EvalValue, EvalError> {
    match (op, left) {
        (BinaryOp::Mul, Value::U128(left)) => mul_u128_ratio(left, right, span)
            .map(Value::U128)
            .map(EvalValue::Value),
        (BinaryOp::Mul, Value::I128(left)) => {
            mul_i128_ratio(left, right, span).map(|v| EvalValue::Value(Value::I128(v)))
        }
        (BinaryOp::Div, Value::U128(left)) if right.numerator == 0 => {
            let _ = left;
            Err(EvalError::DivideByZero { span })
        }
        (BinaryOp::Div, Value::U128(left)) => div_u128_ratio(left, right, span)
            .map(Value::U128)
            .map(EvalValue::Value),
        (BinaryOp::Div, Value::I128(left)) if right.numerator == 0 => {
            let _ = left;
            Err(EvalError::DivideByZero { span })
        }
        (BinaryOp::Div, Value::I128(left)) => {
            div_i128_ratio(left, right, span).map(|v| EvalValue::Value(Value::I128(v)))
        }
        (BinaryOp::Add, Value::U128(left)) => {
            ratio_add(Ratio::from_u128(left), right, span).map(EvalValue::Ratio)
        }
        (BinaryOp::Add, Value::I128(left)) => {
            ratio_add(Ratio::from_i128(left, span)?, right, span).map(EvalValue::Ratio)
        }
        (BinaryOp::Sub, Value::U128(left)) => {
            ratio_sub(Ratio::from_u128(left), right, span).map(EvalValue::Ratio)
        }
        (BinaryOp::Sub, Value::I128(left)) => {
            ratio_sub(Ratio::from_i128(left, span)?, right, span).map(EvalValue::Ratio)
        }
        (_, Value::Bool(_)) => Err(type_mismatch("integer", "bool", span)),
        _ => unreachable!("arithmetic branch only"),
    }
}

fn eval_ratio_value(
    op: BinaryOp,
    left: Ratio,
    right: Value,
    span: Span,
) -> Result<EvalValue, EvalError> {
    match (op, right) {
        (BinaryOp::Mul, Value::U128(right)) => mul_u128_ratio(right, left, span)
            .map(Value::U128)
            .map(EvalValue::Value),
        (BinaryOp::Mul, Value::I128(right)) => {
            mul_i128_ratio(right, left, span).map(|v| EvalValue::Value(Value::I128(v)))
        }
        (BinaryOp::Div, Value::U128(0)) => Err(EvalError::DivideByZero { span }),
        (BinaryOp::Div, Value::U128(right)) => Ok(EvalValue::Ratio(Ratio::new(
            left.numerator,
            left.denominator
                .checked_mul(right)
                .ok_or(EvalError::IntegerOverflow { span })?,
        ))),
        (BinaryOp::Div, Value::I128(0)) => Err(EvalError::DivideByZero { span }),
        (BinaryOp::Div, Value::I128(right)) if right > 0 => Ok(EvalValue::Ratio(Ratio::new(
            left.numerator,
            left.denominator
                .checked_mul(right as u128)
                .ok_or(EvalError::IntegerOverflow { span })?,
        ))),
        (BinaryOp::Div, Value::I128(_)) => Err(type_mismatch(
            "positive integer divisor",
            "negative i128",
            span,
        )),
        (BinaryOp::Add, Value::U128(right)) => {
            ratio_add(left, Ratio::from_u128(right), span).map(EvalValue::Ratio)
        }
        (BinaryOp::Add, Value::I128(right)) => {
            ratio_add(left, Ratio::from_i128(right, span)?, span).map(EvalValue::Ratio)
        }
        (BinaryOp::Sub, Value::U128(right)) => {
            ratio_sub(left, Ratio::from_u128(right), span).map(EvalValue::Ratio)
        }
        (BinaryOp::Sub, Value::I128(right)) => {
            ratio_sub(left, Ratio::from_i128(right, span)?, span).map(EvalValue::Ratio)
        }
        (_, Value::Bool(_)) => Err(type_mismatch("integer", "bool", span)),
        _ => unreachable!("arithmetic branch only"),
    }
}

fn ratio_add(left: Ratio, right: Ratio, span: Span) -> Result<Ratio, EvalError> {
    let divisor = gcd(left.denominator, right.denominator);
    let left_scale = right.denominator / divisor;
    let right_scale = left.denominator / divisor;
    let numerator = left
        .numerator
        .checked_mul(left_scale)
        .and_then(|v| v.checked_add(right.numerator.checked_mul(right_scale)?))
        .ok_or(EvalError::IntegerOverflow { span })?;
    let denominator = left
        .denominator
        .checked_mul(left_scale)
        .ok_or(EvalError::IntegerOverflow { span })?;
    Ok(Ratio::new(numerator, denominator))
}

fn ratio_sub(left: Ratio, right: Ratio, span: Span) -> Result<Ratio, EvalError> {
    let divisor = gcd(left.denominator, right.denominator);
    let left_scale = right.denominator / divisor;
    let right_scale = left.denominator / divisor;
    let left_num = left
        .numerator
        .checked_mul(left_scale)
        .ok_or(EvalError::IntegerOverflow { span })?;
    let right_num = right
        .numerator
        .checked_mul(right_scale)
        .ok_or(EvalError::IntegerOverflow { span })?;
    let numerator = left_num
        .checked_sub(right_num)
        .ok_or_else(|| type_mismatch("non-negative ratio result", "negative ratio result", span))?;
    let denominator = left
        .denominator
        .checked_mul(left_scale)
        .ok_or(EvalError::IntegerOverflow { span })?;
    Ok(Ratio::new(numerator, denominator))
}

fn ratio_mul(left: Ratio, right: Ratio, span: Span) -> Result<Ratio, EvalError> {
    let first = gcd(left.numerator, right.denominator);
    let second = gcd(right.numerator, left.denominator);
    let numerator = (left.numerator / first)
        .checked_mul(right.numerator / second)
        .ok_or(EvalError::IntegerOverflow { span })?;
    let denominator = (left.denominator / second)
        .checked_mul(right.denominator / first)
        .ok_or(EvalError::IntegerOverflow { span })?;
    Ok(Ratio::new(numerator, denominator))
}

fn ratio_div(left: Ratio, right: Ratio, span: Span) -> Result<Ratio, EvalError> {
    ratio_mul(left, Ratio::new(right.denominator, right.numerator), span)
}

fn mul_u128_ratio(value: u128, ratio: Ratio, span: Span) -> Result<u128, EvalError> {
    checked_mul_div_u128(value, ratio.numerator, ratio.denominator)
        .ok_or(EvalError::IntegerOverflow { span })
}

fn div_u128_ratio(value: u128, ratio: Ratio, span: Span) -> Result<u128, EvalError> {
    checked_mul_div_u128(value, ratio.denominator, ratio.numerator)
        .ok_or(EvalError::IntegerOverflow { span })
}

fn mul_i128_ratio(value: i128, ratio: Ratio, span: Span) -> Result<i128, EvalError> {
    let magnitude = unsigned_abs_i128(value);
    let result = mul_u128_ratio(magnitude, ratio, span)?;
    signed_from_magnitude(result, value.is_negative(), span)
}

fn div_i128_ratio(value: i128, ratio: Ratio, span: Span) -> Result<i128, EvalError> {
    let magnitude = unsigned_abs_i128(value);
    let result = div_u128_ratio(magnitude, ratio, span)?;
    signed_from_magnitude(result, value.is_negative(), span)
}

fn signed_from_magnitude(magnitude: u128, negative: bool, span: Span) -> Result<i128, EvalError> {
    if negative {
        if magnitude == (i128::MAX as u128) + 1 {
            Ok(i128::MIN)
        } else if magnitude <= i128::MAX as u128 {
            Ok(-(magnitude as i128))
        } else {
            Err(EvalError::IntegerOverflow { span })
        }
    } else if magnitude <= i128::MAX as u128 {
        Ok(magnitude as i128)
    } else {
        Err(EvalError::IntegerOverflow { span })
    }
}

fn unsigned_abs_i128(value: i128) -> u128 {
    if value == i128::MIN {
        (i128::MAX as u128) + 1
    } else {
        value.unsigned_abs()
    }
}

fn checked_mul_div_u128(mut left: u128, mut right: u128, mut denominator: u128) -> Option<u128> {
    if denominator == 0 {
        return None;
    }
    let divisor = gcd(right, denominator);
    right /= divisor;
    denominator /= divisor;
    let divisor = gcd(left, denominator);
    left /= divisor;
    denominator /= divisor;

    let whole = left / denominator;
    let rem = left % denominator;
    let whole_term = whole.checked_mul(right)?;
    let rem_term = rem.checked_mul(right)?.checked_div(denominator)?;
    whole_term.checked_add(rem_term)
}

fn compare_ratio_to_u128(ratio: Ratio, whole: u128) -> Ordering {
    let quotient = ratio.numerator / ratio.denominator;
    match quotient.cmp(&whole) {
        Ordering::Equal => {
            if ratio.numerator % ratio.denominator == 0 {
                Ordering::Equal
            } else {
                Ordering::Greater
            }
        }
        other => other,
    }
}

fn compare_ratios(left: Ratio, right: Ratio) -> Ordering {
    let mut left_num = left.numerator;
    let mut left_den = left.denominator;
    let mut right_num = right.numerator;
    let mut right_den = right.denominator;
    let mut reversed = false;

    loop {
        let left_whole = left_num / left_den;
        let left_rem = left_num % left_den;
        let right_whole = right_num / right_den;
        let right_rem = right_num % right_den;

        if left_whole != right_whole {
            let ordering = left_whole.cmp(&right_whole);
            return if reversed {
                ordering.reverse()
            } else {
                ordering
            };
        }

        match (left_rem == 0, right_rem == 0) {
            (true, true) => return Ordering::Equal,
            (true, false) => {
                return if reversed {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
            }
            (false, true) => {
                return if reversed {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            }
            (false, false) => {
                left_num = left_den;
                left_den = left_rem;
                right_num = right_den;
                right_den = right_rem;
                reversed = !reversed;
            }
        }
    }
}

fn gcd(mut left: u128, mut right: u128) -> u128 {
    while right != 0 {
        let rem = left % right;
        left = right;
        right = rem;
    }
    left.max(1)
}

fn to_i128(value: Value, span: Span) -> Result<i128, EvalError> {
    match value {
        Value::I128(value) => Ok(value),
        Value::U128(value) if value <= i128::MAX as u128 => Ok(value as i128),
        Value::U128(_) => Err(EvalError::IntegerOverflow { span }),
        Value::Bool(_) => Err(type_mismatch("integer", "bool", span)),
    }
}

fn type_mismatch(expected: &str, found: &str, span: Span) -> EvalError {
    EvalError::TypeMismatch {
        expected: expected.to_string(),
        found: found.to_string(),
        span,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::semantics::{error::EvalError, expr::parse};

    fn eval(source: &str) -> Result<Value, EvalError> {
        evaluate(&parse(source).unwrap(), &Context::new())
    }

    #[test]
    fn evaluates_arithmetic_operators_and_precedence() {
        assert_eq!(eval("2 + 3").unwrap(), Value::U128(5));
        assert_eq!(eval("7 - 10").unwrap(), Value::I128(-3));
        assert_eq!(eval("2 + 3 * 4").unwrap(), Value::U128(14));
        assert_eq!(eval("(2 + 3) * 4").unwrap(), Value::U128(20));
        assert_eq!(eval("20 / 5").unwrap(), Value::U128(4));
    }

    #[test]
    fn evaluates_comparison_operators() {
        assert_eq!(eval("2 == 2").unwrap(), Value::Bool(true));
        assert_eq!(eval("2 != 3").unwrap(), Value::Bool(true));
        assert_eq!(eval("2 < 3").unwrap(), Value::Bool(true));
        assert_eq!(eval("2 <= 2").unwrap(), Value::Bool(true));
        assert_eq!(eval("3 > 2").unwrap(), Value::Bool(true));
        assert_eq!(eval("3 >= 3").unwrap(), Value::Bool(true));
    }

    #[test]
    fn evaluates_logical_operators_and_short_circuit() {
        assert_eq!(eval("true && !false").unwrap(), Value::Bool(true));
        assert_eq!(eval("false && missing").unwrap(), Value::Bool(false));
        assert_eq!(eval("true || missing").unwrap(), Value::Bool(true));
        assert_eq!(eval("false || true").unwrap(), Value::Bool(true));
    }

    #[test]
    fn evaluates_helpers() {
        assert_eq!(eval("min(7, 3)").unwrap(), Value::U128(3));
        assert_eq!(eval("max(7, 3)").unwrap(), Value::U128(7));
        assert_eq!(eval("abs(-42)").unwrap(), Value::U128(42));
        assert_eq!(
            eval("bps_to_ratio(2500)").unwrap(),
            Value::U128(RATIO_SCALE / 4)
        );
    }

    #[test]
    fn evaluates_bps_ratio_math_without_scale_inflation() {
        assert_eq!(eval("1000 * bps_to_ratio(2500)").unwrap(), Value::U128(250));
        assert_eq!(eval("bps_to_ratio(2500) * 1000").unwrap(), Value::U128(250));
        assert_eq!(
            eval("1000 * (1 - bps_to_ratio(2500))").unwrap(),
            Value::U128(750)
        );
        assert_eq!(
            eval("1000 / bps_to_ratio(2500)").unwrap(),
            Value::U128(4000)
        );
        assert_eq!(eval("bps_to_ratio(2500) < 1").unwrap(), Value::Bool(true));
    }

    #[test]
    fn evaluates_bps_ratio_math_with_context_fields() {
        let expr = parse("collateral_value * bps_to_ratio(max_ltv_bps)").unwrap();
        let context = Context::from([
            ("collateral_value".to_string(), Value::U128(1_000)),
            ("max_ltv_bps".to_string(), Value::U128(2_500)),
        ]);
        assert_eq!(evaluate(&expr, &context).unwrap(), Value::U128(250));
    }

    #[test]
    fn evaluates_decimal_literals_without_scale_inflation() {
        assert_eq!(
            eval("1.25").unwrap(),
            Value::U128(RATIO_SCALE + RATIO_SCALE / 4)
        );
        assert_eq!(eval("1000 * 1.25").unwrap(), Value::U128(1_250));
        assert_eq!(eval("1.25 * 1000").unwrap(), Value::U128(1_250));
        assert_eq!(eval("1000 / 0.25").unwrap(), Value::U128(4_000));
        assert_eq!(eval("1000 * (1.25 - 1)").unwrap(), Value::U128(250));
        assert_eq!(eval("1.25 > 1").unwrap(), Value::Bool(true));
    }

    #[test]
    fn evaluates_decimal_literals_with_context_fields() {
        let expr = parse("collateral_value * 1.25").unwrap();
        let context = Context::from([("collateral_value".to_string(), Value::U128(1_000))]);
        assert_eq!(evaluate(&expr, &context).unwrap(), Value::U128(1_250));
    }

    #[test]
    fn evaluates_identifiers_from_context() {
        let expr = parse("reserve.collateral_amount / debt_value").unwrap();
        let context = Context::from([
            ("reserve.collateral_amount".to_string(), Value::U128(100)),
            ("debt_value".to_string(), Value::U128(4)),
        ]);
        assert_eq!(evaluate(&expr, &context).unwrap(), Value::U128(25));
    }

    #[test]
    fn deterministic_for_same_context() {
        let expr = parse("(a + b) * max(c, 2)").unwrap();
        let context = Context::from([
            ("a".to_string(), Value::U128(3)),
            ("b".to_string(), Value::U128(4)),
            ("c".to_string(), Value::U128(5)),
        ]);
        let first = evaluate(&expr, &context).unwrap();
        let second = evaluate(&expr, &context).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn returns_divide_by_zero() {
        let err = eval("1 / 0").unwrap_err();
        assert!(matches!(err, EvalError::DivideByZero { .. }));
        assert_eq!(err.span(), Span::new(0, 5));
    }

    #[test]
    fn returns_integer_overflow_at_u128_boundary() {
        let err = eval(&format!("{} + 1", u128::MAX)).unwrap_err();
        assert!(matches!(err, EvalError::IntegerOverflow { .. }));
    }

    #[test]
    fn returns_integer_overflow_at_i128_boundary() {
        let err = eval(&format!("-{} - 1", (i128::MAX as u128) + 1)).unwrap_err();
        assert!(matches!(err, EvalError::IntegerOverflow { .. }));
    }

    #[test]
    fn returns_missing_field_for_dotted_path() {
        let err = eval("reserve.debt").unwrap_err();
        assert!(matches!(err, EvalError::MissingField { .. }));
        assert_eq!(err.span(), Span::new(0, 12));
    }

    #[test]
    fn returns_unknown_identifier_for_simple_name() {
        let err = eval("debt_value").unwrap_err();
        assert!(matches!(err, EvalError::UnknownIdentifier { .. }));
        assert_eq!(err.span(), Span::new(0, 10));
    }

    #[test]
    fn returns_type_mismatch() {
        let err = eval("true + 1").unwrap_err();
        assert!(matches!(err, EvalError::TypeMismatch { .. }));
    }

    #[test]
    fn returns_unknown_helper() {
        let err = eval("now()").unwrap_err();
        assert!(matches!(err, EvalError::UnknownHelper { .. }));
    }

    #[test]
    fn returns_arity() {
        let err = eval("min(1)").unwrap_err();
        assert!(matches!(
            err,
            EvalError::Arity {
                expected: 2,
                found: 1,
                ..
            }
        ));
    }

    #[test]
    fn evaluates_nested_expression() {
        assert_eq!(
            eval("((10 + 2) * (8 - 3)) / abs(-6)").unwrap(),
            Value::U128(10)
        );
    }
}
