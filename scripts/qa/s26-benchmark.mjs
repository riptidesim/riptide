#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKLOADS_PATH = path.join(__dirname, "s26-workloads.json");
const DEFAULT_OBSIDIAN_REPORT =
  "/home/ailton/Documents/Obsidian Vault/Riptide/QA - Sprint 26 Benchmark And Dev UX.md";

const CSV_COLUMNS = [
  "workload",
  "command_label",
  "exit_code",
  "expected_exit_code",
  "wall_ms",
  "max_rss_kb",
  "avg_cpu_pct",
  "artifact_bytes",
  "artifact_files",
  "stdout_bytes",
  "stderr_bytes",
  "warning_count",
  "verdict"
];

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  const workloadConfig = JSON.parse(await readFile(WORKLOADS_PATH, "utf8"));

  if (cliArgs.help) {
    printHelp(workloadConfig);
    return;
  }

  if (cliArgs.list) {
    for (const name of Object.keys(workloadConfig.workloads)) {
      process.stdout.write(`${name}\n`);
    }
    return;
  }

  const profileName = cliArgs.profile ?? "smoke";
  const profile = workloadConfig.profiles[profileName];
  if (!profile) {
    throw new Error(`unknown profile ${JSON.stringify(profileName)}; expected one of ${Object.keys(workloadConfig.profiles).join(", ")}`);
  }

  const startedAt = new Date();
  const tempRoot = path.resolve(
    cliArgs.out ?? path.join("/tmp", `riptide-s26-bench-${timestampForPath(startedAt)}`)
  );
  const outputsRoot = path.join(tempRoot, "outputs");
  const stdoutRoot = path.join(outputsRoot, "stdout");
  const stderrRoot = path.join(outputsRoot, "stderr");
  const homeRoot = path.join(tempRoot, "home");
  const tempCaseStudiesRoot = path.join(tempRoot, "case-studies");
  const caseStudiesRoot = path.resolve(
    cliArgs.caseStudiesRoot ?? workloadConfig.defaults.case_studies_root
  );
  const obsidianReport =
    cliArgs.obsidianReport ??
    workloadConfig.defaults.obsidian_report ??
    DEFAULT_OBSIDIAN_REPORT;

  await mkdir(stdoutRoot, { recursive: true });
  await mkdir(stderrRoot, { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await mkdir(tempCaseStudiesRoot, { recursive: true });

  const ctx = {
    schemaVersion: "riptide.qa.s26.results.v1",
    profileName,
    profile,
    workloadConfig,
    tempRoot,
    outputsRoot,
    stdoutRoot,
    stderrRoot,
    homeRoot,
    tempCaseStudiesRoot,
    caseStudiesRoot,
    obsidianReport,
    skipObsidian: Boolean(cliArgs.skipObsidian),
    repoRoot: REPO_ROOT,
    cliPath: path.join(REPO_ROOT, "cli", "dist", "src", "index.js"),
    commandIndex: 0,
    sampleIntervalMs: workloadConfig.defaults.sample_interval_ms ?? 250,
    commandTimeoutMs: workloadConfig.defaults.command_timeout_ms ?? 600000,
    stressCommandTimeoutMs: workloadConfig.defaults.stress_command_timeout_ms ?? 3600000,
    logLimitBytes: workloadConfig.defaults.log_limit_bytes ?? 2097152,
    results: [],
    artifacts: [],
    determinism: [],
    doctorClassifications: [],
    workloadErrors: [],
    startedAt: startedAt.toISOString(),
    git: gitMetadata(REPO_ROOT),
    env: benchmarkEnv(homeRoot)
  };

  await ensureRiptideShim(ctx);
  await ensureCliBuilt(ctx);

  const requested = cliArgs.only
    ? cliArgs.only.split(",").map((name) => name.trim()).filter(Boolean)
    : profile.workloads;

  for (const workloadName of requested) {
    if (!workloadConfig.workloads[workloadName]) {
      recordSynthetic(ctx, {
        workload: workloadName,
        label: `${workloadName}/missing-definition`,
        command: "(workload lookup)",
        verdict: "fail",
        failureReason: "workload is not defined in scripts/qa/s26-workloads.json",
        nextAction: "Fix --only or add the workload definition."
      });
      continue;
    }

    try {
      switch (workloadName) {
        case "cli-discoverability":
          await runCliDiscoverability(ctx, workloadName);
          break;
        case "flagship-lending-campaign":
          await runFlagshipLendingCampaign(ctx, workloadName);
          break;
        case "harnessed-perpetuals":
          await runHarnessedPerpetuals(ctx, workloadName);
          break;
        case "case-study-init-dev-ux":
          await runCaseStudyInitDevUx(ctx, workloadName);
          break;
        case "failure-recovery-ux":
          await runFailureRecoveryUx(ctx, workloadName);
          break;
        case "cold-developer-path":
          await runColdDeveloperPath(ctx, workloadName);
          break;
        default:
          recordSynthetic(ctx, {
            workload: workloadName,
            label: `${workloadName}/not-implemented`,
            command: "(runner dispatch)",
            verdict: "fail",
            failureReason: "runner has no implementation for this workload",
            nextAction: "Implement the workload in scripts/qa/s26-benchmark.mjs."
          });
      }
    } catch (error) {
      const message = errorMessage(error);
      ctx.workloadErrors.push({ workload: workloadName, message });
      recordSynthetic(ctx, {
        workload: workloadName,
        label: `${workloadName}/runner-error`,
        command: "(runner exception)",
        verdict: "fail",
        failureReason: message,
        nextAction: "Inspect results.json and the runner stack locally."
      });
    }
  }

  await writeBenchmarkOutputs(ctx);

  const failed = ctx.results.filter((result) => result.verdict === "fail").length;
  const determinismFailed = ctx.determinism.filter((entry) => entry.verdict === "fail").length;
  process.exitCode = failed + determinismFailed > 0 ? 1 : 0;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--list") parsed.list = true;
    else if (arg === "--skip-obsidian") parsed.skipObsidian = true;
    else if (arg === "--profile") parsed.profile = argv[++index];
    else if (arg.startsWith("--profile=")) parsed.profile = arg.slice("--profile=".length);
    else if (arg === "--out") parsed.out = argv[++index];
    else if (arg.startsWith("--out=")) parsed.out = arg.slice("--out=".length);
    else if (arg === "--only") parsed.only = argv[++index];
    else if (arg.startsWith("--only=")) parsed.only = arg.slice("--only=".length);
    else if (arg === "--case-studies-root") parsed.caseStudiesRoot = argv[++index];
    else if (arg.startsWith("--case-studies-root=")) parsed.caseStudiesRoot = arg.slice("--case-studies-root=".length);
    else if (arg === "--obsidian-report") parsed.obsidianReport = argv[++index];
    else if (arg.startsWith("--obsidian-report=")) parsed.obsidianReport = arg.slice("--obsidian-report=".length);
    else throw new Error(`unknown argument ${arg}`);
  }
  return parsed;
}

function printHelp(config) {
  process.stdout.write(`Riptide Sprint 26 QA benchmark harness

Usage:
  node scripts/qa/s26-benchmark.mjs --profile smoke --out /tmp/riptide-s26-bench-smoke
  node scripts/qa/s26-benchmark.mjs --profile max --out /tmp/riptide-s26-bench-manual

Options:
  --profile <smoke|max>        Workload profile. Default: smoke
  --out <dir>                  Benchmark root. Default: /tmp/riptide-s26-bench-<timestamp>
  --only <a,b>                 Run a comma-separated workload subset
  --case-studies-root <dir>    Source case-study root. Default: ${config.defaults.case_studies_root}
  --obsidian-report <path>     Human report destination
  --skip-obsidian              Do not copy report.md into the Obsidian vault
  --list                       List workload names
`);
}

async function ensureCliBuilt(ctx) {
  if (existsSync(ctx.cliPath)) return;
  await runCommand(ctx, {
    workload: "preflight",
    label: "preflight/cli-build",
    argv: ["npm", "run", "build"],
    cwd: path.join(ctx.repoRoot, "cli"),
    expectedExitCodes: [0],
    timeoutMs: ctx.commandTimeoutMs,
    nextAction: "Run `cd cli && npm run build` and inspect TypeScript errors."
  });
}

