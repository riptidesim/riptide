#!/usr/bin/env sh
set -eu
cd /home/ailton/Work/riptide/case-studies/raydium-cp-swap
exec riptide run /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/raydium-campaign/campaign_c691a3a7933c/runs/run_000000_5d7d52662d22/run-config.json --harness .riptide/harness
