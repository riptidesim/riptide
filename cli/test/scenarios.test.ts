// `riptide scenarios --validate` harness tests.
//
// Covers the three exit paths of the one-tick boot validator:
// - exit 2 when the scenario directory is missing
// - exit 2 when run-config.json parses but fails schema
// - exit 2 when manifest.json is missing
// - exit 2 when policies.json persona_id set doesn't match run-config.personas
// - exit 1 when the engine spawn reports a non-zero code
// - exit 1 when the engine exits 0 but produces no timeseries
// - exit 0 on a stubbed clean one-tick boot

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, symlink, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScenariosValidate } from "../src/commands/scenarios.js";
import { validateScenario, type SpawnEngine } from "../src/scenarios/validate.js";

const VALID_RUN_CONFIG = {
  agents: 2,
  ticks: 20,
  scenario: "baseline",
  seed: 42,
  personas: ["test-whale", "test-whale"],
  validator_url: "http://localhost:8899",
  output_path: "fixtures/scenarios/test-adapter/test-slug"
};

const BROKEN_RUN_CONFIG = {
  agents: 0,
  ticks: -5,
  scenario: "",
  seed: 42,
  personas: ["nope"],
  validator_url: "not-a-url",
  output_path: ""
};

const VALID_POLICIES = [
  {
    persona_id: "test-whale",
    persona_label: "Test Whale",
    risk_tolerance: 0.9,
    action_weights: { deposit: 0.3, borrow: 1.0 },
    triggers: [],
    position_sizing: { strategy: "fixed", params: { amount: 800 } },
    max_exposure: 0.95
  }
];

const VALID_MANIFEST = {
  adapter: "fixtures/adapters/solend-fork.toml",
  slug: "test-slug",
  failure_mode: "whale_concentration",
  rationale:
    "adapter has protocol=lending with all five lending actions and no per-account borrow cap → concentration plausible"
};

async function writeScenario(
  contents: {
    runConfig?: unknown;
    policies?: unknown;
    manifest?: unknown;
    skipManifest?: boolean;
  }
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-scenarios-test-"));
  if (contents.runConfig !== undefined) {
    await writeFile(
      path.join(dir, "run-config.json"),
      JSON.stringify(contents.runConfig, null, 2),
      "utf8"
    );
  }
  if (contents.policies !== undefined) {
    await writeFile(
      path.join(dir, "policies.json"),
      JSON.stringify(contents.policies, null, 2),
      "utf8"
    );
  }
  if (contents.manifest !== undefined && !contents.skipManifest) {
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify(contents.manifest, null, 2),
      "utf8"
    );
  }
  return dir;
}

function findMonorepoRoot(): string {
  // Tests run out of dist/test — walk up until we hit the monorepo
  // (the directory containing `fixtures/adapters/solend-fork.toml`).
  let here = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.resolve(here, "fixtures/adapters/solend-fork.toml"))) {
      return here;
    }
    const parent = path.resolve(here, "..");
    if (parent === here) break;
    here = parent;
  }
  return path.resolve(process.cwd());
}

const MONOREPO_ROOT = findMonorepoRoot();

const STUB_ENGINE_CLEAN_BOOT: SpawnEngine = async (options) => {
  const { writeFile } = await import("node:fs/promises");
  // Write a minimal output file with one tick so the boot-test check passes.
  await writeFile(
    options.outputPath,
    JSON.stringify(
      {
        run_config: {},
        total_ticks: 1,
        timeseries: [{ tick: 0, active_agents: 2 }],
        events: [],
        agents: [],
        summary: { agents_active: 2, agents_liquidated: 0, agents_depleted: 0 }
      },
      null,
      2
    ),
    "utf8"
  );
  return { code: 0, stderr: "" };
};

const STUB_ENGINE_FAILED_BOOT: SpawnEngine = async () => ({
  code: 137,
  stderr: "fake engine: blew up on tick 0"
});

const STUB_ENGINE_SILENT_PASS: SpawnEngine = async (options) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    options.outputPath,
    JSON.stringify({ run_config: {}, timeseries: [], events: [] }),
    "utf8"
  );
  return { code: 0, stderr: "" };
};

// Regression: engine exits 0 and writes total_ticks: 1 but an empty
// timeseries. Prior implementation accepted this as a boot-pass; fix
// requires a concrete timeseries entry with a tick field.
const STUB_ENGINE_TOTAL_TICKS_LIE: SpawnEngine = async (options) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    options.outputPath,
    JSON.stringify({
      run_config: {},
      total_ticks: 1,
      timeseries: [],
      events: [],
      summary: {}
    }),
    "utf8"
  );
  return { code: 0, stderr: "" };
};

