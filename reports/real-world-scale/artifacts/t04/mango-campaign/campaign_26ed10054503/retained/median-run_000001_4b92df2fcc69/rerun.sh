#!/usr/bin/env sh
set -eu
cd /home/ailton/Work/riptide/case-studies/mango-v4
exec riptide run /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/mango-campaign/campaign_26ed10054503/runs/run_000001_4b92df2fcc69/run-config.json --harness .riptide/harness
