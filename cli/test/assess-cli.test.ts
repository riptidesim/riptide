import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAssess, type AssessCommandDeps } from "../src/commands/assess.js";
import { writeCorrectnessWorkspace, writeFlagshipRoot } from "./assess-fixture.js";

const OVERCLAIM = /guarantee|proven safe|certified|audit replacement|audit signoff|complete protocol safety/i;

interface Captured {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function assess(
  campaignRoot: string,
  options: Parameters<typeof runAssess>[1],
  extra: Partial<AssessCommandDeps> = {}
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runAssess(campaignRoot, options, {
    stdoutWrite: (chunk) => {
      stdout += chunk;
    },
    stderrWrite: (chunk) => {
      stderr += chunk;
    },
    color: false,
    ...extra
  });
  return { exitCode, stdout, stderr };
}

test("assess cli: writes assessment.json + assessment.md into the campaign root", async () => {
  const { root } = await writeFlagshipRoot();
  try {
    const { exitCode, stdout } = await assess(root, {});
    assert.equal(exitCode, 0);

    const jsonRaw = await readFile(path.join(root, "assessment.json"), "utf8");
    const model = JSON.parse(jsonRaw) as { schema_version: string; assessment_digest: string };
    assert.equal(model.schema_version, "assessment.v1");
    assert.match(model.assessment_digest, /^[0-9a-f]{64}$/);

    const md = await readFile(path.join(root, "assessment.md"), "utf8");
    assert.match(md, /# Protocol assessment — whale-shock-cartography/);
    assert.match(md, /## Risk Surface/);
    assert.match(md, /- \*\*Assessment date:\*\* 2026-05-23/);
    // Paths render through the repo/workspace-relative label, never the absolute
    // campaign root (R1): the reproduction command + artifact refs carry the
    // stable label and no `/home/` or `/tmp/` machine path leaks in.
    const label = path.basename(root);
    assert.match(md, new RegExp(`riptide assess ${escapeRegExp(label)}`));
    assert.match(md, new RegExp(`${escapeRegExp(label)}\\/risk-surface\\.json`));
    assert.doesNotMatch(md, new RegExp(escapeRegExp(root)));
    assert.doesNotMatch(md, /\/home\/|\/tmp\//);
    assert.doesNotMatch(md, /<campaign\.toml>|<dir>/);
    assert.ok(md.endsWith("\n"));

    // Cold-read stdout names both artifacts and the assessment digest.
    assert.match(stdout, /Assessment generated/);
    assert.match(stdout, /assessment\.json/);
    assert.match(stdout, /assessment\.md/);
    assert.match(stdout, new RegExp(`Assessment digest: ${model.assessment_digest}`));
    assert.match(stdout, /Verdict: needs_campaign_tuning \(derived\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: assessment.json + assessment.md are byte-identical across two runs", async () => {
  const { root } = await writeFlagshipRoot();
  try {
    await assess(root, {});
    const json1 = await readFile(path.join(root, "assessment.json"), "utf8");
    const md1 = await readFile(path.join(root, "assessment.md"), "utf8");

    await assess(root, {});
    const json2 = await readFile(path.join(root, "assessment.json"), "utf8");
    const md2 = await readFile(path.join(root, "assessment.md"), "utf8");

    assert.equal(json1, json2);
    assert.equal(md1, md2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: --out redirects artifacts away from the campaign root", async () => {
  const { root } = await writeFlagshipRoot();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-assess-out-"));
  try {
    const { exitCode, stdout } = await assess(root, { out: outDir });
    assert.equal(exitCode, 0);
    await readFile(path.join(outDir, "assessment.json"), "utf8");
    await readFile(path.join(outDir, "assessment.md"), "utf8");
    await assert.rejects(readFile(path.join(root, "assessment.json"), "utf8"));
    assert.match(stdout, new RegExp(`riptide review ${escapeRegExp(root)}`));
    assert.doesNotMatch(stdout, new RegExp(`riptide review ${escapeRegExp(outDir)}`));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("assess cli: --verdict and identity flags fold into the model", async () => {
  const { root } = await writeFlagshipRoot();
  try {
    const { exitCode } = await assess(root, {
      verdict: "needs_guided_sim",
      commit: "abc123",
      riptideVersion: "riptide 9.9.9"
    });
    assert.equal(exitCode, 0);
    const model = JSON.parse(await readFile(path.join(root, "assessment.json"), "utf8")) as {
      verdict: { value: string; source: string };
      protocol: { commit: string | null; riptide_version: string | null };
    };
    assert.equal(model.verdict.value, "needs_guided_sim");
    assert.equal(model.verdict.source, "declared");
    assert.equal(model.protocol.commit, "abc123");
    assert.equal(model.protocol.riptide_version, "riptide 9.9.9");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: --input file folds Risk Plan / verdict over campaign defaults", async () => {
  const { root } = await writeFlagshipRoot();
  const inputPath = path.join(root, "inputs.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      verdict: "ready_to_send",
      riskPlan: { target_claim: "Custom bounded claim for the lending cartography sweep." }
    }),
    "utf8"
  );
  try {
    const { exitCode } = await assess(root, { input: inputPath });
    assert.equal(exitCode, 0);
    const model = JSON.parse(await readFile(path.join(root, "assessment.json"), "utf8")) as {
      verdict: { value: string };
      risk_plan: { target_claim: string };
    };
    assert.equal(model.verdict.value, "ready_to_send");
    assert.equal(model.risk_plan.target_claim, "Custom bounded claim for the lending cartography sweep.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: --json emits a machine-readable result", async () => {
  const { root, surfaceRaw } = await writeFlagshipRoot();
  void surfaceRaw;
  try {
    const { exitCode, stdout } = await assess(root, { json: true });
    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout) as {
      schema_version: string;
      assessment_digest: string;
      artifacts: { assessment_json: string; assessment_md: string };
    };
    assert.equal(payload.schema_version, "assess-cli.v1");
    assert.match(payload.assessment_digest, /^[0-9a-f]{64}$/);
    assert.match(payload.artifacts.assessment_json, /assessment\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: a workspace with no evidence at all is a message-first failure", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "riptide-assess-empty-"));
  try {
    const { exitCode, stderr } = await assess(empty, {});
    assert.equal(exitCode, 1);
    assert.match(stderr, /riptide:/);
    // R2.2: a truly-empty root (neither cartography nor correctness evidence)
    // is the only message-first failure; the hint names both shapes' inputs.
    assert.match(stderr, /no assessable evidence was found/);
    assert.match(stderr, /campaign-summary\.json \+ risk-surface\.json/);
    assert.match(stderr, /guided-sim-run\.json/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("assess cli: missing risk-surface.json is a message-first failure", async () => {
  const { root } = await writeFlagshipRoot();
  try {
    await rm(path.join(root, "risk-surface.json"), { force: true });
    const { exitCode, stderr } = await assess(root, {});
    assert.equal(exitCode, 1);
    assert.match(stderr, /risk-surface\.json not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: an unknown --verdict is rejected before ingestion", async () => {
  const { root } = await writeFlagshipRoot();
  try {
    const { exitCode, stderr } = await assess(root, { verdict: "looks_great" });
    assert.equal(exitCode, 1);
    assert.match(stderr, /unknown verdict "looks_great"/);
    assert.match(stderr, /ready_to_send/);
    await assert.rejects(readFile(path.join(root, "assessment.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: accepts a no-surface correctness workspace and writes artifacts (R2.1)", async () => {
  const { root } = await writeCorrectnessWorkspace();
  try {
    const { exitCode, stdout } = await assess(root, {});
    assert.equal(exitCode, 0);

    const model = JSON.parse(await readFile(path.join(root, "assessment.json"), "utf8")) as {
      schema_version: string;
      shape?: string;
      surface: unknown;
      verdict: { value: string };
      correctness?: { guided_sim?: { label: string; flows: number } };
    };
    assert.equal(model.schema_version, "assessment.v1");
    assert.equal(model.shape, "correctness");
    assert.equal(model.surface, null);
    assert.equal(model.verdict.value, "ready_to_send");
    // Deterministic selection: the main run (80 flows) beats the smoke run (20 flows).
    assert.equal(model.correctness?.guided_sim?.label, "defunds-guided-main");
    assert.equal(model.correctness?.guided_sim?.flows, 80);

    const md = await readFile(path.join(root, "assessment.md"), "utf8");
    assert.match(md, /# Protocol assessment —/);
    assert.match(md, /correctness-dominated assessment, so there is no risk-surface heatmap/);
    assert.match(md, /- \*\*Assessment date:\*\* 2026-05-22/);
    // Artifact refs render through the repo/workspace-relative label, never the
    // absolute workspace root (R1).
    const label = path.basename(root);
    assert.match(
      md,
      new RegExp(`${escapeRegExp(label)}\\/sim\\/artifacts\\/defunds-guided-main\\/guided-sim-run\\.json`)
    );
    assert.match(md, new RegExp(`${escapeRegExp(label)}\\/runs\\/deposit-delegated-accounting`));
    assert.match(md, new RegExp(`${escapeRegExp(label)}\\/pack\\/deposit-delegated-accounting`));
    assert.doesNotMatch(md, /\/home\/|\/tmp\//);
    assert.ok(md.endsWith("\n"));

    assert.match(stdout, /correctness shape/);
    assert.match(stdout, /Verdict: ready_to_send \(derived\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: correctness reproduction artifact paths share the assessed workspace root", async () => {
  const { root, cleanupRoot } = await writeCorrectnessWorkspace({
    dotRiptideRoot: true,
    runArtifactsDir: ".riptide/runs/deposit-delegated-accounting"
  });
  try {
    const { exitCode } = await assess(root, {});
    assert.equal(exitCode, 0);

    const md = await readFile(path.join(root, "assessment.md"), "utf8");
    // The `.riptide` workspace root relativizes to the `.riptide` label, and all
    // evidence shares it: clean, runnable from the protocol repo root (R1).
    assert.match(
      md,
      /(?<![\w/])\.riptide\/sim\/artifacts\/defunds-guided-main\/guided-sim-run\.json/
    );
    assert.match(md, /(?<![\w/])\.riptide\/runs\/deposit-delegated-accounting/);
    assert.match(md, /(?<![\w/])\.riptide\/pack\/deposit-delegated-accounting/);
    // No absolute machine path, and no doubled `.riptide/.riptide` segment.
    assert.doesNotMatch(md, /\/home\/|\/tmp\//);
    assert.doesNotMatch(md, new RegExp(escapeRegExp(root)));
    assert.doesNotMatch(md, /\.riptide\/\.riptide\/runs\/deposit-delegated-accounting/);
  } finally {
    await rm(cleanupRoot, { recursive: true, force: true });
  }
});

test("assess cli: correctness assessment is byte-identical across two runs", async () => {
  const { root } = await writeCorrectnessWorkspace();
  try {
    await assess(root, {});
    const json1 = await readFile(path.join(root, "assessment.json"), "utf8");
    const md1 = await readFile(path.join(root, "assessment.md"), "utf8");
    await assess(root, {});
    const json2 = await readFile(path.join(root, "assessment.json"), "utf8");
    const md2 = await readFile(path.join(root, "assessment.md"), "utf8");
    assert.equal(json1, json2);
    assert.equal(md1, md2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: correctness assessment.md is overclaim-grep clean", async () => {
  const { root } = await writeCorrectnessWorkspace();
  try {
    await assess(root, {});
    const md = await readFile(path.join(root, "assessment.md"), "utf8");
    for (const line of md.split("\n")) {
      if (!OVERCLAIM.test(line)) continue;
      const allowed = /\bnot\b/i.test(line) || line.startsWith("- Audit signoff,");
      assert.ok(allowed, `overclaim phrase outside boundary wording: ${JSON.stringify(line)}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assess cli: generated assessment.md is overclaim-grep clean", async () => {
  const { root } = await writeFlagshipRoot();
  try {
    await assess(root, {});
    const md = await readFile(path.join(root, "assessment.md"), "utf8");
    for (const line of md.split("\n")) {
      if (!OVERCLAIM.test(line)) continue;
      const allowed = /\bnot\b/i.test(line) || line.startsWith("- Audit signoff,");
      assert.ok(allowed, `overclaim phrase outside boundary wording: ${JSON.stringify(line)}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