async function ensureRiptideShim(ctx) {
  const binDir = path.join(ctx.homeRoot, ".local", "bin");
  const shim = path.join(binDir, "riptide");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    shim,
    `#!/usr/bin/env sh
exec ${shellQuote(process.execPath)} ${shellQuote(ctx.cliPath)} "$@"
`,
    "utf8"
  );
  await chmod(shim, 0o755);
}

async function runCliDiscoverability(ctx, workloadName) {
  const workload = ctx.workloadConfig.workloads[workloadName];
  for (const command of workload.commands) {
    const result = await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/${command.label}`,
      args: command.args,
      expectedExitCodes: command.expected_exit_codes,
      stdoutIncludes: command.stdout_includes,
      timeoutMs: ctx.commandTimeoutMs
    });
    if (command.classify_doctor_warnings) {
      result.doctorWarnings = classifyDoctorWarnings(`${result.stdoutLog}\n${result.stderrLog}`);
      ctx.doctorClassifications.push({
        label: result.label,
        classifications: result.doctorWarnings
      });
    }
  }
}

async function runFlagshipLendingCampaign(ctx, workloadName) {
  const workload = ctx.workloadConfig.workloads[workloadName];
  const campaignPath = path.join(ctx.repoRoot, workload.campaign);
  const maxRunsArgs = maxRunsCliArgs(ctx.profile.flagship_max_runs);
  const primaryOut = path.join(ctx.outputsRoot, "flagship-lending", "primary");
  await mkdir(primaryOut, { recursive: true });

  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/campaign-validate`,
    args: ["campaign", "validate", campaignPath],
    expectedExitCodes: [0]
  });
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/campaign-plan`,
    args: ["campaign", "plan", campaignPath, "--out", primaryOut, ...maxRunsArgs],
    expectedExitCodes: [0],
    artifactRoot: primaryOut
  });
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/campaign-plan-json`,
    args: ["campaign", "plan", campaignPath, "--out", primaryOut, "--json", ...maxRunsArgs],
    expectedExitCodes: [0],
    artifactRoot: primaryOut
  });
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/campaign-run`,
    args: ["campaign", "run", campaignPath, "--out", primaryOut, ...maxRunsArgs],
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: primaryOut,
    timeoutMs: ctx.stressCommandTimeoutMs
  });

  const primaryRoot = findCampaignRoot(primaryOut);
  if (primaryRoot) {
    await reviewCampaignRoot(ctx, workloadName, `${workloadName}/campaign-review`, primaryRoot);
    await runFirstRetainedRerun(ctx, workloadName, `${workloadName}/retained-rerun`, primaryRoot);
  } else {
    recordSynthetic(ctx, {
      workload: workloadName,
      label: `${workloadName}/campaign-root-missing`,
      command: `find campaign_* under ${primaryOut}`,
      verdict: "fail",
      failureReason: "campaign run did not produce a campaign_* root",
      nextAction: "Inspect campaign-run stderr and setup errors."
    });
  }

  const determinismA = await runFlagshipDeterminismPass(ctx, workloadName, campaignPath, "a");
  const determinismB = await runFlagshipDeterminismPass(ctx, workloadName, campaignPath, "b");
  if (determinismA && determinismB) {
    await compareCampaignDeterminism(ctx, {
      workload: workloadName,
      label: `${workloadName}/determinism`,
      leftRoot: determinismA,
      rightRoot: determinismB,
      stableArtifacts: workload.stable_artifacts
    });
  }

  for (const budget of ctx.profile.flagship_stress_budgets ?? []) {
    const stressCampaign = await writeBudgetCampaignCopy(ctx, workloadName, campaignPath, budget);
    const stressOut = path.join(ctx.outputsRoot, "flagship-lending", `budget-${budget}`);
    await mkdir(stressOut, { recursive: true });
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/stress-budget-${budget}`,
      args: ["campaign", "run", stressCampaign, "--out", stressOut, ...maxRunsArgs],
      expectedExitCodes: [0, 1],
      acceptNonzeroAsFinding: true,
      artifactRoot: stressOut,
      timeoutMs: ctx.stressCommandTimeoutMs
    });
  }
}

async function runFlagshipDeterminismPass(ctx, workloadName, campaignPath, suffix) {
  const out = path.join(ctx.outputsRoot, "flagship-lending", `determinism-${suffix}`);
  await mkdir(out, { recursive: true });
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/determinism-${suffix}-run`,
    args: ["campaign", "run", campaignPath, "--out", out, ...maxRunsCliArgs(ctx.profile.flagship_max_runs)],
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: out,
    timeoutMs: ctx.stressCommandTimeoutMs
  });
  return findCampaignRoot(out);
}

async function runHarnessedPerpetuals(ctx, workloadName) {
  const workload = ctx.workloadConfig.workloads[workloadName];
  const source = path.join(ctx.caseStudiesRoot, workload.case_study);
  const copy = path.join(ctx.tempCaseStudiesRoot, workload.case_study);
  if (existsSync(source) && !existsSync(copy)) {
    await copyProjectThin(source, copy);
  }

  if (existsSync(copy)) {
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/readiness-json`,
      args: ["readiness", ".", "--json"],
      cwd: copy,
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(copy, ".riptide")
    });
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/lint-case-study-adapter`,
      args: ["lint", workload.adapter],
      cwd: copy,
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(copy, ".riptide")
    });

    const harnessPath = path.join(copy, workload.harness);
    if (existsSync(harnessPath)) {
      await runRiptide(ctx, {
        workload: workloadName,
        label: `${workloadName}/direct-harness-build-smoke`,
        args: [
          "run",
          "baseline",
          "--adapter",
          workload.adapter,
          "--harness",
          workload.harness,
          "--seeds",
          "1",
          "--seed-root",
          "1337",
          "--output-dir",
          path.join(ctx.outputsRoot, "perpetuals", "case-study-harness-build")
        ],
        cwd: copy,
        expectedExitCodes: [0, 1, 2],
        acceptNonzeroAsFinding: true,
        artifactRoot: path.join(ctx.outputsRoot, "perpetuals", "case-study-harness-build"),
        timeoutMs: ctx.stressCommandTimeoutMs
      });
      await runRiptide(ctx, {
        workload: workloadName,
        label: `${workloadName}/direct-harness-warm-smoke`,
        args: [
          "run",
          "baseline",
          "--adapter",
          workload.adapter,
          "--harness",
          workload.harness,
          "--seeds",
          "1",
          "--seed-root",
          "1337",
          "--output-dir",
          path.join(ctx.outputsRoot, "perpetuals", "case-study-harness-warm")
        ],
        cwd: copy,
        expectedExitCodes: [0, 1, 2],
        acceptNonzeroAsFinding: true,
        artifactRoot: path.join(ctx.outputsRoot, "perpetuals", "case-study-harness-warm"),
        timeoutMs: ctx.stressCommandTimeoutMs
      });
    } else {
      recordSynthetic(ctx, {
        workload: workloadName,
        label: `${workloadName}/case-study-harness-missing`,
        command: `test -d ${harnessPath}`,
        verdict: "skipped",
        failureReason: "perpetuals case-study copy has no .riptide/harness directory",
        nextAction: "Generate or commit a setup harness before requiring harnessed case-study execution.",
        classification: "unsupported case study"
      });
    }
  } else {
    recordSynthetic(ctx, {
      workload: workloadName,
      label: `${workloadName}/case-study-missing`,
      command: `test -d ${source}`,
      verdict: "skipped",
      failureReason: "perpetuals case-study source directory was not found",
      nextAction: "Check --case-studies-root or clone the case-study repo locally.",
      classification: "environment/tooling issue"
    });
  }

  for (const seeds of ctx.profile.perpetuals_direct_seeds ?? []) {
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/fixture-direct-seeds-${seeds}`,
      args: [
        "run",
        path.join(ctx.repoRoot, workload.fixture_scenario),
        "--adapter",
        path.join(ctx.repoRoot, workload.fixture_adapter),
        "--seeds",
        String(seeds),
        "--seed-root",
        "1337",
        "--output-dir",
        path.join(ctx.outputsRoot, "perpetuals", `direct-seeds-${seeds}`)
      ],
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(ctx.outputsRoot, "perpetuals", `direct-seeds-${seeds}`),
      timeoutMs: ctx.stressCommandTimeoutMs
    });
  }

  for (const budget of ctx.profile.perpetuals_campaign_budgets ?? []) {
    const campaignPath = await writePerpetualsCampaign(ctx, workloadName, workload, budget);
    const out = path.join(ctx.outputsRoot, "perpetuals", `campaign-budget-${budget}`);
    await mkdir(out, { recursive: true });
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/campaign-validate-budget-${budget}`,
      args: ["campaign", "validate", campaignPath],
      expectedExitCodes: [0]
    });
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/campaign-run-budget-${budget}`,
      args: ["campaign", "run", campaignPath, "--out", out],
      expectedExitCodes: [0, 1],
      acceptNonzeroAsFinding: true,
      artifactRoot: out,
      timeoutMs: ctx.stressCommandTimeoutMs
    });
    const campaignRoot = findCampaignRoot(out);
    if (campaignRoot) {
      await reviewCampaignRoot(ctx, workloadName, `${workloadName}/campaign-review-budget-${budget}`, campaignRoot);
      await runFirstRetainedRerun(ctx, workloadName, `${workloadName}/campaign-rerun-budget-${budget}`, campaignRoot);
    }
  }
}

