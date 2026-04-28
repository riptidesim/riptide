use std::fmt;

use crate::{
    adapter::{SemanticClassRef, SemanticSourceBinding, Semantics},
    agent::state::Agent,
    primitive::{LendingPrimitive, PoolState},
    types::{AgentStatus, TickSnapshot},
};

use super::{eval::Context, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleBindingError {
    MissingRoleBinding { role: String },
    MissingRoleField { role: String, field: String },
    UnsupportedSemanticClass,
}

impl fmt::Display for RoleBindingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingRoleBinding { role } => write!(f, "MissingRoleBinding({role})"),
            Self::MissingRoleField { role, field } => {
                write!(f, "missing semantic role field `{role}.{field}`")
            }
            Self::UnsupportedSemanticClass => {
                write!(
                    f,
                    "semantic role binding is only implemented for lending.v1"
                )
            }
        }
    }
}

impl std::error::Error for RoleBindingError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RoleBindingContext<'a> {
    pub current_instruction: Option<&'a str>,
    pub current_agent_idx: Option<usize>,
}

impl<'a> RoleBindingContext<'a> {
    pub fn new(current_instruction: Option<&'a str>, current_agent_idx: Option<usize>) -> Self {
        Self {
            current_instruction,
            current_agent_idx,
        }
    }

    pub fn tick_snapshot(agents: &[Agent]) -> Self {
        Self {
            current_instruction: None,
            current_agent_idx: (agents.len() == 1).then_some(0),
        }
    }
}

pub fn bind_lending_v1_roles<H>(
    semantics: &Semantics,
    harness: &H,
    agents: &[Agent],
    snapshot: &TickSnapshot,
    binding_context: RoleBindingContext<'_>,
) -> Result<Context, RoleBindingError>
where
    H: LendingPrimitive + ?Sized,
{
    if semantics.class_ref != Some(SemanticClassRef::LendingV1) {
        return Err(RoleBindingError::UnsupportedSemanticClass);
    }

    let pool = harness
        .pool_state()
        .map_err(|_| RoleBindingError::MissingRoleBinding {
            role: "reserve".into(),
        })?;
    let oracle_price = snapshot
        .get("oracle_price")
        .and_then(json_number_to_u128)
        .ok_or_else(|| RoleBindingError::MissingRoleBinding {
            role: "oracle".into(),
        })?;

    let mut context = Context::new();
    for (role_name, role) in &semantics.roles {
        let source = role
            .binding
            .as_ref()
            .ok_or_else(|| RoleBindingError::MissingRoleBinding {
                role: role_name.clone(),
            })?;
        for field in role.fields.keys() {
            if is_legacy_oracle_metadata_field(source, field) {
                continue;
            }
            let value = value_from_source(
                role_name,
                source,
                field,
                &pool,
                oracle_price,
                agents,
                binding_context,
            )?;
            context.insert(format!("{role_name}.{field}"), value);
        }
    }
    Ok(context)
}

fn value_from_source(
    role_name: &str,
    source: &SemanticSourceBinding,
    field: &str,
    pool: &PoolState,
    oracle_price: u128,
    agents: &[Agent],
    binding_context: RoleBindingContext<'_>,
) -> Result<Value, RoleBindingError> {
    let value = match source {
        SemanticSourceBinding::Instruction(instruction) => {
            if !instruction_source_matches(instruction, binding_context.current_instruction) {
                return Err(RoleBindingError::MissingRoleBinding {
                    role: role_name.to_string(),
                });
            }
            let position = position_agent(role_name, agents, binding_context)?;
            instruction_source_field(role_name, position, field)
        }
        SemanticSourceBinding::Account(path) if is_position_account(path) => {
            let position = position_agent(role_name, agents, binding_context)?;
            position_field(position, field)
        }
        SemanticSourceBinding::Account(path) if is_reserve_account(path) => {
            if role_name == "liquidation_config" {
                liquidation_config_field(pool, field)
            } else {
                reserve_field(pool, field, oracle_price)
            }
        }
        SemanticSourceBinding::Account(path) if is_oracle_account(path) => {
            oracle_field(field, oracle_price)
        }
        SemanticSourceBinding::Account(_) => {
            return Err(RoleBindingError::MissingRoleBinding {
                role: role_name.to_string(),
            });
        }
    };

    value.ok_or_else(|| RoleBindingError::MissingRoleField {
        role: role_name.to_string(),
        field: field.to_string(),
    })
}

