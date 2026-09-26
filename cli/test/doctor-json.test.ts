// `riptide doctor --json` — the command envelope on success and the
// error shape (code, message, next) on failure.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDoctor, type DoctorCommandDeps } from "../src/commands/doctor.js";
import { buildDoctorReport } from "../src/doctor/index.js";

const HEALTHY_VERSIONS: Record<string, string | undefined> = {
  node: "v24.11.1",
  npm: "11.6.2",
  rustc: "rustc 1.91.1 (abc123 2026-04-01)",
  cargo: "cargo 1.91.1 (def456 2026-04-01)",
  solana: "solana-cli 3.0.13 (channel: stable)",
  "cargo-build-sbf": "solana-cargo-build-sbf 3.0.13",
};

const SIMPLE_IDL = JSON.stringify({
  version: "0.1.0",
  name: "simple",
  instructions: [
    {
      name: "deposit",
      accounts: [{ name: "owner", signer: true }, { name: "pool", writable: true }],
      args: [{ name: "amount", type: "u64" }],
    },
  ],
  accounts: [{ name: "pool", fields: [{ name: "total_deposits", type: "u64" }] }],
});

const CLEAN_ADAPTER = `protocol = "generic"
program_so = "./simple.so"
idl_path = "../../idls/simple.json"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "pool.total_deposits"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.total_deposits" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "idls/simple.json"
generator = "hand-authored"
`;

interface EnvelopeShape {
  schema_version: string;
  command: string;
  ok: boolean;
  data?: { verdict: string; exit_code: number; environment: { id: string; status: string }[] };
  error?: { code: string; message: string; next: string };
}

/** A user repo whose Workspace holds one clean adapter. */
async function workspaceWithCleanAdapter(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-doctor-json-"));
  await mkdir(path.join(cwd, "idls"), { recursive: true });
  await writeFile(path.join(cwd, "idls", "simple.json"), SIMPLE_IDL, "utf8");
  const adapters = path.join(cwd, ".riptide", "adapters");
  await mkdir(adapters, { recursive: true });
  await writeFile(path.join(adapters, "simple.toml"), CLEAN_ADAPTER, "utf8");
  await writeFile(path.join(adapters, "simple.so"), Buffer.alloc(0));
  return cwd;
}

async function doctorJson(
  cwd: string,
  deps: Partial<DoctorCommandDeps> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; envelope: EnvelopeShape }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runDoctor(
    { json: true },
    {
      cwd,
      stdoutWrite: (chunk) => {
        stdout += chunk;
      },
      stderrWrite: (chunk) => {
        stderr += chunk;
      },
      ...deps,
    }
  );
  return { exitCode, stdout, stderr, envelope: JSON.parse(stdout) as EnvelopeShape };
}

function probing(versions: Record<string, string | undefined>): DoctorCommandDeps["buildReport"] {
  return (input) =>
    buildDoctorReport({
      ...input,
      probeTool: async (spec: { id: string }) => {
        const version = versions[spec.id];
        return version ? { version } : {};
      },
    });
}

test("doctor --json: a passing report is one success envelope on stdout", async () => {
  const cwd = await workspaceWithCleanAdapter();
  const { exitCode, stderr, envelope } = await doctorJson(cwd, {
    buildReport: probing(HEALTHY_VERSIONS),
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.equal(envelope.schema_version, "riptide-command.v1");
  assert.equal(envelope.command, "doctor");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.error, undefined);
  assert.equal(envelope.data?.verdict, "pass");
  assert.equal(envelope.data?.exit_code, 0);
  assert.ok(envelope.data?.environment.some((check) => check.id === "cargo-build-sbf"));
});

test("doctor --json: a missing prerequisite is the error shape with a next action", async () => {
  const cwd = await workspaceWithCleanAdapter();
  const { exitCode, stderr, envelope } = await doctorJson(cwd, {
    buildReport: probing({ ...HEALTHY_VERSIONS, "cargo-build-sbf": undefined }),
  });

  assert.equal(exitCode, 2);
  assert.equal(stderr, "");
  assert.equal(envelope.command, "doctor");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "doctor_checks_failed");
  assert.match(envelope.error?.message ?? "", /cargo-build-sbf/);
  assert.match(envelope.error?.next ?? "", /cargo-build-sbf/);
  assert.equal(envelope.data?.verdict, "fail");
});

test("doctor --json: a report that cannot be assembled is the error shape", async () => {
  const cwd = await workspaceWithCleanAdapter();
  const { exitCode, stderr, envelope } = await doctorJson(cwd, {
    buildReport: async () => {
      throw new Error("adapter directory unreadable");
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(stderr, "");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "doctor_report_failed");
  assert.match(envelope.error?.message ?? "", /adapter directory unreadable/);
  assert.ok((envelope.error?.next ?? "").length > 0);
  assert.equal(envelope.data, undefined);
});
