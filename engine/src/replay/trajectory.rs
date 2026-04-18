use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::adapter::ArgLiteral;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayMetadata {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplayInstruction {
    pub name: String,
    pub agent: String,
    #[serde(default)]
    pub args: BTreeMap<String, ArgLiteral>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplayTick {
    pub tick: u32,
    #[serde(default)]
    pub instructions: Vec<ReplayInstruction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplayTrajectory {
    pub metadata: ReplayMetadata,
    #[serde(default)]
    pub ticks: Vec<ReplayTick>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReplayInitialState {
    #[serde(default)]
    pub instructions: Vec<ReplayInstruction>,
}

pub fn load_trajectory(path: &Path) -> Result<ReplayTrajectory> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read replay trajectory {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("parse replay trajectory JSON {}", path.display()))
}

pub fn load_initial_state(path: &Path) -> Result<ReplayInitialState> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read replay initial-state {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("parse replay initial-state JSON {}", path.display()))
}