// Cheat: engine spawn should never happen in the generic-bad-persona
// test — we expect schema-level rejection before spawn — so make this
// stub throw to prove we never reached it.
const STUB_ENGINE_MUST_NOT_SPAWN: SpawnEngine = async () => {
  throw new Error(
    "engine spawn was reached but the validator should have exited 2 on schema check"
  );
};

test("scenarios --validate: missing scenario path → exit 2", async () => {
  const exit = await runScenariosValidate(
    { path: "/nonexistent/scenario/dir" },
    {
      engineBinary: "/tmp/fake-engine",
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_CLEAN_BOOT
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: broken run-config (Zod fails) → exit 2", async () => {
  const dir = await writeScenario({
    runConfig: BROKEN_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: VALID_MANIFEST
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: "/tmp/fake-engine",
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_CLEAN_BOOT
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: missing manifest → exit 2", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    skipManifest: true
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: "/tmp/fake-engine",
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_CLEAN_BOOT
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: run-config references unknown persona → exit 2", async () => {
  const mismatched = { ...VALID_RUN_CONFIG, personas: ["ghost", "ghost"] };
  const dir = await writeScenario({
    runConfig: mismatched,
    policies: VALID_POLICIES,
    manifest: VALID_MANIFEST
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: "/tmp/fake-engine",
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_CLEAN_BOOT
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: engine exits non-zero → exit 1", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: VALID_MANIFEST
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath, // any existing binary — we're stubbing
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_FAILED_BOOT
    }
  );
  assert.equal(exit, 1);
});

test("scenarios --validate: engine exits 0 but no timeseries → exit 1", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: VALID_MANIFEST
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_SILENT_PASS
    }
  );
  assert.equal(exit, 1);
});

test("scenarios --validate: clean one-tick boot → exit 0", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: VALID_MANIFEST
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_CLEAN_BOOT
    }
  );
  assert.equal(exit, 0);
});

// Unit test on the validator module directly — ensures the manifest
// path resolution works relative to the monorepo root.
test("validateScenario: resolves relative adapter path from monorepo root", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: { ...VALID_MANIFEST, adapter: "fixtures/adapters/solend-fork.toml" }
  });
  const result = await validateScenario(
    {
      scenarioPath: dir,
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT
    },
    STUB_ENGINE_CLEAN_BOOT
  );
  assert.equal(result.exit, 0, result.reason);
});

test("scenarios --validate: total_ticks >= 1 with empty timeseries → exit 1 (no silent false-pass)", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: VALID_MANIFEST
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_TOTAL_TICKS_LIE
    }
  );
  assert.equal(exit, 1);
});

test("scenarios --validate: generic adapter with empty policies + unknown persona id → exit 2 (not exit 1)", async () => {
  // Generic adapter path: policies.json is []; persona catalog comes
  // from the adapter TOML. A run-config.personas entry that doesn't
  // match any [personas.*] key in the adapter must be caught at the
  // schema check and never reach the engine.
  const dir = await writeScenario({
    runConfig: {
      ...VALID_RUN_CONFIG,
      personas: ["ghost", "ghost"]
    },
    policies: [],
    manifest: {
      ...VALID_MANIFEST,
      adapter: "fixtures/adapters/resource-grinder.toml"
    }
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_MUST_NOT_SPAWN
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: generic adapter with empty policies + valid persona id → exit 0", async () => {
  const dir = await writeScenario({
    runConfig: {
      ...VALID_RUN_CONFIG,
      personas: ["grinder", "botter"]
    },
    policies: [],
    manifest: {
      ...VALID_MANIFEST,
      adapter: "fixtures/adapters/resource-grinder.toml"
    }
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_CLEAN_BOOT
    }
  );
  assert.equal(exit, 0);
});

test("scenarios --validate: absolute manifest.adapter outside monorepo → exit 2, engine never spawned", async () => {
  // Regression: a hostile manifest could previously point at any
  // file on disk (e.g. /etc/hosts). The validator must reject
  // anything that doesn't resolve under monorepoRoot and must do so
  // before reading the file or spawning the engine.
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: { ...VALID_MANIFEST, adapter: "/etc/hosts" }
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_MUST_NOT_SPAWN
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: relative manifest.adapter ..-escaping monorepo → exit 2", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: {
      ...VALID_MANIFEST,
      adapter: "../../../../../../../../etc/hosts"
    }
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_MUST_NOT_SPAWN
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: sibling-root sharing a prefix of monorepoRoot → exit 2", async () => {
  // Containment must be based on path segments, not string prefix:
  // if monorepoRoot is `/foo/riptide`, a manifest pointing at
  // `/foo/riptide-evil/adapter.toml` must be rejected.
  const siblingRoot = MONOREPO_ROOT + "-evil";
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: {
      ...VALID_MANIFEST,
      adapter: path.join(siblingRoot, "adapter.toml")
    }
  });
  const exit = await runScenariosValidate(
    { path: dir },
    {
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT,
      spawnEngineImpl: STUB_ENGINE_MUST_NOT_SPAWN
    }
  );
  assert.equal(exit, 2);
});