async function runCaseStudyInitDevUx(ctx, workloadName) {
  const workload = ctx.workloadConfig.workloads[workloadName];
  const repoNames = await caseStudyRepoNames(ctx);
  for (const repoName of repoNames) {
    const source = path.join(ctx.caseStudiesRoot, repoName);
    const copy = path.join(ctx.tempCaseStudiesRoot, `init-ux-${repoName}`);
    if (!existsSync(source)) {
      recordSynthetic(ctx, {
        workload: workloadName,
        label: `${workloadName}/${repoName}/missing-source`,
        command: `test -d ${source}`,
        verdict: "skipped",
        failureReason: "case-study source directory was not found",
        nextAction: "Check --case-studies-root.",
        classification: "environment/tooling issue"
      });
      continue;
    }
    if (!existsSync(copy)) {
      await copyProjectThin(source, copy);
    }

    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/${repoName}/init-force`,
      args: ["init", "--force", "--quiet", "--yes"],
      cwd: copy,
      expectedExitCodes: [0, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(copy, ".riptide")
    });

    const blankOverride = workload.blank_overrides?.[repoName];
    if (blankOverride) {
      await runRiptide(ctx, {
        workload: workloadName,
        label: `${workloadName}/${repoName}/init-blank-explicit`,
        args: [
          "init",
          "--force",
          "--quiet",
          "--yes",
          "--blank",
          "--name",
          blankOverride.name,
          "--protocol",
          blankOverride.protocol
        ],
        cwd: copy,
        expectedExitCodes: [0],
        artifactRoot: path.join(copy, ".riptide")
      });
    }

    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/${repoName}/readiness`,
      args: ["readiness", ".", "--json"],
      cwd: copy,
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(copy, ".riptide")
    });
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/${repoName}/list`,
      args: ["list"],
      cwd: copy,
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(copy, ".riptide")
    });

    const adapterRel = await firstAdapterRel(copy);
    if (!adapterRel) {
      recordSynthetic(ctx, {
        workload: workloadName,
        label: `${workloadName}/${repoName}/adapter-missing`,
        command: "find .riptide/adapters/*.toml",
        verdict: "expected-finding",
        failureReason: "no adapter TOML was generated or discovered in the temp copy",
        nextAction: "Run `riptide init --blank --name <program> --protocol <protocol>` or restore .riptide/adapters.",
        classification: "expected scaffold blocker"
      });
      continue;
    }

    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/${repoName}/lint`,
      args: ["lint", adapterRel],
      cwd: copy,
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(copy, ".riptide")
    });
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/${repoName}/adapt`,
      args: ["adapt", "--adapter", adapterRel],
      cwd: copy,
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(copy, ".riptide"),
      timeoutMs: ctx.stressCommandTimeoutMs
    });
    await runRiptide(ctx, {
      workload: workloadName,
      label: `${workloadName}/${repoName}/baseline-run`,
      args: [
        "run",
        "baseline",
        "--adapter",
        adapterRel,
        "--seeds",
        "1",
        "--seed-root",
        "1337",
        "--output-dir",
        path.join(ctx.outputsRoot, "case-study-init", repoName, "runs")
      ],
      cwd: copy,
      expectedExitCodes: [0, 1, 2],
      acceptNonzeroAsFinding: true,
      artifactRoot: path.join(ctx.outputsRoot, "case-study-init", repoName, "runs"),
      timeoutMs: ctx.stressCommandTimeoutMs
    });
  }
}

async function runFailureRecoveryUx(ctx, workloadName) {
  const workload = ctx.workloadConfig.workloads[workloadName];
  const workRoot = path.join(ctx.outputsRoot, "failure-recovery", "inputs");
  await mkdir(workRoot, { recursive: true });
  const fixtureScenario = path.join(ctx.repoRoot, "fixtures/scenarios/perpetuals/funding-stress/run-config.json");
  const fixturePerpsAdapter = path.join(ctx.repoRoot, "fixtures/adapters/perpetuals.toml");
  const fixtureCampaign = path.join(ctx.repoRoot, workload.campaign);

  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/missing-adapter-path`,
    args: [
      "run",
      fixtureScenario,
      "--adapter",
      path.join(workRoot, "missing-adapter.toml"),
      "--output-dir",
      path.join(ctx.outputsRoot, "failure-recovery", "missing-adapter")
    ],
    expectedExitCodes: [1, 2],
    intentionalFailure: true,
    artifactRoot: path.join(ctx.outputsRoot, "failure-recovery", "missing-adapter")
  });

  const missingIdlAdapter = path.join(workRoot, "missing-idl-perpetuals.toml");
  await writeMutatedFile(fixturePerpsAdapter, missingIdlAdapter, (raw) =>
    raw
      .replace(
        'program_so = "../../programs/perpetuals/target/deploy/perpetuals.so"',
        `program_so = ${JSON.stringify(path.join(ctx.repoRoot, "programs/perpetuals/target/deploy/perpetuals.so"))}`
      )
      .replace('idl_path = "../idls/perpetuals.json"', 'idl_path = "target/idl/does-not-exist.json"')
  );
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/missing-idl-path`,
    args: ["adapt", "--adapter", missingIdlAdapter],
    expectedExitCodes: [1, 2],
    intentionalFailure: true
  });

  const missingSoAdapter = path.join(workRoot, "missing-so-perpetuals.toml");
  await writeMutatedFile(fixturePerpsAdapter, missingSoAdapter, (raw) =>
    raw.replace(
      'program_so = "../../programs/perpetuals/target/deploy/perpetuals.so"',
      'program_so = "target/deploy/does-not-exist.so"'
    )
  );
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/missing-program-so`,
    args: ["adapt", "--adapter", missingSoAdapter],
    expectedExitCodes: [1, 2],
    intentionalFailure: true
  });

  const stubRepo = path.join(workRoot, "incomplete-stub-repo");
  await mkdir(stubRepo, { recursive: true });
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/create-incomplete-init-stub`,
    args: ["init", "--blank", "--name", "incomplete-stub", "--protocol", "custom", "--quiet", "--yes"],
    cwd: stubRepo,
    expectedExitCodes: [0],
    artifactRoot: path.join(stubRepo, ".riptide")
  });
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/lint-incomplete-init-stub`,
    args: ["lint", ".riptide/adapters/incomplete-stub.toml"],
    cwd: stubRepo,
    expectedExitCodes: [1, 2],
    intentionalFailure: true,
    artifactRoot: path.join(stubRepo, ".riptide")
  });

  await runCorruptedCampaignResume(ctx, workloadName, fixtureCampaign);
  await runDeletedEvidenceReview(ctx, workloadName, fixtureCampaign);
  await runReviewRawCampaignRunDir(ctx, workloadName, fixtureCampaign);

  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/campaign-run-serve-unsupported`,
    args: ["campaign", "run", fixtureCampaign, "--serve", "--out", path.join(ctx.outputsRoot, "failure-recovery", "serve")],
    expectedExitCodes: [2],
    intentionalFailure: true
  });

  const unsupportedRetention = path.join(workRoot, "unsupported-retention.toml");
  await writeMutatedFile(fixtureCampaign, unsupportedRetention, (raw) =>
    raw.replace('"surprising_outlier"', '"class_specific_perps_liquidation"')
  );
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/unsupported-retention-label`,
    args: ["campaign", "validate", unsupportedRetention],
    expectedExitCodes: [2],
    intentionalFailure: true
  });

  await runCampaignResumeAfterPartial(ctx, workloadName, fixtureCampaign);
}

