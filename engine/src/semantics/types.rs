use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::semantics::{error::Span, expr::Expr};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OracleBinding {
    pub program_id: String,
    pub account: String,
    pub confidence: String,
    pub staleness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionDef {
    pub over: String,
    pub formula: String,
    pub expr: String,
    #[serde(skip)]
    pub formula_ref: Option<CollectionFormula>,
    #[serde(skip)]
    pub expr_ast: Option<Expr>,
    #[serde(skip)]
    pub expr_span: Option<Span>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollectionFormula {
    Sum,
    Min,
    Max,
    Worst,
}

impl CollectionFormula {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "sum" => Some(Self::Sum),
            "min" => Some(Self::Min),
            "max" => Some(Self::Max),
            "worst" => Some(Self::Worst),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sum => "sum",
            Self::Min => "min",
            Self::Max => "max",
            Self::Worst => "worst",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub roles: BTreeMap<String, String>,
    #[serde(skip)]
    pub state_source_ref: Option<ReplayStateSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayStateSource {
    Fixture,
    MainnetRpc,
}

impl ReplayStateSource {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fixture" => Some(Self::Fixture),
            "mainnet-rpc" => Some(Self::MainnetRpc),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fixture => "fixture",
            Self::MainnetRpc => "mainnet-rpc",
        }
    }
}