test("scenarios --validate: symlinked adapter escaping via /etc/hosts → exit 2, engine never spawned", async () => {
  // Regression: path containment must canonicalize through realpath.
  // A lexical-only check would accept a repo-internal path that is
  // really a symlink walking out of the repo.
  const linkName = `s4p2-test-link-${process.pid}-${Date.now()}.toml`;
  const linkPath = path.join(MONOREPO_ROOT, "target", linkName);
  await symlink("/etc/hosts", linkPath);
  try {
    const dir = await writeScenario({
      runConfig: VALID_RUN_CONFIG,
      policies: VALID_POLICIES,
      manifest: {
        ...VALID_MANIFEST,
        adapter: path.join("target", linkName)
      }
    });
    const exit = await runScenariosValidate(
      { path: dir },
      {
        engineBinary: process.execPath,
        monorepoRoot: MONOREPO_ROOT,
        spawnEngineImpl: STUB_ENGINE_MUST_NOT_SPAWN
      }
    );
    assert.equal(exit, 2);
  } finally {
    await unlink(linkPath).catch(() => {});
  }
});

test("scenarios --validate: symlinked adapter pointing at a valid-but-out-of-repo TOML → exit 2", async () => {
  // The more dangerous variant: the symlink target is a genuine
  // adapter TOML sitting outside the repo. Lexical check passes,
  // file exists, adapter TOML parses — but it still must be
  // rejected because the content originates outside monorepoRoot.
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "riptide-scenarios-outside-"));
  const outsideAdapter = path.join(outsideDir, "resource-grinder.toml");
  const outsideToml = `protocol = "generic"
program_so = "irrelevant.so"
idl_path = "irrelevant.json"

[accounts.player]
kind = "agent"
space = 48

[instructions]
mine = { action = "mine", amount = "amount" }

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
label = "Mine"
takes = ["amount"]

[observations]
"player.gold" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { mine = 1.0 }
triggers = []
`;
  await writeFile(outsideAdapter, outsideToml, "utf8");

  const linkName = `s4p2-test-link-valid-${process.pid}-${Date.now()}.toml`;
  const linkPath = path.join(MONOREPO_ROOT, "target", linkName);
  await symlink(outsideAdapter, linkPath);
  try {
    const dir = await writeScenario({
      runConfig: { ...VALID_RUN_CONFIG, personas: ["grinder", "grinder"] },
      policies: [],
      manifest: {
        ...VALID_MANIFEST,
        adapter: path.join("target", linkName)
      }
    });
    const exit = await runScenariosValidate(
      { path: dir },
      {
        engineBinary: process.execPath,
        monorepoRoot: MONOREPO_ROOT,
        spawnEngineImpl: STUB_ENGINE_MUST_NOT_SPAWN
      }
    );
    assert.equal(exit, 2);
  } finally {
    await unlink(linkPath).catch(() => {});
  }
});

test("validateScenario: missing adapter referenced by manifest → exit 2", async () => {
  const dir = await writeScenario({
    runConfig: VALID_RUN_CONFIG,
    policies: VALID_POLICIES,
    manifest: { ...VALID_MANIFEST, adapter: "fixtures/adapters/does-not-exist.toml" }
  });
  const result = await validateScenario(
    {
      scenarioPath: dir,
      engineBinary: process.execPath,
      monorepoRoot: MONOREPO_ROOT
    },
    STUB_ENGINE_CLEAN_BOOT
  );
  assert.equal(result.exit, 2);
});