pub(crate) fn instruction_source_matches(binding: &str, current: Option<&str>) -> bool {
    if binding == "deposit_or_borrow" {
        return current.is_some_and(|instruction| {
            matches!(
                instruction,
                "deposit" | "borrow" | "repay" | "withdraw" | "liquidate"
            )
        });
    }
    current == Some(binding)
}

fn position_agent<'a>(
    role: &str,
    agents: &'a [Agent],
    binding_context: RoleBindingContext<'_>,
) -> Result<&'a Agent, RoleBindingError> {
    let idx = binding_context
        .current_agent_idx
        .or_else(|| (agents.len() == 1).then_some(0))
        .ok_or_else(|| RoleBindingError::MissingRoleBinding {
            role: role.to_string(),
        })?;
    agents
        .get(idx)
        .ok_or_else(|| RoleBindingError::MissingRoleBinding {
            role: role.to_string(),
        })
}

fn instruction_source_field(role_name: &str, agent: &Agent, field: &str) -> Option<Value> {
    match role_name {
        "position" => position_field(agent, field),
        _ => None,
    }
}

fn is_position_account(path: &str) -> bool {
    matches!(path, "position" | "obligation" | "user_position")
}

fn is_reserve_account(path: &str) -> bool {
    matches!(path, "reserve" | "market" | "borrow_caps" | "pool")
}

fn is_oracle_account(path: &str) -> bool {
    matches!(path, "oracle" | "price_oracle")
}

fn is_legacy_oracle_metadata_field(source: &SemanticSourceBinding, field: &str) -> bool {
    matches!(source, SemanticSourceBinding::Account(path) if is_oracle_account(path))
        && matches!(
            field,
            "confidence" | "confidence_bps" | "staleness" | "staleness_slots"
        )
}

fn position_field(agent: &Agent, field: &str) -> Option<Value> {
    match field {
        "collateral_amount" | "collateral" => f64_to_u128(agent.position.collateral),
        "debt_amount" | "debt" => f64_to_u128(agent.position.debt),
        "liquidated" => Some(Value::Bool(matches!(agent.status, AgentStatus::Liquidated))),
        _ => None,
    }
}

fn reserve_field(pool: &PoolState, field: &str, oracle_price: u128) -> Option<Value> {
    match field {
        "total_deposits" | "supplied_amount" => Some(Value::U128(pool.total_deposits as u128)),
        "total_borrows" | "borrowed_amount" => Some(Value::U128(pool.total_borrows as u128)),
        "bad_debt" | "bad_debt_amount" => Some(Value::U128(pool.bad_debt as u128)),
        "available_liquidity" | "liquidity" => {
            Some(Value::U128(pool.available_liquidity() as u128))
        }
        "collateral_decimals" => Some(Value::U128(0)),
        "collateral_price" => Some(Value::U128(oracle_price)),
        "max_ltv_bps" | "ltv_bps" => Some(Value::U128(pool.ltv_bps as u128)),
        "deposit_limit" => Some(Value::U128(pool.deposit_limit as u128)),
        "borrow_limit" => Some(Value::U128(pool.borrow_limit as u128)),
        "utilization" => Some(Value::U128(ratio_percent(
            pool.total_borrows,
            pool.total_deposits,
        ))),
        "bad_debt_ratio" => Some(Value::U128(ratio_percent(
            pool.bad_debt,
            pool.total_borrows.max(1),
        ))),
        "collateral_ratio" => Some(Value::U128(ratio_percent(
            pool.total_deposits,
            pool.total_borrows.max(1),
        ))),
        "health_factor" => {
            let threshold_adjusted = (pool.total_deposits as u128)
                .saturating_mul(pool.liquidation_threshold_bps as u128)
                / 10_000;
            Some(Value::U128(
                threshold_adjusted / u128::from(pool.total_borrows.max(1)),
            ))
        }
        "liquidation_threshold_bps" | "threshold_bps" => {
            Some(Value::U128(pool.liquidation_threshold_bps as u128))
        }
        "liquidation_bonus_bps" | "bonus_bps" => {
            Some(Value::U128(pool.liquidation_bonus_bps as u128))
        }
        _ => None,
    }
}

