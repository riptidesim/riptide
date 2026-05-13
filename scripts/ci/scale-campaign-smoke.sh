#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_ROOT/cli/dist/src/index.js"
ENGINE="${RIPTIDE_ENGINE_BIN:-$REPO_ROOT/target/release/riptide-engine}"
OUT="${RIPTIDE_SCALE_OUT:-$REPO_ROOT/reports/real-world-scale/artifacts/t05}"
ARTIFACT_ROOT="$REPO_ROOT/reports/real-world-scale/artifacts"
EVIDENCE="$REPO_ROOT/reports/real-world-scale/scale-queue-evidence.md"
SCALE_RUNS="${RIPTIDE_SCALE_RUNS:-8}"
PORT="${RIPTIDE_STUDIO_PORT:-0}"
HOST="127.0.0.1"
URL=""
CAMPAIGN="fixtures/campaigns/lending/solend-shape-liquidation-safety/campaign.toml"
CAMPAIGN_ID="campaign_2a93d0358025"

if [[ ! -f "$CLI" ]]; then
  echo "missing $CLI"
  echo "run: npm --prefix cli run build"
  exit 1
fi

if [[ ! -x "$ENGINE" ]]; then
  echo "missing executable engine: $ENGINE"
  echo "run: cargo build --release -p riptide-engine"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "missing required command: curl"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "missing required command: node"
  exit 1
fi

OUT="$(node -e 'const path=require("node:path"); console.log(path.resolve(process.argv[1]));' "$OUT")"
ARTIFACT_ROOT="$(node -e 'const path=require("node:path"); console.log(path.resolve(process.argv[1]));' "$ARTIFACT_ROOT")"

case "$OUT" in
  ""|"/"|"$REPO_ROOT"|"$ARTIFACT_ROOT")
    echo "refusing unsafe RIPTIDE_SCALE_OUT: $OUT"
    exit 1
    ;;
esac

