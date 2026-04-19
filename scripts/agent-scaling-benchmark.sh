#!/usr/bin/env bash
# Agent-scaling benchmark.
#
# Runs the shipping AMM scratch scenario at 10/50/100/250/500/1000 agents.
# For each count: wall-clock, peak RSS (via /proc/<pid>/status VmHWM),
# sha256 of simulation-result.json, exit code / failure mode.
#
# Emits a TSV + human-readable summary at end. Failures and timeouts are
# reported as rows, not silently skipped — a clean OOM at 1000 agents is
# a valid result.
#
# Determinism: each agent count yields its own hash; rerunning this script
# on the same hardware should reproduce each row's hash byte-for-byte and
# its wall-clock within noise.
#
# Deps: bash, python3, awk, sed, sha256sum. No gnu-time required
# (Arch ships without /usr/bin/time by default).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENGINE="${RIPTIDE_ENGINE_BIN:-$REPO_ROOT/target/release/riptide-engine}"
BASE_ADAPTER="fixtures/adapters/amm-fork.toml"
PERSONAS_DIR="fixtures/personas"
PERSONA_IDS=(lp-provider arbitrageur sandwich-attacker swapper rug-puller)
TICKS=30
SEED=42
SCENARIO="baseline"
AGENT_COUNTS=(10 50 100 250 500 1000)
TIMEOUT_SEC="${RIPTIDE_BENCH_TIMEOUT_SEC:-900}"

if [[ ! -x "$ENGINE" ]]; then
  echo "error: riptide-engine not built at $ENGINE" >&2
  echo "build with: cargo build --release -p riptide-engine" >&2
  exit 1
fi
if [[ ! -f "$BASE_ADAPTER" ]]; then
  echo "error: base adapter missing at $BASE_ADAPTER" >&2
  exit 1
fi
for pid in "${PERSONA_IDS[@]}"; do
  if [[ ! -f "$PERSONAS_DIR/$pid.toml" ]]; then
    echo "error: persona file missing: $PERSONAS_DIR/$pid.toml" >&2
    exit 1
  fi
done

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

RUNTIME_ADAPTER="$WORK_DIR/amm-fork.runtime.toml"
PROGRAM_SO_ABS="$REPO_ROOT/programs/amm-fork/target/deploy/amm_fork.so"
IDL_PATH_ABS="$REPO_ROOT/fixtures/idls/amm-fork.json"
awk '/^# === SIDECAR-CUT ===$/ { exit } { print }' "$BASE_ADAPTER" \
  | sed -e "s|^program_so *=.*|program_so = \"$PROGRAM_SO_ABS\"|" \
        -e "s|^idl_path *=.*|idl_path = \"$IDL_PATH_ABS\"|" \
  > "$RUNTIME_ADAPTER"
echo "# --- AMM persona library (sidecar merge) ---" >> "$RUNTIME_ADAPTER"
for pid in "${PERSONA_IDS[@]}"; do
  echo "" >> "$RUNTIME_ADAPTER"
  cat "$PERSONAS_DIR/$pid.toml" >> "$RUNTIME_ADAPTER"
done

RESULTS_TSV="$WORK_DIR/results.tsv"
printf "agents\tticks\tseed\texit_code\twall_seconds\tpeak_rss_kb\tpeak_rss_mb\tsha256\tstatus\n" > "$RESULTS_TSV"

echo ">>> Agent-scaling benchmark"
echo "    scenario: AMM scratch (baseline)  ticks=$TICKS  seed=$SEED"
echo "    engine:   $ENGINE"
echo "    per-run timeout: ${TIMEOUT_SEC}s"
echo "    agent counts: ${AGENT_COUNTS[*]}"
echo ""

for agents in "${AGENT_COUNTS[@]}"; do
  printf -- "--- agents=%s ---\n" "$agents"

  python3 - "$WORK_DIR" "$agents" "$TICKS" "$SEED" "$SCENARIO" "${PERSONA_IDS[@]}" <<'PY'
import json, sys
from pathlib import Path

work_dir, agents, ticks, seed, scenario, *persona_ids = sys.argv[1:]
agents = int(agents); ticks = int(ticks); seed = int(seed)

