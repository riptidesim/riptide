import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import chalk from "chalk";
import { Command } from "commander";

import { generateSim, type SimGenerateOptions } from "../sim/generate.js";
import { lintSimManifest, renderSimManifestLintReport } from "../sim/manifest.js";

const dim = (value: string) => chalk.hex("#A8A8A8")(value);

export function createSimCommand(): Command {
  const command = new Command("sim").description(
    "Generate, refresh, and run guided Rust simulations"
  );

  command
    .command("generate")
    .description("Generate a project-owned Rust simulation crate")
    .requiredOption("--adapter <path-or-name>", "Adapter TOML to generate against")
    .option("--dir <path>", "Simulation crate directory", ".riptide/sim")
    .option(
      "--force-generated",
      "Overwrite user-owned flows.rs, invariants.rs, and services/* files too",
      false
    )
    .action(async (options: SimGenerateOptions) => {
      try {
        const result = await generateSim(process.cwd(), options);
        process.stderr.write(
          chalk.bold(`riptide sim: generated guided Rust simulation at ${chalk.cyan(result.dir)}\n`)
        );
        process.stderr.write(dim(`  adapter ${result.adapterPath}\n`));
        process.stderr.write(dim(`  idl ${result.idlPath}\n`));
        process.stderr.write(dim(`  manifest ${result.manifestPath}\n`));
        process.stderr.write(dim(`  bootstrap ${result.bootstrapManifestPath}\n`));
      } catch (err) {
        process.stderr.write(chalk.red(`riptide sim: ${errMessage(err)}\n`));
        process.exitCode = 2;
      }
    });

  command
    .command("refresh")
    .description("Regenerate typed IDL builders and account storage skeletons")
    .requiredOption("--adapter <path-or-name>", "Adapter TOML to refresh against")
    .option("--dir <path>", "Simulation crate directory", ".riptide/sim")
    .action(async (options: SimGenerateOptions) => {
      try {
        const result = await generateSim(process.cwd(), { ...options, regenTypesOnly: true });
        process.stderr.write(
          chalk.bold(`riptide sim: refreshed generated Rust files in ${chalk.cyan(result.dir)}\n`)
        );
      } catch (err) {
        process.stderr.write(chalk.red(`riptide sim: ${errMessage(err)}\n`));
        process.exitCode = 2;
      }
    });

  command
    .command("run")
    .description("Run a generated guided simulation crate")
    .argument("[path]", "Simulation crate path", ".riptide/sim")
    .option("--iterations <n>", "Iterations to run")
    .option("--flows <n>", "Flow calls per iteration")
    .option("--seed <hex>", "Deterministic seed as hex")
    .option("--out <dir>", "Write guided-sim JSON artifacts to a directory")
    .action(async (simPath: string, options: RunOptions) => {
      process.exitCode = await runCargoSim(simPath, options);
    });

  command
    .command("fork")
    .description("Fetch or reuse a guided-sim account snapshot cache")
    .requiredOption("--address <pubkey>", "Account address to snapshot")
    .option("--cluster <cluster-or-rpc>", "Cluster alias or custom RPC URL", "mainnet")
    .requiredOption("--out <path>", "Snapshot JSON output path")
    .option("--overwrite", "Refresh an existing snapshot instead of reusing it", false)
    .action(async (options: ForkOptions) => {
      process.exitCode = await runSimFork(options);
    });

  command
    .command("lint")
    .description("Validate a guided simulation Riptide.toml manifest")
    .argument("[path]", "Simulation crate directory or Riptide.toml path", ".riptide/sim")
    .action(async (simPath: string) => {
      process.exitCode = await runSimLint(simPath);
    });

  command
    .command("debug")
    .description("Run one seed with verbose labelled transaction logging")
    .argument("[path]", "Simulation crate path", ".riptide/sim")
    .requiredOption("--seed <hex>", "Deterministic seed as hex")
    .action(async (simPath: string, options: RunOptions) => {
      process.exitCode = await runCargoSim(simPath, {
        ...options,
        iterations: "1",
        debug: true
      });
    });

  return command;
}

export async function runSimLint(simPath: string): Promise<number> {
  const report = await lintSimManifest(simPath);
  process.stdout.write(renderSimManifestLintReport(report));
  return report.exitCode;
}

interface RunOptions {
  iterations?: string;
  flows?: string;
  seed?: string;
  debug?: boolean;
  out?: string;
}

interface ForkOptions {
  address: string;
  cluster: string;
  out: string;
  overwrite?: boolean;
}

function runCargoSim(simPath: string, options: RunOptions): Promise<number> {
  const cwd = path.resolve(process.cwd(), simPath);
  const args = ["run", "--release", "--quiet", "--"];
  if (options.iterations) args.push("--iterations", options.iterations);
  if (options.flows) args.push("--flows", options.flows);
  if (options.seed) args.push("--seed", options.seed);
  if (options.debug) args.push("--debug");
  if (options.out) args.push("--out", path.resolve(process.cwd(), options.out));

  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env }
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

