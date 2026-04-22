//! Deterministic render of `summary.md`, `trace.md`, and
//! `rerun.sh` from a `SimulationResult` + its pack manifest.
//!
//! Determinism is load-bearing: the same input always produces the
//! same bytes. No timestamps, no random, no env lookups, no locale-
//! dependent formatting. Numeric formatting normalizes through a
//! small helper that matches the SimulationResult's own wire format
//! (integers stay integers, floats round-trip through their JSON
//! shape) so a reviewer sees the same values in the pack as in
//! `simulation-result.json`.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::types::{SimEvent, SimOutcome, SimulationResult};

use super::{PackInputsRel, PackManifest, PackOutputsRel};

const EVIDENCE_DISCLAIMER: &str = "Simulation evidence — not audit signoff.";

/// Render `summary.md`. 3–7 lines of reviewer-facing facts: adapter,
/// scenario / replay, outcome sentence, invariant-firing status, plus
/// a single reference to where the machine-readable index lives.
pub fn render_summary_md(result: &SimulationResult, manifest: &PackManifest) -> String {
    let mut lines = Vec::with_capacity(16);
    lines.push(format!("# Run summary — `{}`", manifest.scenario));
    lines.push(String::new());
    lines.push(format!("> {EVIDENCE_DISCLAIMER}"));
    lines.push(String::new());

    let adapter_surface = manifest
        .adapter
        .clone()
        .unwrap_or_else(|| "<no adapter>".into());
    lines.push(format!(
        "- **Adapter:** `{adapter_surface}`"
    ));
    lines.push(format!(
        "- **Scenario:** `{}` · `{}` · ticks={} · agents={}",
        manifest.kind, manifest.scenario, manifest.total_ticks, manifest.agents
    ));
    lines.push(format!(
        "- **Canonical hash:** `{}`",
        manifest.canonical_hash
    ));

    let outcome_sentence = outcome_one_liner(result, manifest);
    lines.push(format!("- **Outcome:** {outcome_sentence}"));

    let invariants_line = invariant_status_line(manifest);
    lines.push(format!("- **Invariants:** {invariants_line}"));

    lines.push(format!(
        "- **Machine-readable index:** `manifest.json` · trace in `trace.md` · rerun recipe in `rerun.sh`"
    ));

    lines.push(String::new());
    lines.push(format!("_{EVIDENCE_DISCLAIMER}_"));
    lines.push(String::new());

    lines.join("\n")
}

/// Render `trace.md`. Event-table style — tick, component, event,
/// state delta. Scope: invariant firings, bridge firings, scheduled
/// actions, oracle writes, plus per-invariant-fire snapshot deltas
/// so the reviewer sees the numbers that drove the firing without
/// opening `simulation-result.json`.
pub fn render_trace_md(result: &SimulationResult, manifest: &PackManifest) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Technical trace — `{}`\n\n", manifest.scenario));
    out.push_str(&format!("> {EVIDENCE_DISCLAIMER}\n\n"));
    out.push_str(&format!(
        "- **Adapter:** `{}`\n",
        manifest.adapter.clone().unwrap_or_else(|| "<no adapter>".into())
    ));
    out.push_str(&format!("- **Kind:** `{}`\n", manifest.kind));
    out.push_str(&format!("- **Total ticks:** {}\n", manifest.total_ticks));
    out.push_str(&format!("- **Event count:** {}\n", manifest.event_count));
    out.push_str(&format!(
        "- **Canonical hash:** `{}`\n\n",
        manifest.canonical_hash
    ));

    // ---- events of interest, tick-ordered ----
    out.push_str("## Events of interest\n\n");
    out.push_str("Scope: invariant firings, bridge firings, scheduled actions, oracle writes.\n\n");
    out.push_str("| Tick | Component | Event | Details |\n");
    out.push_str("|-----:|-----------|-------|---------|\n");

    let rows = collect_trace_rows(result);
    if rows.is_empty() {
        out.push_str("| — | — | _no invariant / bridge / scheduled / oracle events emitted_ | — |\n");
    } else {
        for row in &rows {
            out.push_str(&format!(
                "| {} | `{}` | `{}` | {} |\n",
                row.tick, row.component, row.event, row.details
            ));
        }
    }
    out.push('\n');

    // ---- per-invariant-firing snapshot context ----
    out.push_str("## Invariant firings — snapshot context\n\n");
    let firing_events = result
        .events
        .iter()
        .filter(|e| e.action.starts_with("invariant_violation:"))
        .collect::<Vec<_>>();
    if firing_events.is_empty() {
        out.push_str("_no declared invariants fired during this run_\n\n");
    } else {
        out.push_str("| Tick | Invariant | Field | Observed | Expected (op) |\n");
        out.push_str("|-----:|-----------|-------|---------:|---------------|\n");
        for event in firing_events {
            let name = event
                .action
                .strip_prefix("invariant_violation:")
                .unwrap_or(&event.action);
            let field = event
                .params
                .get("field")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let observed = event
                .params
                .get("observed")
                .map(json_number_str)
                .unwrap_or_else(|| "?".into());
            let expected = event
                .params
                .get("expected")
                .map(json_number_str)
                .unwrap_or_else(|| "?".into());
            let op = event
                .params
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or("?");
            out.push_str(&format!(
                "| {} | `{}` | `{}` | {} | `{}` {} |\n",
                event.tick, name, field, observed, op, expected
            ));
        }
        out.push('\n');
    }

    // ---- per-tick qualified state for keys referenced by firings ----
    // Keeps the reviewer grounded in the numbers without forcing them
    // to open simulation-result.json. Only emits for the ticks that
    // actually fired an invariant — otherwise this section gets
    // noisy for long runs.
    let fired_fields = collect_fired_fields(result);
    if !fired_fields.is_empty() && !result.timeseries.is_empty() {
        out.push_str("## State deltas around invariant firings\n\n");
        out.push_str("| Tick | Key | Value |\n");
        out.push_str("|-----:|-----|------:|\n");
        let fired_ticks = collect_fired_ticks(result);
        for tick in &fired_ticks {
            if let Some(snapshot) = result.timeseries.iter().find(|s| {
                s.get("tick").and_then(|v| v.as_u64()) == Some(*tick as u64)
            }) {
                for field in &fired_fields {
                    if let Some(val) = snapshot.get(field) {
                        out.push_str(&format!(
                            "| {tick} | `{field}` | {} |\n",
                            json_number_str(val)
                        ));
                    }
                }
            }
        }
        out.push('\n');
    }

    out.push_str(&format!("_{EVIDENCE_DISCLAIMER}_\n"));
    out
}

