#!/usr/bin/env sh
set -eu
cd /home/ailton/Work/riptide/case-studies/whirlpools
exec riptide run /home/ailton/Work/riptide/riptide/reports/real-world-scale/artifacts/t04/whirlpool-campaign/campaign_a0852f66871d/runs/run_000000_41c052cc85f5/run-config.json --harness .riptide/harness