fn oracle_field(field: &str, oracle_price: u128) -> Option<Value> {
    match field {
        "price" => Some(Value::U128(oracle_price)),
        "exponent" => Some(Value::I128(0)),
        _ => None,
    }
}

fn liquidation_config_field(pool: &PoolState, field: &str) -> Option<Value> {
    match field {
        "liquidation_threshold_bps" | "threshold_bps" => {
            Some(Value::U128(pool.liquidation_threshold_bps as u128))
        }
        "liquidation_bonus_bps" | "bonus_bps" => {
            Some(Value::U128(pool.liquidation_bonus_bps as u128))
        }
        "close_factor_bps" => Some(Value::U128(10_000)),
        _ => None,
    }
}

fn f64_to_u128(value: f64) -> Option<Value> {
    if value.is_finite() && value >= 0.0 && value <= u128::MAX as f64 {
        Some(Value::U128(value.round() as u128))
    } else {
        None
    }
}

fn ratio_percent(numerator: u64, denominator: u64) -> u128 {
    if denominator == 0 {
        0
    } else {
        u128::from(numerator) * 100 / u128::from(denominator)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{
        adapter::{
            SemanticClassRef, SemanticExpression, SemanticFieldType, SemanticInvariant,
            SemanticInvariantSeverity, SemanticRole, SemanticSourceBinding, Semantics,
        },
        agent::state::Agent,
        semantics::{
            derived::{evaluate_derived_observations, DerivedObservationError},
            error::EvalError,
            expr::parse,
            invariants::{evaluate_expression_invariants, ExpressionInvariantError},
        },
        sim::MockHarness,
        types::Policy,
    };

    use super::*;

    fn policy() -> Policy {
        Policy {
            persona_id: "test".into(),
            persona_label: "test".into(),
            action_rate_multiplier: 1.0,
            risk_tolerance: 0.5,
            action_weights: BTreeMap::new(),
            triggers: Vec::new(),
            position_sizing: crate::types::PositionSizing {
                strategy: crate::types::PositionSizingStrategy::Fixed,
                params: BTreeMap::new(),
            },
            max_exposure: 1.0,
            persona_args: BTreeMap::new(),
        }
    }

    fn expression(source: &str) -> SemanticExpression {
        let ast = parse(source).unwrap();
        SemanticExpression {
            source: source.into(),
            span: Some(ast.span),
            ast: Some(ast),
        }
    }

    fn invariant(name: &str, expr: &str) -> SemanticInvariant {
        SemanticInvariant {
            name: name.into(),
            expr: expression(expr),
            severity: SemanticInvariantSeverity::Warn,
            description: None,
        }
    }

    fn declare_legacy_oracle_metadata(semantics: &mut Semantics) {
        let oracle = semantics.roles.get_mut("oracle").unwrap();
        oracle
            .fields
            .insert("confidence".into(), SemanticFieldType::U64);
        oracle
            .fields
            .insert("confidence_bps".into(), SemanticFieldType::U64);
        oracle
            .fields
            .insert("staleness".into(), SemanticFieldType::U64);
        oracle
            .fields
            .insert("staleness_slots".into(), SemanticFieldType::U64);
    }

    fn semantics(position_binding: SemanticSourceBinding) -> Semantics {
        let mut roles = BTreeMap::new();
        roles.insert(
            "position".into(),
            SemanticRole {
                source: "test".into(),
                fields: BTreeMap::from([
                    ("collateral_amount".into(), SemanticFieldType::U128),
                    ("debt_amount".into(), SemanticFieldType::U128),
                ]),
                binding: Some(position_binding),
            },
        );
        roles.insert(
            "reserve".into(),
            SemanticRole {
                source: "test".into(),
                fields: BTreeMap::from([("max_ltv_bps".into(), SemanticFieldType::U64)]),
                binding: Some(SemanticSourceBinding::Account("reserve".into())),
            },
        );
        roles.insert(
            "oracle".into(),
            SemanticRole {
                source: "test".into(),
                fields: BTreeMap::from([("price".into(), SemanticFieldType::U128)]),
                binding: Some(SemanticSourceBinding::Account("oracle".into())),
            },
        );
        roles.insert(
            "liquidation_config".into(),
            SemanticRole {
                source: "test".into(),
                fields: BTreeMap::from([(
                    "liquidation_threshold_bps".into(),
                    SemanticFieldType::U64,
                )]),
                binding: Some(SemanticSourceBinding::Account("reserve".into())),
            },
        );
        Semantics {
            class: Some("lending.v1".into()),
            roles,
            derived: BTreeMap::new(),
            invariants: Vec::new(),
            extensions: BTreeMap::new(),
            oracles: BTreeMap::new(),
            collections: BTreeMap::new(),
            replay: None,
            class_ref: Some(SemanticClassRef::LendingV1),
            derived_order: Vec::new(),
        }
    }

    fn snapshot() -> TickSnapshot {
        BTreeMap::from([("oracle_price".into(), serde_json::Value::from(100))])
    }

    #[test]
    fn instruction_source_requires_matching_instruction_context() {
        let semantics = semantics(SemanticSourceBinding::Instruction("borrow".into()));
        let harness = MockHarness::new(1, 100.0);
        let agents = vec![Agent::new("alice", policy(), 0.0)];
        let err = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::tick_snapshot(&agents),
        )
        .unwrap_err();
        assert_eq!(
            err,
            RoleBindingError::MissingRoleBinding {
                role: "position".into()
            }
        );
    }

    #[test]
    fn instruction_source_uses_the_context_agent_not_the_first_agent() {
        let semantics = semantics(SemanticSourceBinding::Instruction("borrow".into()));
        let harness = MockHarness::new(2, 100.0);
        let mut alice = Agent::new("alice", policy(), 0.0);
        alice.position.collateral = 10.0;
        let mut bob = Agent::new("bob", policy(), 0.0);
        bob.position.collateral = 42.0;
        let agents = vec![alice, bob];

        let context = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::new(Some("borrow"), Some(1)),
        )
        .unwrap();

        assert_eq!(
            context.get("position.collateral_amount"),
            Some(&Value::U128(42))
        );
    }

    #[test]
    fn deposit_or_borrow_source_requires_current_instruction_context_even_with_multiple_agents() {
        let semantics = semantics(SemanticSourceBinding::Instruction(
            "deposit_or_borrow".into(),
        ));
        let harness = MockHarness::new(2, 100.0);
        let agents = vec![
            Agent::new("alice", policy(), 0.0),
            Agent::new("bob", policy(), 0.0),
        ];

        let err = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::tick_snapshot(&agents),
        )
        .unwrap_err();

        assert_eq!(
            err,
            RoleBindingError::MissingRoleBinding {
                role: "position".into()
            }
        );
    }

    #[test]
    fn deposit_or_borrow_source_uses_current_lending_instruction_agent() {
        let semantics = semantics(SemanticSourceBinding::Instruction(
            "deposit_or_borrow".into(),
        ));
        let harness = MockHarness::new(2, 100.0);
        let mut alice = Agent::new("alice", policy(), 0.0);
        alice.position.collateral = 10.0;
        let mut bob = Agent::new("bob", policy(), 0.0);
        bob.position.collateral = 42.0;
        let agents = vec![alice, bob];

        let context = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::new(Some("borrow"), Some(1)),
        )
        .unwrap();

        assert_eq!(
            context.get("position.collateral_amount"),
            Some(&Value::U128(42))
        );
    }

    #[test]
    fn account_position_source_is_ambiguous_without_agent_context() {
        let semantics = semantics(SemanticSourceBinding::Account("position".into()));
        let harness = MockHarness::new(2, 100.0);
        let agents = vec![
            Agent::new("alice", policy(), 0.0),
            Agent::new("bob", policy(), 0.0),
        ];

        let err = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::tick_snapshot(&agents),
        )
        .unwrap_err();
        assert_eq!(
            err,
            RoleBindingError::MissingRoleBinding {
                role: "position".into()
            }
        );
    }

    #[test]
    fn legacy_oracle_metadata_declarations_are_not_bound_to_sentinel_values() {
        let mut semantics = semantics(SemanticSourceBinding::Account("position".into()));
        declare_legacy_oracle_metadata(&mut semantics);
        let harness = MockHarness::new(1, 100.0);
        let agents = vec![Agent::new("alice", policy(), 0.0)];

        let context = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::tick_snapshot(&agents),
        )
        .unwrap();

        assert_eq!(context.get("oracle.price"), Some(&Value::U128(100)));
        assert!(
            !context.contains_key("oracle.confidence")
                && !context.contains_key("oracle.confidence_bps")
                && !context.contains_key("oracle.staleness")
                && !context.contains_key("oracle.staleness_slots"),
            "legacy oracle metadata must not publish sentinel zeroes"
        );
    }

    #[test]
    fn legacy_oracle_metadata_derived_expression_fails_closed() {
        let mut semantics = semantics(SemanticSourceBinding::Account("position".into()));
        declare_legacy_oracle_metadata(&mut semantics);
        semantics.derived.insert(
            "confidence_ok".into(),
            expression("oracle.confidence <= 100"),
        );
        semantics.derived_order = vec!["confidence_ok".into()];
        let harness = MockHarness::new(1, 100.0);
        let agents = vec![Agent::new("alice", policy(), 0.0)];
        let context = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::tick_snapshot(&agents),
        )
        .unwrap();

        let err = evaluate_derived_observations(&semantics, &context).unwrap_err();
        assert!(matches!(
            err,
            DerivedObservationError::Evaluation {
                name,
                error: EvalError::MissingField { path, .. },
            } if name == "confidence_ok" && path == "oracle.confidence"
        ));
    }

    #[test]
    fn legacy_oracle_metadata_expression_invariant_fails_closed() {
        let mut semantics = semantics(SemanticSourceBinding::Account("position".into()));
        declare_legacy_oracle_metadata(&mut semantics);
        semantics.invariants = vec![invariant("fresh_oracle", "oracle.staleness <= 10")];
        let harness = MockHarness::new(1, 100.0);
        let agents = vec![Agent::new("alice", policy(), 0.0)];
        let context = bind_lending_v1_roles(
            &semantics,
            &harness,
            &agents,
            &snapshot(),
            RoleBindingContext::tick_snapshot(&agents),
        )
        .unwrap();

        let err = evaluate_expression_invariants(&semantics, &context, 0).unwrap_err();
        assert!(matches!(
            err,
            ExpressionInvariantError::InvariantEvaluationError {
                name,
                error: EvalError::MissingField { path, .. },
            } if name == "fresh_oracle" && path == "oracle.staleness"
        ));
    }
}

fn json_number_to_u128(value: &serde_json::Value) -> Option<u128> {
    if let Some(value) = value.as_u64() {
        return Some(value as u128);
    }
    if let Some(value) = value.as_i64() {
        return (value >= 0).then_some(value as u128);
    }
    let value = value.as_f64()?;
    if value.is_finite() && value >= 0.0 && value <= u128::MAX as f64 {
        Some(value.round() as u128)
    } else {
        None
    }
}