export async function runSimFork(options: ForkOptions): Promise<number> {
  const outPath = path.resolve(process.cwd(), options.out);
  try {
    if (existsSync(outPath) && options.overwrite !== true) {
      const raw = await readFile(outPath, "utf8");
      validateReusableSnapshot(raw, options.address, outPath);
      process.stdout.write(`riptide sim fork: reused cached snapshot ${outPath}\n`);
      return 0;
    }

    const account = await fetchAccountSnapshot(options.address, options.cluster);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(
      outPath,
      JSON.stringify(snapshotJson(options.address, options.cluster, outPath, account), null, 2),
      "utf8"
    );
    process.stdout.write(
      `riptide sim fork: wrote ${options.address} from ${options.cluster} to ${outPath}\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(chalk.red(`riptide sim fork: ${errMessage(err)}\n`));
    return 2;
  }
}

function validateReusableSnapshot(raw: string, expectedAddress: string, filename: string): void {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`cached snapshot ${filename} must be a JSON object`);
  }
  const declared = typeof parsed.pubkey === "string" ? parsed.pubkey : undefined;
  const provenanceAddress = isRecord(parsed.provenance) && typeof parsed.provenance.address === "string"
    ? parsed.provenance.address
    : undefined;
  const cachedAddress = declared ?? provenanceAddress;
  if (cachedAddress === undefined) {
    throw new Error(
      `cached snapshot ${filename} is missing pubkey provenance; pass --overwrite to refresh it`
    );
  }
  if (cachedAddress !== expectedAddress) {
    throw new Error(
      `cached snapshot ${filename} pubkey ${cachedAddress} does not match requested address ${expectedAddress}; pass --overwrite to refresh it`
    );
  }

  const account = snapshotAccountValue(parsed);
  if (!isRecord(account)) {
    throw new Error(`cached snapshot ${filename} is missing account data`);
  }
  if (typeof account.owner !== "string") {
    throw new Error(`cached snapshot ${filename} is missing account.owner`);
  }
  if (typeof account.lamports !== "number" || !Number.isSafeInteger(account.lamports) || account.lamports < 0) {
    throw new Error(`cached snapshot ${filename} has invalid account.lamports`);
  }
  validateSnapshotData(account.data, filename);
}

function snapshotAccountValue(parsed: Record<string, unknown>): unknown {
  if (isRecord(parsed.account)) return parsed.account;
  if (isRecord(parsed.result)) {
    const value = parsed.result.value;
    if (isRecord(value)) return value;
  }
  return parsed;
}

function validateSnapshotData(data: unknown, filename: string): void {
  const encoded = typeof data === "string"
    ? data
    : Array.isArray(data) && typeof data[0] === "string"
      ? data[0]
      : undefined;
  if (encoded === undefined) {
    throw new Error(`cached snapshot ${filename} data must be base64 or [base64, encoding]`);
  }
  const encoding = Array.isArray(data) && typeof data[1] === "string"
    ? data[1].toLowerCase()
    : "base64";
  if (encoding !== "base64") {
    throw new Error(`cached snapshot ${filename} uses unsupported data encoding ${encoding}`);
  }
  if (!isStrictBase64(encoded)) {
    throw new Error(`cached snapshot ${filename} data is not valid standard base64`);
  }
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RpcAccount {
  contextSlot?: number;
  lamports: number;
  data: [string, string];
  owner: string;
  executable: boolean;
  rentEpoch: number;
}

async function fetchAccountSnapshot(address: string, cluster: string): Promise<RpcAccount> {
  const url = clusterUrl(cluster);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64", commitment: "confirmed" }]
    })
  });
  if (!response.ok) {
    throw new Error(`RPC ${url} returned HTTP ${response.status}`);
  }
  const body = await response.json() as {
    error?: unknown;
    result?: { context?: { slot?: number }; value?: Omit<RpcAccount, "contextSlot"> | null };
  };
  if (body.error) throw new Error(`RPC ${url} returned ${JSON.stringify(body.error)}`);
  const value = body.result?.value;
  if (!value) throw new Error(`account ${address} does not exist on ${url}`);
  return { ...value, contextSlot: body.result?.context?.slot };
}

function snapshotJson(address: string, cluster: string, filename: string, account: RpcAccount): unknown {
  const data = account.data[0] ?? "";
  return {
    pubkey: address,
    account: {
      lamports: account.lamports,
      data: account.data,
      owner: account.owner,
      executable: account.executable,
      rentEpoch: account.rentEpoch
    },
    provenance: {
      address,
      cluster,
      fetched_slot: account.contextSlot ?? null,
      owner: account.owner,
      executable: account.executable,
      data_hash: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
      filename
    }
  };
}

function clusterUrl(cluster: string): string {
  switch (cluster) {
    case "m":
    case "mainnet":
    case "mainnet-beta":
      return "https://api.mainnet-beta.solana.com";
    case "d":
    case "devnet":
      return "https://api.devnet.solana.com";
    case "t":
    case "testnet":
      return "https://api.testnet.solana.com";
    default:
      return cluster;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
