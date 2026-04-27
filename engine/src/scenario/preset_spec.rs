//! Declarative scenario presets loaded from `fixtures/scenarios/presets/*.toml`.
//!
//! moves the parameter set of built-in scenarios out of Rust and into
//! TOML. The Rust `Scenario` impls (e.g. `PriceShockScenario`) stay put —
//! only the numeric parameters travel. At engine boot, `load_presets_dir`
//! reads every `*.toml` file in the presets directory and returns a
//! `HashMap<String, PresetSpec>` keyed by the preset's `name` field. The
//! dispatch site in `main.rs` then looks up `run_config.scenario` in that
//! map and instantiates the matching impl.
//!
//! Byte-identical constraint: the legacy hardcoded dispatch built a
//! `PriceShockScenario::new(100.0, 25, (ticks / 2).max(1), 0.4)` call.
//! The shipped `price-shock.toml` preset encodes those exact values, with
//! `shock_tick_denominator = 2` capturing the runtime-derived tick field.
//! Changing any of these fields breaks the determinism hash.

use std::{collections::HashMap, fs, path::Path};

use serde::Deserialize;

/// Discriminant for the Rust `Scenario` impl a preset maps to.
///
/// A new variant here is the only code change required to add a new
/// scenario *kind*. Adding a new preset *instance* of an existing kind
/// is TOML-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioKind {
    /// Maps to `PriceShockScenario`.
    PriceShock,
}

/// Parsed preset definition. Fields are a union across all supported
/// `ScenarioKind`s; the dispatcher in `main.rs` reads the kind first and
/// then picks out the fields it needs.
#[derive(Debug, Clone, Deserialize)]
pub struct PresetSpec {
    /// Dispatch key. Must match `RunConfig.scenario` for the preset to fire.
    pub name: String,
    /// Which Rust `Scenario` impl to instantiate.
    pub kind: ScenarioKind,
    /// Starting oracle price handed to the scenario.
    pub base_price: f64,
    /// Symmetric noise band around `base_price`, in basis points.
    pub noise_bps: u16,
    /// `PriceShock` only: the shock fires at tick
    /// `(run_config.ticks / shock_tick_denominator).max(1)`. Preserving
    /// the runtime derivation (rather than baking an absolute tick) is
    /// what keeps the determinism hash stable across different
    /// `run_config.ticks` values.
    #[serde(default = "default_shock_tick_denominator")]
    pub shock_tick_denominator: u32,
    /// `PriceShock` only: fractional drop applied when the shock fires
    /// (e.g. `0.4` = 40% drop). The `RIPTIDE_PRICE_SHOCK_DROP` env var
    /// still overrides this at dispatch time.
    #[serde(default)]
    pub drop_percent: f64,
}

fn default_shock_tick_denominator() -> u32 {
    2
}