case "$OUT/" in
  "$ARTIFACT_ROOT"/*) ;;
  *)
    echo "refusing RIPTIDE_SCALE_OUT outside $ARTIFACT_ROOT: $OUT"
    exit 1
    ;;
esac

rm -rf "$OUT"
mkdir -p "$OUT" "$(dirname "$EVIDENCE")"

echo "== Riptide scale campaign smoke =="
echo "repo: $REPO_ROOT"
echo "scale target: $SCALE_RUNS lending campaign runs"
echo "artifact root: $OUT"

SCALE_LOG="$OUT/scale-campaign.stdout.txt"
scale_start=$SECONDS
(
  cd "$REPO_ROOT"
  NO_COLOR=1 RIPTIDE_ENGINE_BIN="$ENGINE" node "$CLI" campaign run "$CAMPAIGN" \
    --max-runs "$SCALE_RUNS" \
    --out "$OUT/scale-campaign"
) 2>&1 | tee "$SCALE_LOG"
scale_elapsed=$((SECONDS - scale_start))

scale_root="$OUT/scale-campaign/$CAMPAIGN_ID"
if [[ ! -f "$scale_root/campaign-summary.json" ]]; then
  echo "scale campaign summary missing: $scale_root/campaign-summary.json"
  exit 1
fi
scale_run_count="$(find "$scale_root/runs" -mindepth 1 -maxdepth 1 -type d -name 'run_*' | wc -l | tr -d ' ')"
if [[ "$scale_run_count" -ne "$SCALE_RUNS" ]]; then
  echo "expected $SCALE_RUNS scale runs, found $scale_run_count"
  exit 1
fi
scale_size="$(du -sh "$OUT/scale-campaign" | awk '{print $1}')"

echo
echo "== Studio queue stress =="
WORK_ROOT="$OUT/studio-workspaces"
WORK_A="$WORK_ROOT/scale-a"
WORK_B="$WORK_ROOT/scale-b"
mkdir -p "$WORK_A/.riptide" "$WORK_B/.riptide"
cp -a "$REPO_ROOT/fixtures" "$WORK_A/fixtures"
cp -a "$REPO_ROOT/fixtures" "$WORK_B/fixtures"
cp -a "$REPO_ROOT/examples" "$WORK_A/examples"
cp -a "$REPO_ROOT/examples" "$WORK_B/examples"

SERVER_LOG="$OUT/studio-server.stdout.txt"
NO_COLOR=1 RIPTIDE_ENGINE_BIN="$ENGINE" node "$CLI" studio \
  --workspace "$WORK_A" \
  --case-studies-root "$WORK_ROOT" \
  --host "$HOST" \
  --port "$PORT" \
  --no-open \
  --quiet >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 80); do
  URL="$(node -e '
const fs=require("node:fs");
const file=process.argv[1];
if (!fs.existsSync(file)) process.exit(0);
const text=fs.readFileSync(file, "utf8");
const match=text.match(/^riptide studio:\s+(http:\/\/\S+)/m);
if (match) process.stdout.write(match[1]);
' "$SERVER_LOG")"
  if [[ -n "$URL" ]]; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "studio server exited before printing its URL"
    cat "$SERVER_LOG" || true
    exit 1
  fi
  sleep 0.25
done

if [[ -z "$URL" ]]; then
  echo "studio server did not print its URL"
  cat "$SERVER_LOG" || true
  exit 1
fi

for _ in $(seq 1 80); do
  if curl -fsS "$URL/api/studio/health" >"$OUT/studio-health.json" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if [[ ! -s "$OUT/studio-health.json" ]]; then
  echo "studio server did not become healthy"
  cat "$SERVER_LOG" || true
  exit 1
fi

curl -fsS "$URL/api/studio/workspaces" >"$OUT/studio-workspaces.json"
WORKSPACE_A_ID="$(node -e 'const fs=require("fs"); const p=process.argv[2]; const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const w=(j.workspaces||[]).find((row)=>row.path===p); if(!w){process.exit(2)} console.log(w.id)' "$OUT/studio-workspaces.json" "$WORK_A")"
WORKSPACE_B_ID="$(node -e 'const fs=require("fs"); const p=process.argv[2]; const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const w=(j.workspaces||[]).find((row)=>row.path===p); if(!w){process.exit(2)} console.log(w.id)' "$OUT/studio-workspaces.json" "$WORK_B")"

post_job() {
  local workspace="$1"
  local kind="$2"
  local params_json="$3"
  local out_file="$4"
  node -e '
const fs=require("fs");
const [workspace, kind, paramsJson, outFile] = process.argv.slice(1);
const payload = { workspace, kind, params: JSON.parse(paramsJson) };
fs.writeFileSync(outFile + ".body", JSON.stringify(payload));
' "$workspace" "$kind" "$params_json" "$out_file"
  curl -fsS \
    -H 'content-type: application/json' \
    -X POST \
    --data-binary "@$out_file.body" \
    "$URL/api/studio/jobs" >"$out_file"
  node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(j.job.id)' "$out_file"
}

JOB_CAMPAIGN="$(post_job "$WORKSPACE_A_ID" "campaign-run" "{\"campaign\":\"$CAMPAIGN\"}" "$OUT/job-campaign.json")"
JOB_REVIEW="$(post_job "$WORKSPACE_A_ID" "review" "{\"pack\":\".riptide/campaigns/$CAMPAIGN_ID\",\"out\":\".riptide/studio/scale-review.md\"}" "$OUT/job-review.json")"
JOB_FAIL="$(post_job "$WORKSPACE_A_ID" "review" "{\"pack\":\".riptide/pack/does-not-exist\"}" "$OUT/job-fail.json")"
JOB_READY="$(post_job "$WORKSPACE_B_ID" "readiness" "{\"out\":\".riptide/readiness-scale\"}" "$OUT/job-readiness.json")"
JOB_CANCEL="$(post_job "$WORKSPACE_B_ID" "campaign-plan" "{\"campaign\":\"$CAMPAIGN\"}" "$OUT/job-cancel.json")"

curl -fsS "$URL/api/studio/jobs" >"$OUT/jobs-after-submit.json"
curl -fsS -X POST "$URL/api/studio/jobs/$JOB_CANCEL/cancel" >"$OUT/job-cancel-response.json"

for _ in $(seq 1 240); do
  curl -fsS "$URL/api/studio/jobs" >"$OUT/jobs-final.json"
  if node -e '
const fs=require("fs");
const jobs=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).jobs || [];
const active=jobs.filter((j)=>j.status==="queued" || j.status==="running");
process.exit(active.length === 0 ? 0 : 1);
' "$OUT/jobs-final.json"; then
    break
  fi
  sleep 1
done

node -e '
const fs=require("fs");
const jobs=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).jobs || [];
if (jobs.some((j)=>j.status==="queued" || j.status==="running")) {
  console.error("jobs still active after timeout");
  process.exit(1);
}
const ids = new Set(process.argv.slice(2));
for (const id of ids) {
  if (!jobs.find((j)=>j.id===id)) {
    console.error(`missing job ${id}`);
    process.exit(1);
  }
}
const statuses = new Set(jobs.filter((j)=>ids.has(j.id)).map((j)=>j.status));
for (const required of ["succeeded", "failed", "cancelled"]) {
  if (!statuses.has(required)) {
    console.error(`missing terminal status ${required}; saw ${Array.from(statuses).join(",")}`);
    process.exit(1);
  }
}
' "$OUT/jobs-final.json" "$JOB_CAMPAIGN" "$JOB_REVIEW" "$JOB_FAIL" "$JOB_READY" "$JOB_CANCEL"

if [[ ! -f "$WORK_A/.riptide/studio/jobs/$JOB_CAMPAIGN.json" ]]; then
  echo "missing persisted campaign job record"
  exit 1
fi
if [[ ! -f "$WORK_B/.riptide/studio/jobs/$JOB_READY.json" ]]; then
  echo "missing persisted readiness job record"
  exit 1
fi
if [[ ! -f "$WORK_A/.riptide/campaigns/$CAMPAIGN_ID/campaign-summary.json" ]]; then
  echo "missing Studio campaign artifact"
  exit 1
fi
if [[ ! -f "$WORK_A/.riptide/studio/scale-review.md" ]]; then
  echo "missing Studio review output"
  exit 1
fi
if [[ ! -f "$WORK_B/.riptide/readiness-scale/readiness.json" ]]; then
  echo "missing Studio readiness output"
  exit 1
fi
if [[ -d "$WORK_B/.riptide/campaigns/$CAMPAIGN_ID" ]]; then
  echo "workspace B unexpectedly has workspace A campaign artifact"
  exit 1
fi

queue_summary="$(node -e '
const fs=require("fs");
const jobs=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).jobs || [];
const counts={};
for (const job of jobs) counts[job.status]=(counts[job.status]||0)+1;
console.log(Object.entries(counts).sort().map(([k,v])=>`${k}=${v}`).join(", "));
' "$OUT/jobs-final.json")"
queue_after_submit="$(node -e '
const fs=require("fs");
const jobs=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).jobs || [];
const counts={};
for (const job of jobs) counts[job.status]=(counts[job.status]||0)+1;
console.log(Object.entries(counts).sort().map(([k,v])=>`${k}=${v}`).join(", "));
' "$OUT/jobs-after-submit.json")"
persist_a="$(find "$WORK_A/.riptide/studio/jobs" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
persist_b="$(find "$WORK_B/.riptide/studio/jobs" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
studio_size="$(du -sh "$WORK_ROOT" | awk '{print $1}')"

cat >"$EVIDENCE" <<REPORT
# Sprint 34 Phase 2 Scale Campaign And Studio Queue Evidence

Captured by:

\`\`\`text
$ cd /home/ailton/Work/riptide/riptide && bash scripts/ci/scale-campaign-smoke.sh
\`\`\`

## Scale Target

- Target: committed lending campaign \`$CAMPAIGN\`
- Bound: \`$SCALE_RUNS\` runs from the deterministic campaign plan
- Runtime expectation: less than 2 minutes on this workstation
- Artifact expectation: less than 100M under \`reports/real-world-scale/artifacts/t05\`

Observed:

\`\`\`text
Scale runs: $scale_run_count
Scale elapsed seconds: $scale_elapsed
Scale artifact size: $scale_size
\`\`\`

Scale stdout:

\`\`\`text
$(sed -n '1,80p' "$SCALE_LOG")
\`\`\`

## Studio Queue Stress

- Studio URL: \`$URL\`
- Workspaces: \`$WORKSPACE_A_ID\` -> \`$WORK_A\`, \`$WORKSPACE_B_ID\` -> \`$WORK_B\`
- Queue after submit: \`$queue_after_submit\`
- Final queue statuses: \`$queue_summary\`
- Persisted job records: \`$WORKSPACE_A_ID=$persist_a\`, \`$WORKSPACE_B_ID=$persist_b\`
- Studio workspace artifact size: \`$studio_size\`

Queued jobs:

| Label | Job id | Workspace | Expected terminal behavior |
| --- | --- | --- | --- |
| campaign run | \`$JOB_CAMPAIGN\` | \`$WORKSPACE_A_ID\` | succeeds and writes \`.riptide/campaigns/$CAMPAIGN_ID\` |
| review | \`$JOB_REVIEW\` | \`$WORKSPACE_A_ID\` | succeeds and writes \`.riptide/studio/scale-review.md\` |
| failing review | \`$JOB_FAIL\` | \`$WORKSPACE_A_ID\` | fails on missing pack |
| readiness | \`$JOB_READY\` | \`$WORKSPACE_B_ID\` | succeeds and writes \`.riptide/readiness-scale/readiness.json\` |
| cancelled plan | \`$JOB_CANCEL\` | \`$WORKSPACE_B_ID\` | cancelled before dispatch or terminalized as cancelled |

Artifact isolation checks:

\`\`\`text
present: $WORK_A/.riptide/campaigns/$CAMPAIGN_ID/campaign-summary.json
present: $WORK_A/.riptide/studio/scale-review.md
present: $WORK_B/.riptide/readiness-scale/readiness.json
absent:  $WORK_B/.riptide/campaigns/$CAMPAIGN_ID
\`\`\`

Failure/cancel behavior:

- The missing-pack review job is persisted as a failed job.
- The campaign-plan job is cancelled through \`POST /api/studio/jobs/:id/cancel\`.
- Queue concurrency remains sequential; this script verifies queue depth and
  isolation rather than enabling unbounded parallel execution.

Raw JSON artifacts:

- \`reports/real-world-scale/artifacts/t05/jobs-after-submit.json\`
- \`reports/real-world-scale/artifacts/t05/jobs-final.json\`
- \`reports/real-world-scale/artifacts/t05/job-cancel-response.json\`
- \`reports/real-world-scale/artifacts/t05/studio-workspaces.json\`
REPORT

echo
echo "scale campaign smoke passed"
echo "scale runs: $scale_run_count"
echo "scale elapsed seconds: $scale_elapsed"
echo "scale artifact size: $scale_size"
echo "studio queue after submit: $queue_after_submit"
echo "studio queue final: $queue_summary"
echo "persisted job records: $WORKSPACE_A_ID=$persist_a $WORKSPACE_B_ID=$persist_b"
echo "evidence: $EVIDENCE"