async function runColdDeveloperPath(ctx, workloadName) {
  const workload = ctx.workloadConfig.workloads[workloadName];
  if (!ctx.profile.include_cold_path) {
    recordSynthetic(ctx, {
      workload: workloadName,
      label: `${workloadName}/profile-skip`,
      command: "(profile gate)",
      verdict: "skipped",
      failureReason: "cold developer path is disabled for this profile",
      nextAction: "Run --profile max to include ./install.sh."
    });
    return;
  }

  const coldRoot = path.join(ctx.tempRoot, "cold-clone");
  const coldHome = path.join(ctx.tempRoot, "cold-home");
  await mkdir(coldHome, { recursive: true });

  const cloneResult = await runCommand(ctx, {
    workload: workloadName,
    label: `${workloadName}/git-clone-local`,
    argv: ["git", "clone", "--local", ctx.repoRoot, coldRoot],
    cwd: ctx.tempRoot,
    expectedExitCodes: [0],
    timeoutMs: ctx.commandTimeoutMs
  });
  if (cloneResult.verdict === "fail") return;

  const coldEnv = benchmarkEnv(coldHome);
  const installResult = await runCommand(ctx, {
    workload: workloadName,
    label: `${workloadName}/install-sh`,
    argv: ["./install.sh"],
    cwd: coldRoot,
    env: coldEnv,
    expectedExitCodes: [0],
    timeoutMs: ctx.stressCommandTimeoutMs,
    artifactRoot: coldRoot,
    nextAction: "Inspect install output for missing Rust, Node, cargo-build-sbf, or fixture build errors."
  });
  if (installResult.verdict === "fail") {
    recordSynthetic(ctx, {
      workload: workloadName,
      label: `${workloadName}/post-install-skipped`,
      command: "(install gate)",
      verdict: "skipped",
      failureReason: "./install.sh did not complete, so installed riptide was not trusted for follow-up commands",
      nextAction: "Fix the install blocker, then rerun the cold path.",
      classification: "environment/tooling issue"
    });
    return;
  }

  const coldRiptide = path.join(coldHome, ".local", "bin", "riptide");
  await runCommand(ctx, {
    workload: workloadName,
    label: `${workloadName}/doctor`,
    argv: [coldRiptide, "doctor"],
    cwd: coldRoot,
    env: coldEnv,
    expectedExitCodes: [0, 1, 2],
    acceptNonzeroAsFinding: true,
    timeoutMs: ctx.commandTimeoutMs
  });
  await runCommand(ctx, {
    workload: workloadName,
    label: `${workloadName}/root-help`,
    argv: [coldRiptide, "--help"],
    cwd: coldRoot,
    env: coldEnv,
    expectedExitCodes: [0],
    timeoutMs: ctx.commandTimeoutMs
  });

  const campaign = path.join(coldRoot, workload.campaign);
  const out = path.join(ctx.outputsRoot, "cold-developer", "campaign");
  await runCommand(ctx, {
    workload: workloadName,
    label: `${workloadName}/flagship-validate`,
    argv: [coldRiptide, "campaign", "validate", campaign],
    cwd: coldRoot,
    env: coldEnv,
    expectedExitCodes: [0],
    timeoutMs: ctx.commandTimeoutMs
  });
  await runCommand(ctx, {
    workload: workloadName,
    label: `${workloadName}/flagship-plan`,
    argv: [coldRiptide, "campaign", "plan", campaign, "--out", out, ...maxRunsCliArgs(ctx.profile.flagship_max_runs)],
    cwd: coldRoot,
    env: coldEnv,
    expectedExitCodes: [0],
    artifactRoot: out,
    timeoutMs: ctx.commandTimeoutMs
  });
  await runCommand(ctx, {
    workload: workloadName,
    label: `${workloadName}/flagship-run`,
    argv: [coldRiptide, "campaign", "run", campaign, "--out", out, ...maxRunsCliArgs(ctx.profile.flagship_max_runs)],
    cwd: coldRoot,
    env: coldEnv,
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: out,
    timeoutMs: ctx.stressCommandTimeoutMs
  });
  const root = findCampaignRoot(out);
  if (root) {
    await runCommand(ctx, {
      workload: workloadName,
      label: `${workloadName}/flagship-review`,
      argv: [coldRiptide, "review", root],
      cwd: coldRoot,
      env: coldEnv,
      expectedExitCodes: [0],
      artifactRoot: root,
      timeoutMs: ctx.commandTimeoutMs
    });
    await runFirstRetainedRerun(ctx, workloadName, `${workloadName}/retained-rerun`, root, {
      cwd: coldRoot,
      env: coldEnv
    });
  }
}

async function runCorruptedCampaignResume(ctx, workloadName, campaignPath) {
  const out = path.join(ctx.outputsRoot, "failure-recovery", "corrupted-generated-config");
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/corrupt-config-initial-run`,
    args: ["campaign", "run", campaignPath, "--out", out, "--max-runs", "1"],
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: out,
    timeoutMs: ctx.stressCommandTimeoutMs
  });
  const root = findCampaignRoot(out);
  const runConfig = root ? firstMatchingFile(path.join(root, "runs"), "run-config.json") : null;
  if (!runConfig) {
    recordSynthetic(ctx, {
      workload: workloadName,
      label: `${workloadName}/corrupt-config-target-missing`,
      command: "find runs/*/run-config.json",
      verdict: "fail",
      failureReason: "initial campaign run did not produce a generated run-config.json",
      nextAction: "Inspect the initial campaign run setup error."
    });
    return;
  }
  const parsed = JSON.parse(await readFile(runConfig, "utf8"));
  parsed.scenario = `${parsed.scenario ?? "baseline"}-corrupted`;
  await writeFile(runConfig, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/corrupted-generated-config-resume`,
    args: ["campaign", "run", campaignPath, "--out", out, "--max-runs", "1"],
    expectedExitCodes: [1],
    intentionalFailure: true,
    artifactRoot: out
  });
}

async function runDeletedEvidenceReview(ctx, workloadName, campaignPath) {
  const out = path.join(ctx.outputsRoot, "failure-recovery", "deleted-evidence");
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/deleted-evidence-initial-run`,
    args: ["campaign", "run", campaignPath, "--out", out, "--max-runs", "1"],
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: out,
    timeoutMs: ctx.stressCommandTimeoutMs
  });
  const root = findCampaignRoot(out);
  const simulationResult = root ? firstMatchingFile(path.join(root, "runs"), "simulation-result.json") : null;
  if (simulationResult) await unlink(simulationResult);
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/review-after-deleted-simulation-result`,
    args: ["review", root ?? out],
    expectedExitCodes: [1, 2],
    intentionalFailure: true,
    artifactRoot: root ?? out,
    nextAction: "Review accepted a campaign after a run simulation-result.json was deleted; tighten campaign evidence validation or adjust the expected recovery surface."
  });
}

async function runReviewRawCampaignRunDir(ctx, workloadName, campaignPath) {
  const out = path.join(ctx.outputsRoot, "failure-recovery", "raw-run-review");
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/raw-run-review-initial-run`,
    args: ["campaign", "run", campaignPath, "--out", out, "--max-runs", "1"],
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: out,
    timeoutMs: ctx.stressCommandTimeoutMs
  });
  const root = findCampaignRoot(out);
  const runDir = root ? firstRunDir(root) : null;
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/review-raw-campaign-run-dir`,
    args: ["review", runDir ?? out],
    expectedExitCodes: [1, 2],
    intentionalFailure: true,
    artifactRoot: runDir ?? out
  });
}