/// Read every `*.toml` file in `dir` and return the resulting preset map,
/// keyed by `PresetSpec.name`.
///
/// - Missing directory: returns an empty map and emits a stderr warning.
/// The caller's dispatch then falls through to the `baseline` default,
/// which keeps a stripped-down checkout runnable without the fixtures
/// tree.
/// - Non-TOML files are ignored.
/// - A malformed TOML file is a hard error (`Err`) — we refuse to silently
/// drop a preset the user thought they had installed.
/// - Two files declaring the same `name` is a hard error for the same
/// reason.
pub fn load_presets_dir(dir: &Path) -> anyhow::Result<HashMap<String, PresetSpec>> {
    if !dir.exists() {
        eprintln!(
            "warn: scenario presets directory missing at {} (falling back to built-in defaults)",
            dir.display()
        );
        return Ok(HashMap::new());
    }

    let mut presets = HashMap::new();
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| anyhow::anyhow!("read presets dir {}: {e}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| anyhow::anyhow!("iterate presets dir {}: {e}", dir.display()))?;
    // Deterministic load order for reproducible warnings / error messages.
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("toml") {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("read preset {}: {e}", path.display()))?;
        let spec: PresetSpec = toml::from_str(&raw)
            .map_err(|e| anyhow::anyhow!("parse preset {}: {e}", path.display()))?;
        if let Some(prev) = presets.insert(spec.name.clone(), spec) {
            anyhow::bail!(
                "duplicate scenario preset name `{}` in {}",
                prev.name,
                dir.display()
            );
        }
    }
    Ok(presets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_preset(dir: &Path, filename: &str, body: &str) {
        fs::write(dir.join(filename), body).unwrap();
    }

    #[test]
    fn load_presets_dir_parses_price_shock_sample() {
        let tmp = tempfile::tempdir().unwrap();
        write_preset(
            tmp.path(),
            "price-shock.toml",
            r#"
name = "price-shock"
kind = "price_shock"
base_price = 100.0
noise_bps = 25
shock_tick_denominator = 2
drop_percent = 0.4
"#,
        );

        let presets = load_presets_dir(tmp.path()).unwrap();
        let spec = presets.get("price-shock").expect("price-shock loaded");
        assert_eq!(spec.kind, ScenarioKind::PriceShock);
        assert_eq!(spec.base_price, 100.0);
        assert_eq!(spec.noise_bps, 25);
        assert_eq!(spec.shock_tick_denominator, 2);
        assert_eq!(spec.drop_percent, 0.4);
    }

    #[test]
    fn load_presets_dir_returns_empty_when_directory_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        let presets = load_presets_dir(&missing).unwrap();
        assert!(presets.is_empty());
    }

    #[test]
    fn load_presets_dir_picks_up_multiple_files_without_code_changes() {
        // acceptance criterion: dropping a second TOML file into the
        // directory requires zero engine changes.
        let tmp = tempfile::tempdir().unwrap();
        write_preset(
            tmp.path(),
            "price-shock.toml",
            r#"
name = "price-shock"
kind = "price_shock"
base_price = 100.0
noise_bps = 25
shock_tick_denominator = 2
drop_percent = 0.4
"#,
        );
        write_preset(
            tmp.path(),
            "bank-run.toml",
            r#"
name = "bank-run"
kind = "price_shock"
base_price = 100.0
noise_bps = 25
shock_tick_denominator = 4
drop_percent = 0.6
"#,
        );

        let presets = load_presets_dir(tmp.path()).unwrap();
        assert_eq!(presets.len(), 2);
        assert!(presets.contains_key("price-shock"));
        assert!(presets.contains_key("bank-run"));
    }

    #[test]
    fn load_presets_dir_rejects_malformed_toml() {
        let tmp = tempfile::tempdir().unwrap();
        write_preset(tmp.path(), "broken.toml", "this is not = valid toml [[");
        let err = load_presets_dir(tmp.path()).unwrap_err();
        assert!(format!("{err}").contains("parse preset"));
    }

    #[test]
    fn shipped_price_shock_preset_matches_legacy_hardcoded_values() {
        // Regression guard for the determinism hash: if anyone edits the
        // shipped `price-shock.toml`, this test catches it before
        // `e2e_determinism` / the hero grid sweep does.
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let presets_dir = manifest_dir
            .parent()
            .unwrap()
            .join("fixtures/scenarios/presets");
        if !presets_dir.exists() {
            eprintln!("skipping: presets dir missing at {}", presets_dir.display());
            return;
        }
        let presets = load_presets_dir(&presets_dir).unwrap();
        let spec = presets
            .get("price-shock")
            .expect("price-shock preset present");
        assert_eq!(spec.kind, ScenarioKind::PriceShock);
        assert_eq!(spec.base_price, 100.0);
        assert_eq!(spec.noise_bps, 25);
        assert_eq!(spec.shock_tick_denominator, 2);
        assert_eq!(spec.drop_percent, 0.4);
    }
}