/// Render `rerun.sh`. POSIX `sh` only — no `bash`-isms. Repo-
/// relative paths only; `cd "$(dirname "$0")/../../.."` lands the
/// reviewer at the repo root regardless of their cwd.
pub fn render_rerun_sh(
    result: &SimulationResult,
    inputs: &PackInputsRel,
    outputs: &PackOutputsRel,
    command_hint: Option<&str>,
) -> String {
    let mut s = String::new();
    s.push_str("#!/bin/sh\n");
    s.push_str("# Riptide — reviewer-ready rerun recipe.\n");
    s.push_str("#\n");
    s.push_str(&format!("# {EVIDENCE_DISCLAIMER}\n"));
    s.push_str(
        "# Regenerates the accompanying simulation-result.json from committed inputs.\n",
    );
    s.push_str("# Expects to be run from this file's directory or anywhere; it cds to the repo\n");
    s.push_str("# root and then executes the documented invocation. POSIX sh only — no bashisms.\n");
    s.push_str("set -eu\n");
    s.push_str("here=$(cd \"$(dirname \"$0\")\" && pwd)\n");
    s.push_str("cd \"$here/../../..\"\n");
    s.push('\n');
    s.push_str(&format!(
        "# scenario: {} (kind inferred from the SimulationResult)\n",
        result.run_config.scenario
    ));
    s.push_str(&format!(
        "# canonical hash: {}\n",
        super::canonical_hash(result)
    ));
    s.push('\n');
    if let Some(cmd) = command_hint {
        // Strip any trailing newline the caller tossed in so the
        // emitted script stays predictable.
        s.push_str(cmd.trim_end());
        s.push('\n');
    } else {
        s.push_str(&default_rerun_command(result, inputs, outputs));
        s.push('\n');
    }
    s
}

fn default_rerun_command(
    _result: &SimulationResult,
    inputs: &PackInputsRel,
    outputs: &PackOutputsRel,
) -> String {
    // For replay runs (both legacy and multi-component) we emit a
    // `riptide-engine replay --config <cfg> --output <out>` form
    // using repo-relative paths only. For simulate runs we emit the
    // full `--config / --policies / --output` triad. No invocation
    // is ever emitted against a tmp-only file.
    //
    // Paths are wrapped with POSIX single-quote escaping — double
    // quotes still expand `$(...)`, backticks, and `$VAR`, so a
    // forwarded pack containing an unsafe filename would otherwise
    // execute the substitution on the reviewer's machine. See
    // F-2026-04-21-S12P1-001.
    let out = outputs
        .simulation_result
        .clone()
        .unwrap_or_else(|| "riptide-output/pack/simulation-result.json".into());
    let out = posix_single_quote(&out);
    if let Some(cfg) = inputs.config.as_ref() {
        if is_replay_config(cfg) {
            let cfg = posix_single_quote(cfg);
            return format!("exec riptide-engine replay --config {cfg} --output {out}");
        }
    }
    match (inputs.config.as_ref(), inputs.policies.as_ref()) {
        (Some(cfg), Some(pol)) => {
            let cfg = posix_single_quote(cfg);
            let pol = posix_single_quote(pol);
            format!(
                "exec riptide-engine --config {cfg} --policies {pol} --output {out}"
            )
        }
        (Some(cfg), None) => {
            let cfg = posix_single_quote(cfg);
            format!("exec riptide-engine --config {cfg} --output {out}")
        }
        _ => {
            "# No canonical config path was captured at emit time —\n\
             # consult the parent directory for the original invocation.\n\
             :".into()
        }
    }
}