async function runCampaignResumeAfterPartial(ctx, workloadName, campaignPath) {
  const out = path.join(ctx.outputsRoot, "failure-recovery", "resume-after-partial");
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/resume-partial-first-run`,
    args: ["campaign", "run", campaignPath, "--out", out, "--max-runs", "1"],
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: out,
    timeoutMs: ctx.stressCommandTimeoutMs
  });
  await runRiptide(ctx, {
    workload: workloadName,
    label: `${workloadName}/resume-partial-second-run`,
    args: ["campaign", "run", campaignPath, "--out", out, "--max-runs", "2"],
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: out,
    timeoutMs: ctx.stressCommandTimeoutMs
  });
}

async function runRiptide(ctx, options) {
  return runCommand(ctx, {
    ...options,
    argv: [process.execPath, ctx.cliPath, ...options.args],
    cwd: options.cwd ?? ctx.repoRoot,
    env: options.env ?? ctx.env,
    timeoutMs: options.timeoutMs ?? ctx.commandTimeoutMs
  });
}

async function runCommand(ctx, options) {
  const commandIndex = ++ctx.commandIndex;
  const logSlug = `${String(commandIndex).padStart(3, "0")}-${slugify(options.label)}`;
  const stdoutPath = path.join(ctx.stdoutRoot, `${logSlug}.log`);
  const stderrPath = path.join(ctx.stderrRoot, `${logSlug}.log`);
  const expectedExitCodes = options.expectedExitCodes ?? [0];
  const startedAt = new Date();
  const startedMs = Date.now();
  const commandDisplay = displayCommand(options.argv);
  const cwd = options.cwd ?? ctx.repoRoot;
  const env = options.env ?? ctx.env;
  const timeoutMs = options.timeoutMs ?? ctx.commandTimeoutMs;

  let stdoutLog = "";
  let stderrLog = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let maxRssKb = 0;
  let cpuSampleTotal = 0;
  let sampleCount = 0;
  let timedOut = false;
  let spawnError = null;

  const child = spawn(options.argv[0], options.argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const sampler = setInterval(() => {
    if (!child.pid) return;
    const sample = sampleProcessTree(child.pid);
    maxRssKb = Math.max(maxRssKb, sample.rssKb);
    cpuSampleTotal += sample.cpuPct;
    sampleCount += 1;
  }, ctx.sampleIntervalMs);

  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child.pid);
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutBytes += Buffer.byteLength(text);
    stdoutLog = appendCappedTail(stdoutLog, text, ctx.logLimitBytes);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBytes += Buffer.byteLength(text);
    stderrLog = appendCappedTail(stderrLog, text, ctx.logLimitBytes);
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const { code, signal } = await new Promise((resolve) => {
    child.on("close", (closeCode, closeSignal) => {
      resolve({ code: closeCode, signal: closeSignal });
    });
  });

  clearTimeout(timeout);
  clearInterval(sampler);
  if (child.pid) {
    const finalSample = sampleProcessTree(child.pid);
    maxRssKb = Math.max(maxRssKb, finalSample.rssKb);
    cpuSampleTotal += finalSample.cpuPct;
    sampleCount += 1;
  }

  const wallMs = Date.now() - startedMs;
  await writeFile(stdoutPath, stdoutLog, "utf8");
  await writeFile(stderrPath, stderrLog, "utf8");

  const warningSummary = summarizeWarnings(`${stdoutLog}\n${stderrLog}`);
  const uxScore = scoreErrorUx(`${stdoutLog}\n${stderrLog}`);
  const assertionFailures = assertionFailuresFor(stdoutLog, stderrLog, options);
  const exitCode = typeof code === "number" ? code : null;
  let failureReason = "";
  let verdict = "pass";

  if (spawnError) {
    verdict = "fail";
    failureReason = `spawn failed: ${errorMessage(spawnError)}`;
  } else if (timedOut) {
    verdict = "fail";
    failureReason = `timed out after ${timeoutMs}ms`;
  } else if (!expectedExitCodes.includes(exitCode)) {
    verdict = "fail";
    failureReason = `expected exit ${expectedExitCodes.join("|")}, got ${exitCode ?? signal ?? "unknown"}`;
  } else if (assertionFailures.length > 0) {
    verdict = "fail";
    failureReason = assertionFailures.join("; ");
  } else if (options.intentionalFailure) {
    if (exitCode === 0) {
      verdict = "fail";
      failureReason = "intentional failure command exited 0";
    } else if (uxScore.score < 2) {
      verdict = "fail";
      failureReason = "intentional failure was not actionable enough";
    } else {
      verdict = "expected-finding";
    }
  } else if (options.acceptNonzeroAsFinding && exitCode !== 0) {
    verdict = "expected-finding";
  }

  let artifactMetrics = { bytes: 0, files: 0, root: options.artifactRoot ?? "" };
  if (options.artifactRoot) {
    artifactMetrics = await artifactStats(options.artifactRoot);
    ctx.artifacts.push({
      workload: options.workload,
      command_label: options.label,
      artifact_root: options.artifactRoot,
      artifact_bytes: artifactMetrics.bytes,
      artifact_files: artifactMetrics.files
    });
  }

  const result = {
    workload: options.workload,
    label: options.label,
    command: commandDisplay,
    cwd,
    exitCode,
    signal,
    expectedExitCodes,
    startedAt: startedAt.toISOString(),
    wallMs,
    maxRssKb,
    avgCpuPct: sampleCount > 0 ? Number((cpuSampleTotal / sampleCount).toFixed(2)) : 0,
    artifactBytes: artifactMetrics.bytes,
    artifactFiles: artifactMetrics.files,
    artifactRoot: artifactMetrics.root,
    stdoutBytes,
    stderrBytes,
    stdoutPath,
    stderrPath,
    stdoutLog,
    stderrLog,
    stdoutExcerpt: excerpt(stdoutLog),
    stderrExcerpt: excerpt(stderrLog),
    warningCount: warningSummary.warningCount,
    repeatedWarnings: warningSummary.repeatedWarnings,
    uxScore,
    verdict,
    failureReason,
    classification: classifyResult({
      label: options.label,
      verdict,
      stdoutLog,
      stderrLog,
      failureReason,
      intentionalFailure: Boolean(options.intentionalFailure),
      acceptNonzeroAsFinding: Boolean(options.acceptNonzeroAsFinding)
    }),
    nextAction: options.nextAction ?? extractNextAction(`${stderrLog}\n${stdoutLog}`)
  };
  ctx.results.push(result);
  return result;
}

function recordSynthetic(ctx, input) {
  const commandIndex = ++ctx.commandIndex;
  const result = {
    workload: input.workload,
    label: input.label,
    command: input.command,
    cwd: ctx.repoRoot,
    exitCode: input.exitCode ?? null,
    signal: null,
    expectedExitCodes: [],
    startedAt: new Date().toISOString(),
    wallMs: 0,
    maxRssKb: 0,
    avgCpuPct: 0,
    artifactBytes: 0,
    artifactFiles: 0,
    artifactRoot: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPath: "",
    stderrPath: "",
    stdoutLog: "",
    stderrLog: input.failureReason ?? "",
    stdoutExcerpt: "",
    stderrExcerpt: input.failureReason ?? "",
    warningCount: 0,
    repeatedWarnings: [],
    uxScore: { score: 0, hasFileOrKey: false, hasCause: false, hasNextAction: Boolean(input.nextAction), hasSupportBoundary: false },
    verdict: input.verdict,
    failureReason: input.failureReason ?? "",
    classification: input.classification ?? classifyResult({
      label: input.label,
      verdict: input.verdict,
      stdoutLog: "",
      stderrLog: input.failureReason ?? "",
      failureReason: input.failureReason ?? "",
      intentionalFailure: false,
      acceptNonzeroAsFinding: false
    }),
    nextAction: input.nextAction ?? ""
  };
  const slug = `${String(commandIndex).padStart(3, "0")}-${slugify(input.label)}`;
  result.stdoutPath = path.join(ctx.stdoutRoot, `${slug}.log`);
  result.stderrPath = path.join(ctx.stderrRoot, `${slug}.log`);
  ctx.results.push(result);
  return result;
}

async function reviewCampaignRoot(ctx, workloadName, label, campaignRoot) {
  await runRiptide(ctx, {
    workload: workloadName,
    label,
    args: ["review", campaignRoot],
    expectedExitCodes: [0],
    artifactRoot: campaignRoot
  });
}

async function runFirstRetainedRerun(ctx, workloadName, label, campaignRoot, overrides = {}) {
  const rerun = firstRetainedRerun(campaignRoot);
  if (!rerun) {
    recordSynthetic(ctx, {
      workload: workloadName,
      label: `${label}-missing`,
      command: `find ${campaignRoot}/retained/*/rerun.sh`,
      verdict: "fail",
      failureReason: "no retained rerun.sh was found",
      nextAction: "Inspect retention-manifest.json and campaign retention labels."
    });
    return;
  }
  await runCommand(ctx, {
    workload: workloadName,
    label,
    argv: ["sh", rerun],
    cwd: overrides.cwd ?? ctx.repoRoot,
    env: overrides.env ?? ctx.env,
    expectedExitCodes: [0, 1],
    acceptNonzeroAsFinding: true,
    artifactRoot: path.dirname(rerun),
    timeoutMs: ctx.stressCommandTimeoutMs
  });
}

async function compareCampaignDeterminism(ctx, input) {
  const comparisons = [];
  let verdict = "pass";
  for (const rel of input.stableArtifacts) {
    const left = path.join(input.leftRoot, rel);
    const right = path.join(input.rightRoot, rel);
    const comparison = await compareStableFiles(left, right, input.leftRoot, input.rightRoot);
    comparisons.push({ artifact: rel, ...comparison });
    if (!comparison.match) verdict = "fail";
  }

  const leftCases = retainedCaseFiles(input.leftRoot);
  const rightCases = retainedCaseFiles(input.rightRoot);
  const caseRels = [...new Set([...leftCases.keys(), ...rightCases.keys()])].sort().slice(0, 8);
  for (const rel of caseRels) {
    const comparison = await compareStableFiles(
      leftCases.get(rel),
      rightCases.get(rel),
      input.leftRoot,
      input.rightRoot
    );
    comparisons.push({ artifact: rel, ...comparison });
    if (!comparison.match) verdict = "fail";
  }

  const entry = {
    workload: input.workload,
    label: input.label,
    left_root: input.leftRoot,
    right_root: input.rightRoot,
    verdict,
    comparisons
  };
  ctx.determinism.push(entry);

  recordSynthetic(ctx, {
    workload: input.workload,
    label: input.label,
    command: `compare ${input.leftRoot} ${input.rightRoot}`,
    verdict: verdict === "pass" ? "pass" : "fail",
    failureReason: verdict === "pass" ? "" : "stable campaign artifacts did not match",
    nextAction: "Open determinism.json and inspect the mismatched artifact hashes."
  });
}

async function compareStableFiles(left, right, leftRoot, rightRoot) {
  if (!left || !right || !existsSync(left) || !existsSync(right)) {
    return {
      match: false,
      left_hash: left && existsSync(left) ? await stableHashFile(left, leftRoot) : null,
      right_hash: right && existsSync(right) ? await stableHashFile(right, rightRoot) : null,
      reason: "missing artifact on one side"
    };
  }
  const leftHash = await stableHashFile(left, leftRoot);
  const rightHash = await stableHashFile(right, rightRoot);
  return {
    match: leftHash === rightHash,
    left_hash: leftHash,
    right_hash: rightHash,
    reason: leftHash === rightHash ? "" : "hash mismatch after output-root normalization"
  };
}

async function stableHashFile(file, campaignRoot) {
  const raw = await readFile(file);
  const ext = path.extname(file);
  if ([".json", ".md", ".csv", ".sh", ".txt", ".jsonl"].includes(ext)) {
    let text = raw.toString("utf8");
    const replacements = [
      [campaignRoot, "$CAMPAIGN_ROOT"],
      [path.dirname(campaignRoot), "$CAMPAIGN_OUTPUT_ROOT"]
    ];
    for (const [from, to] of replacements) {
      text = replaceAll(text, from, to);
    }
    return sha256(`riptide-stable-v1\n${text}`);
  }
  return sha256(Buffer.concat([Buffer.from("riptide-stable-v1\n"), raw]));
}

async function writeBudgetCampaignCopy(ctx, workloadName, source, budget) {
  const dir = path.join(ctx.outputsRoot, "generated-campaigns", workloadName);
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `lending-budget-${budget}.toml`);
  await writeMutatedFile(source, dest, (raw) =>
    rewriteFlagshipCampaignPaths(ctx, raw).replace(/run_budget = \d+/, `run_budget = ${budget}`)
  );
  return dest;
}

function rewriteFlagshipCampaignPaths(ctx, raw) {
  return raw
    .replace(
      'adapter = "../../../adapters/lending.toml"',
      `adapter = ${JSON.stringify(path.join(ctx.repoRoot, "fixtures/adapters/lending.toml"))}`
    )
    .replaceAll(
      'source = "../../../scenarios/lending/oracle-lag-baseline"',
      `source = ${JSON.stringify(path.join(ctx.repoRoot, "fixtures/scenarios/lending/oracle-lag-baseline"))}`
    )
    .replaceAll(
      'source = "../../../scenarios/lending/whale-shock-grid"',
      `source = ${JSON.stringify(path.join(ctx.repoRoot, "fixtures/scenarios/lending/whale-shock-grid"))}`
    )
    .replaceAll(
      'source = "../../../scenarios/lending/whale-share-sweep"',
      `source = ${JSON.stringify(path.join(ctx.repoRoot, "fixtures/scenarios/lending/whale-share-sweep"))}`
    )
    .replace(
      'base = "../../../personas"',
      `base = ${JSON.stringify(path.join(ctx.repoRoot, "fixtures/personas"))}`
    );
}

async function writePerpetualsCampaign(ctx, workloadName, workload, budget) {
  const dir = path.join(ctx.outputsRoot, "generated-campaigns", workloadName);
  await mkdir(dir, { recursive: true });
  const scenarioPath = path.join(ctx.repoRoot, workload.fixture_scenario);
  const adapterPath = path.join(ctx.repoRoot, workload.fixture_adapter);
  const personasPath = path.join(ctx.repoRoot, "fixtures/personas");
  const dest = path.join(dir, `perpetuals-budget-${budget}.toml`);
  const scenarioSource = path.dirname(scenarioPath);
  const text = `[campaign]
name = "perps-funding-stress-s26-${budget}"
adapter = ${JSON.stringify(adapterPath)}
class = ${JSON.stringify(workload.campaign_class)}
risk_objective = "custom:perps-funding-stress"
run_budget = ${budget}
seed_policy = "fixed:20260503"
replay_retention = ["first_failure", "worst_bad_debt", "worst_liquidity", "median"]

[campaign.scenarios]
selection = "weighted"
families = ["funding_stress"]

[campaign.scenarios.funding_stress]
source = ${JSON.stringify(scenarioSource)}
weight = 1
parameters = ["shock_profile"]

[campaign.personas]
base = ${JSON.stringify(personasPath)}
families = []

[campaign.parameters.fixed_one]
distribution = "fixed"
value = 1

[campaign.parameters.shock_profile]
distribution = "fixed"
value = "funding-stress"
`;
  await writeFile(dest, text, "utf8");
  return dest;
}

async function writeMutatedFile(source, dest, mutate) {
  await mkdir(path.dirname(dest), { recursive: true });
  const raw = await readFile(source, "utf8");
  await writeFile(dest, mutate(raw), "utf8");
}

async function caseStudyRepoNames(ctx) {
  const configured = ctx.profile.case_study_repos;
  if (Array.isArray(configured)) return configured;
  const entries = await readdir(ctx.caseStudiesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

async function firstAdapterRel(repo) {
  const adaptersDir = path.join(repo, ".riptide", "adapters");
  if (!existsSync(adaptersDir)) return null;
  const files = (await readdir(adaptersDir)).filter((file) => file.endsWith(".toml")).sort();
  if (files.length === 0) return null;
  return path.posix.join(".riptide", "adapters", files[0]);
}

async function copyProjectThin(source, dest) {
  await mkdir(dest, { recursive: true });
  await copyProjectEntry(source, dest, "");
}

async function copyProjectEntry(sourceRoot, destRoot, rel) {
  const sourcePath = path.join(sourceRoot, rel);
  const destPath = path.join(destRoot, rel);
  const entry = await lstat(sourcePath);
  if (shouldSkipCopy(rel, entry)) return;

  if (entry.isSymbolicLink()) {
    const target = await readlink(sourcePath);
    await mkdir(path.dirname(destPath), { recursive: true });
    try {
      await symlink(target, destPath);
    } catch {
      // Existing symlink in a reused output root is harmless for this harness.
    }
    return;
  }

  if (entry.isDirectory()) {
    await mkdir(destPath, { recursive: true });
    const children = await readdir(sourcePath);
    for (const child of children) {
      await copyProjectEntry(sourceRoot, destRoot, path.join(rel, child));
    }
    return;
  }

  if (entry.isFile()) {
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);
  }
}

function shouldSkipCopy(rel, entry) {
  if (!rel) return false;
  const parts = rel.split(path.sep);
  if (parts.includes(".git")) return true;
  if (parts.includes("node_modules")) return true;
  if (parts.includes("dist")) return true;
  if (parts.includes("coverage")) return true;
  if (parts[0] === ".yarn" && parts[1] === "cache") return true;
  const targetIndex = parts.indexOf("target");
  if (targetIndex >= 0) {
    if (parts.length === targetIndex + 1) return false;
    const next = parts[targetIndex + 1];
    return !["deploy", "idl", "types"].includes(next);
  }
  if (parts[0] === ".riptide" && ["runs", "campaigns", "pack"].includes(parts[1])) return true;
  if (entry.isFile() && entry.size > 50 * 1024 * 1024) return true;
  return false;
}

function benchmarkEnv(homeRoot) {
  return {
    ...process.env,
    HOME: homeRoot,
    CARGO_HOME: process.env.CARGO_HOME ?? "/home/ailton/.cargo",
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? "/home/ailton/.rustup",
    CI: "1",
    NO_COLOR: "1",
    RIPTIDE_QA_BENCH: "1",
    PATH: [
      path.join(homeRoot, ".local", "bin"),
      path.join(REPO_ROOT, "cli", "node_modules", ".bin"),
      "/home/ailton/.cargo/bin",
      "/home/ailton/.local/share/solana/install/active_release/bin",
      process.env.PATH ?? ""
    ].join(":")
  };
}

function sampleProcessTree(rootPid) {
  if (!rootPid) return { rssKb: 0, cpuPct: 0 };
  const ps = spawnSync("ps", ["-eo", "pid=,ppid=,rss=,pcpu="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (ps.status !== 0 || !ps.stdout) return { rssKb: 0, cpuPct: 0 };

  const rows = [];
  const byParent = new Map();
  for (const line of ps.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const row = {
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      rss: Number(parts[2]),
      cpu: Number(parts[3])
    };
    if (!Number.isFinite(row.pid) || !Number.isFinite(row.ppid)) continue;
    rows.push(row);
    const siblings = byParent.get(row.ppid) ?? [];
    siblings.push(row.pid);
    byParent.set(row.ppid, siblings);
  }

  const wanted = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of byParent.get(pid) ?? []) {
      if (!wanted.has(child)) {
        wanted.add(child);
        queue.push(child);
      }
    }
  }

  let rssKb = 0;
  let cpuPct = 0;
  for (const row of rows) {
    if (!wanted.has(row.pid)) continue;
    rssKb += Number.isFinite(row.rss) ? row.rss : 0;
    cpuPct += Number.isFinite(row.cpu) ? row.cpu : 0;
  }
  return { rssKb, cpuPct };
}

function terminateProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already exited.
      }
    }
  }, 5000).unref();
}

async function artifactStats(root) {
  if (!root || !existsSync(root)) return { root: root ?? "", bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const info = await stat(full);
          files += 1;
          bytes += info.size;
        } catch {
          // Ignore files that disappear while the command is finishing.
        }
      }
    }
  }
  await walk(root);
  return { root, bytes, files };
}

function findCampaignRoot(outputRoot) {
  if (!existsSync(outputRoot)) return null;
  const candidates = readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("campaign_"))
    .map((entry) => path.join(outputRoot, entry.name));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function firstRetainedRerun(campaignRoot) {
  const retainedRoot = path.join(campaignRoot, "retained");
  if (!existsSync(retainedRoot)) return null;
  const dirs = readdirSync(retainedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(retainedRoot, entry.name))
    .sort();
  for (const dir of dirs) {
    const rerun = path.join(dir, "rerun.sh");
    if (existsSync(rerun)) return rerun;
  }
  return null;
}

function firstRunDir(campaignRoot) {
  const runsRoot = path.join(campaignRoot, "runs");
  if (!existsSync(runsRoot)) return null;
  const dirs = readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsRoot, entry.name))
    .sort();
  return dirs[0] ?? null;
}

function firstMatchingFile(root, fileName) {
  if (!root || !existsSync(root)) return null;
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return full;
    if (entry.isDirectory()) {
      const found = firstMatchingFile(full, fileName);
      if (found) return found;
    }
  }
  return null;
}

function retainedCaseFiles(campaignRoot) {
  const retainedRoot = path.join(campaignRoot, "retained");
  const cases = new Map();
  if (!existsSync(retainedRoot)) return cases;
  const dirs = readdirSync(retainedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const file = path.join(retainedRoot, dir, "case.json");
    if (existsSync(file)) cases.set(path.posix.join("retained", dir, "case.json"), file);
  }
  return cases;
}

function maxRunsCliArgs(value) {
  return Number.isInteger(value) && value > 0 ? ["--max-runs", String(value)] : [];
}

function assertionFailuresFor(stdout, stderr, options) {
  const failures = [];
  for (const needle of options.stdoutIncludes ?? []) {
    if (!stdout.includes(needle)) failures.push(`stdout missing ${JSON.stringify(needle)}`);
  }
  for (const needle of options.stderrIncludes ?? []) {
    if (!stderr.includes(needle)) failures.push(`stderr missing ${JSON.stringify(needle)}`);
  }
  for (const needle of options.combinedIncludes ?? []) {
    if (!`${stdout}\n${stderr}`.includes(needle)) failures.push(`output missing ${JSON.stringify(needle)}`);
  }
  return failures;
}

function summarizeWarnings(text) {
  const warningLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(warn|warning|deprecated)\b/i.test(line));
  const counts = new Map();
  for (const line of warningLines) {
    const normalized = line.replace(/\d+/g, "<n>").replace(/\s+/g, " ").slice(0, 240);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return {
    warningCount: warningLines.length,
    repeatedWarnings: [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([line, count]) => ({ line, count }))
  };
}

function classifyDoctorWarnings(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(warn|warning|fail|missing|required|optional)\b/i.test(line))
    .filter((line) => !/^PASS\s*:\d+\s+WARN\s*:0\s+FAIL\s*:0$/i.test(line))
    .map((line) => ({
      line,
      class: doctorWarningClass(line)
    }));
}

function doctorWarningClass(line) {
  const lower = line.toLowerCase();
  if (/fail|required|missing|not found|cannot|unable/.test(lower)) return "blocking";
  if (/optional|informational|skip|not built|fixture/.test(lower)) return "optional";
  return "actionable";
}

function scoreErrorUx(text) {
  text = normalizeDiagnosticText(text);
  const lower = text.toLowerCase();
  const hasFileOrKey =
    /(\.toml|\.json|\.so|\.riptide|run-config|simulation-result|campaign-summary|retention-manifest|adapter|idl|program_so)/i.test(text);
  const hasCause =
    /(missing|not found|expected|invalid|unsupported|corrupt|mismatch|failed|cannot|could not|still an incomplete|todo)/i.test(text);
  const hasNextAction =
    /\b(next|hint|rerun|run `|restore|fix|pass --|open |use |inspect)\b/i.test(text);
  const hasSupportBoundary =
    /(unsupported|not supported|reserved for a future|stub|todo|out of scope|inspection-only|does not execute)/i.test(text);
  return {
    score: [hasFileOrKey, hasCause, hasNextAction, hasSupportBoundary].filter(Boolean).length,
    hasFileOrKey,
    hasCause,
    hasNextAction,
    hasSupportBoundary,
    excerpt: excerpt(text)
  };
}

function classifyResult(input) {
  const text = normalizeDiagnosticText(`${input.label}\n${input.stdoutLog}\n${input.stderrLog}\n${input.failureReason}`).toLowerCase();
  if (input.intentionalFailure && input.verdict === "fail" && /got 0|exited 0|exit 0/.test(text)) return "Riptide bug";
  if (input.verdict === "skipped" && /harness|unsupported|stub/.test(text)) return "unsupported case study";
  if (/stub|todo|incomplete `riptide init`|fill the todo|scaffold/.test(text)) return "expected scaffold blocker";
  if (/unsupported|not supported|reserved for a future|out of scope|class-specific/.test(text)) return "unsupported case study";
  if (/cargo-build-sbf|toolchain|rustc|npm|node|enoent|not found on path|permission|install failed|engine binary|\.so|no such file|missing.*target\/deploy/.test(text)) {
    return "environment/tooling issue";
  }
  if (input.intentionalFailure) return "expected failure UX";
  if (input.acceptNonzeroAsFinding && input.verdict === "expected-finding") return "Riptide bug";
  return input.verdict === "fail" ? "Riptide bug" : "pass";
}

function extractNextAction(text) {
  text = normalizeDiagnosticText(text);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const next = lines.find((line) => /\b(next|hint|rerun|restore|fix|pass --|inspect)\b/i.test(line));
  if (next) return next.slice(0, 500);
  return "";
}

function normalizeDiagnosticText(text) {
  return String(text).replaceAll("\\n", "\n");
}

function appendCappedTail(existing, chunk, limitBytes) {
  let combined = existing + chunk;
  while (Buffer.byteLength(combined) > limitBytes) {
    combined = combined.slice(Math.max(1, combined.length - limitBytes));
  }
  return combined;
}

function excerpt(text, limit = 1600) {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(trimmed.length - limit);
}

function displayCommand(argv) {
  return argv.map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function replaceAll(value, from, to) {
  return value.split(from).join(to);
}

function gitMetadata(repoRoot) {
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--short"], { cwd: repoRoot, encoding: "utf8" });
  return {
    head: rev.status === 0 ? rev.stdout.trim() : "",
    branch: branch.status === 0 ? branch.stdout.trim() : "",
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null
  };
}

async function writeBenchmarkOutputs(ctx) {
  const finishedAt = new Date().toISOString();
  const summary = summarizeResults(ctx);
  const resultsForJson = ctx.results.map((result) => ({
    ...result,
    stdoutLog: undefined,
    stderrLog: undefined
  }));
  const resultsJson = {
    schema_version: ctx.schemaVersion,
    profile: ctx.profileName,
    repo_root: ctx.repoRoot,
    git: ctx.git,
    temp_roots: {
      root: ctx.tempRoot,
      outputs: ctx.outputsRoot,
      home: ctx.homeRoot,
      case_studies: ctx.tempCaseStudiesRoot
    },
    started_at: ctx.startedAt,
    finished_at: finishedAt,
    summary,
    workload_errors: ctx.workloadErrors,
    doctor_classifications: ctx.doctorClassifications,
    results: resultsForJson
  };

  await writeFile(path.join(ctx.outputsRoot, "results.json"), `${JSON.stringify(resultsJson, null, 2)}\n`, "utf8");
  await writeFile(path.join(ctx.outputsRoot, "summary.csv"), renderSummaryCsv(ctx.results), "utf8");
  await writeFile(path.join(ctx.outputsRoot, "artifacts.csv"), renderArtifactsCsv(ctx.artifacts), "utf8");
  await writeFile(path.join(ctx.outputsRoot, "determinism.json"), `${JSON.stringify(ctx.determinism, null, 2)}\n`, "utf8");

  const report = renderReport(ctx, summary, finishedAt);
  const reportPath = path.join(ctx.outputsRoot, "report.md");
  await writeFile(reportPath, report, "utf8");
  if (!ctx.skipObsidian && ctx.obsidianReport) {
    await mkdir(path.dirname(ctx.obsidianReport), { recursive: true });
    await writeFile(ctx.obsidianReport, report, "utf8");
  }
}

function summarizeResults(ctx) {
  const counts = {};
  for (const result of ctx.results) {
    counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  }
  const byWorkload = {};
  for (const result of ctx.results) {
    const item = byWorkload[result.workload] ?? { pass: 0, fail: 0, expected_finding: 0, skipped: 0, total: 0 };
    item.total += 1;
    if (result.verdict === "pass") item.pass += 1;
    else if (result.verdict === "fail") item.fail += 1;
    else if (result.verdict === "expected-finding") item.expected_finding += 1;
    else if (result.verdict === "skipped") item.skipped += 1;
    byWorkload[result.workload] = item;
  }
  return {
    total_commands: ctx.results.length,
    counts,
    by_workload: byWorkload,
    determinism_failures: ctx.determinism.filter((entry) => entry.verdict === "fail").length
  };
}

function renderSummaryCsv(results) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const result of results) {
    const row = {
      workload: result.workload,
      command_label: result.label,
      exit_code: result.exitCode ?? "",
      expected_exit_code: result.expectedExitCodes.join("|"),
      wall_ms: result.wallMs,
      max_rss_kb: result.maxRssKb,
      avg_cpu_pct: result.avgCpuPct,
      artifact_bytes: result.artifactBytes,
      artifact_files: result.artifactFiles,
      stdout_bytes: result.stdoutBytes,
      stderr_bytes: result.stderrBytes,
      warning_count: result.warningCount,
      verdict: result.verdict
    };
    lines.push(CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderArtifactsCsv(artifacts) {
  const columns = ["workload", "command_label", "artifact_root", "artifact_bytes", "artifact_files"];
  const lines = [columns.join(",")];
  for (const artifact of artifacts) {
    lines.push(columns.map((column) => csvEscape(artifact[column] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function renderReport(ctx, summary, finishedAt) {
  const failed = ctx.results.filter((result) => result.verdict === "fail");
  const findings = ctx.results.filter((result) => result.verdict === "expected-finding");
  const skipped = ctx.results.filter((result) => result.verdict === "skipped");
  const categoryRows = categorySummary([...failed, ...findings, ...skipped]);
  const workloadRows = Object.entries(summary.by_workload)
    .map(([name, item]) => `| ${name} | ${item.pass} | ${item.expected_finding} | ${item.fail} | ${item.skipped} | ${item.total} |`)
    .join("\n");
  const failureRows = [...failed, ...findings]
    .slice(0, 40)
    .map((result) => {
      const reason = result.failureReason || result.stderrExcerpt || result.stdoutExcerpt || "(see logs)";
      const next = result.nextAction || "Inspect the capped stdout/stderr logs.";
      return `| ${result.verdict} | ${result.classification} | ${result.label} | ${result.exitCode ?? ""} | ${oneLine(reason, 160)} | ${oneLine(next, 160)} |`;
    })
    .join("\n");
  const determinismRows = ctx.determinism.length === 0
    ? "| (none) |  |  |"
    : ctx.determinism.map((entry) => `| ${entry.label} | ${entry.verdict} | ${entry.comparisons.filter((item) => !item.match).length} |`).join("\n");
  const doctorRows = ctx.doctorClassifications.flatMap((entry) =>
    entry.classifications.map((item) => `| ${item.class} | ${oneLine(item.line, 180)} |`)
  ).join("\n") || "| (none captured) | |";

  return `# QA - Sprint 26 Benchmark And Dev UX

Generated: ${finishedAt}

Profile: \`${ctx.profileName}\`
Repo: \`${ctx.repoRoot}\`
Git: \`${ctx.git.branch}@${ctx.git.head.slice(0, 12)}\`${ctx.git.dirty ? " (dirty)" : ""}
Output root: \`${ctx.outputsRoot}\`

This suite is a stress and developer-UX harness. It records local behavior, determinism signals, failure quality, runtime, memory, and artifact growth. It is not an audit proof, a mainnet replay proof, or a complete safety claim.

## Summary

| Workload | Pass | Expected finding | Fail | Skipped | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
${workloadRows}

Determinism failures: ${summary.determinism_failures}

## Finding Categories

| Category | Count |
| --- | ---: |
${categoryRows}

## Failed Or Expected Findings

| Verdict | Category | Command | Exit | Reason | Next action |
| --- | --- | --- | ---: | --- | --- |
${failureRows || "| (none) | | | | | |"}

## Determinism

| Comparison | Verdict | Mismatches |
| --- | --- | ---: |
${determinismRows}

## Doctor Warning Classification

| Class | Line |
| --- | --- |
${doctorRows}

## Output Files

- \`results.json\`: full structured result set
- \`summary.csv\`: one row per command/workload
- \`artifacts.csv\`: artifact file-count and byte metrics
- \`determinism.json\`: stable artifact comparison details
- \`stdout/\` and \`stderr/\`: capped command logs

## Interpretation Boundary

Use failures in this report as triage leads:

- \`Riptide bug\`: unexpected CLI, campaign, review, resume, determinism, or artifact behavior.
- \`unsupported case study\`: the case study or workflow is outside the committed supported surface.
- \`expected scaffold blocker\`: an init-generated stub or intentionally incomplete adapter produced a blocker with recovery guidance.
- \`environment/tooling issue\`: local toolchain, missing build artifact, install, PATH, or filesystem prerequisites blocked execution.
`;
}

function categorySummary(results) {
  const counts = new Map();
  for (const result of results) {
    counts.set(result.classification, (counts.get(result.classification) ?? 0) + 1);
  }
  if (counts.size === 0) return "| (none) | 0 |";
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `| ${category} | ${count} |`)
    .join("\n");
}

function oneLine(value, limit) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`s26-benchmark: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
