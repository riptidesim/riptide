use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OracleTrajectoryTick {
    pub tick: u32,
    pub price: f64,
    #[serde(default)]
    pub exponent: i8,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct OracleTrajectory {
    #[serde(default)]
    pub ticks: Vec<OracleTrajectoryTick>,
}

pub fn load_oracle_trajectory(path: &Path) -> Result<OracleTrajectory> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read replay oracle trajectory {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("parse replay oracle trajectory JSON {}", path.display()))
}