fn is_replay_config(path: &str) -> bool {
    path.contains("replays/") || path.ends_with("replay-config.json") || path.contains("/replay/")
}

/// POSIX-safe single-quote wrap for a shell argument.
///
/// Double-quoting an argument in `sh` still runs `$(...)`, backticks,
/// and `$VAR` expansion against the reviewer's environment. A pack
/// forwarded with a filename like `fixtures/$(id).toml` would execute
/// `id` on every machine that ran `rerun.sh`. Single-quote wrapping
/// (with the classic `'\''` close/escape/reopen dance) turns every
/// byte between the quotes into a literal, eliminating the attack
/// surface.
///
/// Example: `fixtures/$(id).toml` → `'fixtures/$(id).toml'`,
/// `it's-nice` → `'it'\''s-nice'`.
fn posix_single_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

struct TraceRow {
    tick: u32,
    component: String,
    event: String,
    details: String,
}

fn collect_trace_rows(result: &SimulationResult) -> Vec<TraceRow> {
    let mut rows: Vec<TraceRow> = Vec::new();
    for event in &result.events {
        if let Some(row) = trace_row_for_event(event) {
            rows.push(row);
        }
    }
    // Stable sort — tick already deterministic from the event order
    // the tick loop produced; keep insertion order within a tick.
    rows.sort_by_key(|r| r.tick);
    rows
}

fn trace_row_for_event(event: &SimEvent) -> Option<TraceRow> {
    // Invariant firings — action="invariant_violation:<name>".
    if let Some(rest) = event.action.strip_prefix("invariant_violation:") {
        let component = component_from_qualified(rest);
        let details = format!(
            "field=`{}` observed={} {} expected={}",
            event.params.get("field").and_then(Value::as_str).unwrap_or("?"),
            event.params.get("observed").map(json_number_str).unwrap_or_else(|| "?".into()),
            event.params.get("op").and_then(Value::as_str).unwrap_or("?"),
            event.params.get("expected").map(json_number_str).unwrap_or_else(|| "?".into()),
        );
        return Some(TraceRow {
            tick: event.tick,
            component: component.unwrap_or_else(|| "engine".into()),
            event: format!("invariant_fired:{rest}"),
            details,
        });
    }

    // Bridge firings — action="bridge:<name>".
    if let Some(rest) = event.action.strip_prefix("bridge:") {
        let source = event
            .params
            .get("source_component")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let source_field = event
            .params
            .get("source_field")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let target_component = event
            .params
            .get("target_component")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let target_oracle = event
            .params
            .get("target_oracle")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let observation = event
            .params
            .get("observation")
            .map(json_number_str)
            .unwrap_or_else(|| "?".into());
        let derived_price = event
            .params
            .get("derived_price")
            .map(json_number_str)
            .unwrap_or_else(|| "?".into());
        return Some(TraceRow {
            tick: event.tick,
            component: target_component.to_string(),
            event: format!("bridge:{rest}"),
            details: format!(
                "{source}.{source_field}={observation} → {target_component}.{target_oracle}={derived_price}"
            ),
        });
    }

    // Scheduled actions — action="scheduled:<name>" emitted by the
    // tick loop with agent_id="__engine__".
    if let Some(rest) = event.action.strip_prefix("scheduled:") {
        let instruction = event
            .params
            .get("instruction")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let interval = event
            .params
            .get("interval_ticks")
            .map(json_number_str)
            .unwrap_or_else(|| "?".into());
        return Some(TraceRow {
            tick: event.tick,
            component: "engine".into(),
            event: format!("scheduled:{rest}"),
            details: format!("instruction=`{instruction}` interval_ticks={interval}"),
        });
    }

    // Oracle writes — the multi-component path emits these as bridge
    // events (handled above). Single-component runs with an oracle
    // trajectory land their updates as snapshot deltas we show in
    // the per-firing state section. No separate row here, to keep
    // the event table focused.

    // Failed-outcome events at the engine layer — surface these too,
    // they're typically the "program rejected" signals a reviewer
    // cares about.
    if event.agent_id == "__engine__" && matches!(event.outcome, SimOutcome::Failed) {
        return Some(TraceRow {
            tick: event.tick,
            component: "engine".into(),
            event: event.action.clone(),
            details: event
                .outcome_detail
                .clone()
                .unwrap_or_else(|| "engine-level failed event".into()),
        });
    }
    None
}