slots = [persona_ids[i % len(persona_ids)] for i in range(agents)]
run_config = {
    "agents": agents,
    "ticks": ticks,
    "scenario": scenario,
    "seed": seed,
    "personas": slots,
    "validator_url": "unused",
    "output_path": f"amm-scaling-{agents}",
}
Path(work_dir, f"run-config-{agents}.json").write_text(
    json.dumps(run_config, indent=2, sort_keys=True) + "\n"
)
pol = Path(work_dir, "policies.json")
if not pol.exists():
    pol.write_text("[]\n")
PY

  OUTPUT_JSON="$WORK_DIR/result-$agents.json"
  LOG_PATH="$WORK_DIR/engine-$agents.log"

  RESULT_LINE="$(python3 - "$ENGINE" \
      "$WORK_DIR/run-config-$agents.json" \
      "$WORK_DIR/policies.json" \
      "$OUTPUT_JSON" \
      "$RUNTIME_ADAPTER" \
      "$TIMEOUT_SEC" \
      "$LOG_PATH" <<'PY'
import os, sys, time, subprocess

engine, cfg, pol, out, adapter, timeout_s, log_path = sys.argv[1:]
timeout_s = int(timeout_s)

scrub = {"RIPTIDE_POOL_LTV_BPS", "RIPTIDE_POOL_LIQ_THRESHOLD_BPS",
         "RIPTIDE_POOL_LIQ_BONUS_BPS", "RIPTIDE_SEED_COLLATERAL",
         "RIPTIDE_STARTING_BALANCE", "RIPTIDE_PRICE_SHOCK_DROP"}
env = {k: v for k, v in os.environ.items() if k not in scrub}


def read_vmhwm(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1])
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
    return 0


peak_rss_kb = 0
status = "ok"
log_f = open(log_path, "w")
start = time.monotonic()
proc = subprocess.Popen(
    [engine, "--config", cfg, "--policies", pol,
     "--output", out, "--adapter", adapter],
    stdout=log_f, stderr=subprocess.STDOUT, env=env,
)

deadline = start + timeout_s
while True:
    rc = proc.poll()
    sample = read_vmhwm(proc.pid)
    if sample > peak_rss_kb:
        peak_rss_kb = sample
    if rc is not None:
        break
    if time.monotonic() > deadline:
        proc.kill()
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        status = "timeout"
        break
    time.sleep(0.05)

wall = time.monotonic() - start
exit_code = proc.returncode if proc.returncode is not None else -1
if status != "timeout" and exit_code != 0:
    status = f"engine_exit_{exit_code}"
log_f.close()
print(f"{exit_code}\t{wall:.3f}\t{peak_rss_kb}\t{status}")
PY
)"

  IFS=$'\t' read -r EXIT_CODE WALL PEAK_KB STATUS <<< "$RESULT_LINE"
  PEAK_MB=$(python3 -c "print(f'{int('${PEAK_KB}')/1024:.1f}')")

  if [[ -f "$OUTPUT_JSON" ]]; then
    SHA=$(sha256sum "$OUTPUT_JSON" | awk '{print $1}')
  else
    SHA="(no-output)"
  fi

  printf "    exit=%s wall=%ss peak_rss=%sMB sha256=%s status=%s\n" \
    "$EXIT_CODE" "$WALL" "$PEAK_MB" "${SHA:0:16}..." "$STATUS"
  if [[ "$STATUS" != "ok" ]]; then
    echo "    last 10 lines of engine log:"
    tail -10 "$LOG_PATH" | sed 's/^/      /'
  fi

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$agents" "$TICKS" "$SEED" "$EXIT_CODE" "$WALL" "$PEAK_KB" "$PEAK_MB" "$SHA" "$STATUS" >> "$RESULTS_TSV"
done

echo ""
echo ">>> Summary"
column -t -s $'\t' "$RESULTS_TSV"

DEST_TSV="$REPO_ROOT/docs/benchmarks/agent-scaling-results.tsv"
mkdir -p "$(dirname "$DEST_TSV")"
cp "$RESULTS_TSV" "$DEST_TSV"
echo ""
echo ">>> TSV copied to: $DEST_TSV"