fn component_from_qualified(rest: &str) -> Option<String> {
    // Multi-component invariants carry a `<component>:<name>` or
    // `<component>:<field...>` qualified form. Detect by the first
    // `:` separator. Plain single-component invariants stay under
    // "engine".
    let parts: Vec<&str> = rest.splitn(2, ':').collect();
    if parts.len() == 2 {
        Some(parts[0].to_string())
    } else {
        None
    }
}

fn collect_fired_fields(result: &SimulationResult) -> Vec<String> {
    let mut seen: BTreeMap<String, ()> = BTreeMap::new();
    for event in &result.events {
        if !event.action.starts_with("invariant_violation:") {
            continue;
        }
        if let Some(field) = event.params.get("field").and_then(Value::as_str) {
            seen.insert(field.to_string(), ());
        }
    }
    seen.into_keys().collect()
}

fn collect_fired_ticks(result: &SimulationResult) -> Vec<u32> {
    let mut seen: BTreeMap<u32, ()> = BTreeMap::new();
    for event in &result.events {
        if event.action.starts_with("invariant_violation:") {
            seen.insert(event.tick, ());
        }
    }
    seen.into_keys().collect()
}

/// Render a numeric JSON value the same way `serde_json` would inline
/// it. Keeps integers as integers, floats with their JSON round-trip
/// form. Strings / bools / null pass through as their Debug form to
/// make drift obvious in a failing diff.
fn json_number_str(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

fn outcome_one_liner(result: &SimulationResult, manifest: &PackManifest) -> String {
    let firings: u64 = manifest
        .invariant_firings
        .iter()
        .map(|row| row.firings)
        .sum();
    if firings == 0 && manifest.invariant_firings.is_empty() {
        return format!(
            "clean tick loop through tick {} with {} event(s) emitted; no invariants declared",
            manifest.total_ticks, manifest.event_count
        );
    }
    if firings == 0 {
        return format!(
            "all {} declared invariant(s) held across tick {}; no firings",
            manifest.invariant_firings.len(),
            manifest.total_ticks
        );
    }
    let first_firing = manifest
        .invariant_firings
        .iter()
        .filter(|r| r.firings > 0)
        .min_by_key(|r| r.first_tick.unwrap_or(u32::MAX));
    match first_firing {
        Some(row) => {
            let tick = row.first_tick.unwrap_or(0);
            let signal = headline_metric(result, row.field.as_deref());
            format!(
                "{} invariant firing(s) across {} declared invariant(s); `{}` first fired at tick {}{}",
                firings,
                manifest.invariant_firings.len(),
                row.name,
                tick,
                signal
            )
        }
        None => format!(
            "{} invariant firing(s) recorded across {} declared invariant(s)",
            firings,
            manifest.invariant_firings.len()
        ),
    }
}

fn headline_metric(result: &SimulationResult, field: Option<&str>) -> String {
    let key = match field {
        Some(f) => f,
        None => return String::new(),
    };
    // Pull the last-seen timeseries value for the invariant field so
    // the summary one-liner carries a concrete number (e.g. `pool.
    // bad_debt=320.0`) — not just "an invariant fired".
    for snapshot in result.timeseries.iter().rev() {
        if let Some(v) = snapshot.get(key) {
            return format!(" · terminal {key}={}", json_number_str(v));
        }
    }
    String::new()
}

fn invariant_status_line(manifest: &PackManifest) -> String {
    if manifest.invariant_firings.is_empty() {
        return "no declared invariants in this run".into();
    }
    let total: u64 = manifest
        .invariant_firings
        .iter()
        .map(|r| r.firings)
        .sum();
    if total == 0 {
        return format!(
            "{} declared · 0 firings",
            manifest.invariant_firings.len()
        );
    }
    let mut parts: Vec<String> = Vec::with_capacity(manifest.invariant_firings.len());
    for row in &manifest.invariant_firings {
        if row.firings == 0 {
            continue;
        }
        match row.first_tick {
            Some(tick) => parts.push(format!("`{}`×{} (tick {})", row.name, row.firings, tick)),
            None => parts.push(format!("`{}`×{}", row.name, row.firings)),
        }
    }
    format!(
        "{} declared · {} firing(s) — {}",
        manifest.invariant_firings.len(),
        total,
        parts.join(", ")
    )
}
