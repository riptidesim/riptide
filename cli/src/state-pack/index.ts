import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  discoverTransactionAccounts,
  resolveAccountGroups,
  type AccountGroupName
} from "./account-groups.js";
import { canonicalJson, sha256Hex, type JsonValue } from "./json.js";
import {
  getMultipleAccounts,
  getTransaction,
  HttpRpcClient,
  type RpcAccountInfo,
  type RpcClient
} from "./rpc.js";

export type StatePackMode = "current-from-tx-discovery" | "current-from-explicit-accounts";

export interface CreateStatePackInput {
  name: string;
  cwd: string;
  rpcUrl: string;
  commitment: string;
  tx?: string;
  accounts?: string[];
  outputDir?: string;
  accountGroups?: AccountGroupName[];
  rpc?: RpcClient;
}

export interface CreateStatePackResult {
  packDir: string;
  manifestPath: string;
  accountCount: number;
  warnings: string[];
}

interface DiscoveredAccount {
  pubkey: string;
  source: string;
}

interface AccountFixtureJson {
  [key: string]: JsonValue;
  data_b64: string;
  executable: boolean;
  lamports: number;
  owner: string;
  pubkey: string;
  rent_epoch: number;
}

export async function createStatePack(input: CreateStatePackInput): Promise<CreateStatePackResult> {
  const hasTx = typeof input.tx === "string" && input.tx.length > 0;
  const explicitAccounts = uniqueSorted(input.accounts ?? []);
  if (hasTx === (explicitAccounts.length > 0)) {
    throw new Error("riptide pack-state requires exactly one of --tx or --account");
  }

  const rpc = input.rpc ?? new HttpRpcClient(input.rpcUrl);
  const warnings = [
    "current-state pack: account bytes are fetched from current RPC state; --tx is account discovery, not historical pre-state replay"
  ];
  const mode: StatePackMode = hasTx
    ? "current-from-tx-discovery"
    : "current-from-explicit-accounts";
  const source: Record<string, JsonValue> = {};
  let slot = 0;
  let programIds: string[] = [];
  let addressLookupTables: string[] = [];
  let discovered: DiscoveredAccount[];
  let groups: JsonValue = {};

  if (hasTx) {
    const tx = await getTransaction(rpc, input.tx!);
    const discovery = discoverTransactionAccounts(tx);
    source.tx = input.tx!;
    if (typeof tx.slot === "number") source.slot = tx.slot;
    programIds = uniqueSorted(discovery.instructions.map((ix) => ix.programId));
    addressLookupTables = uniqueSorted(discovery.addressLookupTables);
    discovered = discoveredFromTransaction(discovery);
    const discoveredPubkeys = new Set(discovered.map((entry) => entry.pubkey));
    groups = Object.fromEntries(
      resolveAccountGroups({
        discovery,
        fetchedAccounts: discoveredPubkeys,
        requested: input.accountGroups
      }).map((group) => [group.name, group as unknown as JsonValue])
    );
  } else {
    source.accounts = explicitAccounts;
    discovered = explicitAccounts.map((pubkey) => ({ pubkey, source: "explicit-root" }));
  }

  const fetched = await fetchAccounts(
    rpc,
    discovered.map((entry) => entry.pubkey),
    input.commitment
  );
  slot = fetched.slot;
  source.slot = slot;
  programIds = uniqueSorted([
    ...programIds,
    ...Object.values(fetched.accounts)
      .filter((account): account is RpcAccountInfo => account !== null)
      .map((account) => account.owner)
  ]);
  const sourceByPubkey = new Map(discovered.map((entry) => [entry.pubkey, entry.source]));
  const packDir = path.resolve(
    input.outputDir ?? path.join(input.cwd, ".riptide", "state-packs"),
    sanitizePackName(input.name)
  );
  const accountsDir = path.join(packDir, "accounts");
  await rm(packDir, { recursive: true, force: true });
  await mkdir(accountsDir, { recursive: true });

  const manifestAccounts: Record<string, JsonValue> = {};
  let accountCount = 0;
  for (const pubkey of Object.keys(fetched.accounts).sort()) {
    const account = fetched.accounts[pubkey];
    if (account === null) {
      warnings.push(
        `account ${pubkey} was discovered but RPC returned null; rerun with riptide pack-state --account ${pubkey} --name ${input.name} after the account exists`
      );
      continue;
    }
    const fixture = accountFixture(pubkey, account);
    const fileBytes = canonicalJson(fixture);
    const accountPath = `accounts/${pubkey}.json`;
    await writeFile(path.join(packDir, accountPath), fileBytes, "utf8");
    const dataB64 = fixture.data_b64;
    manifestAccounts[pubkey] = {
      account_pubkey: pubkey,
      data_len: Buffer.from(dataB64, "base64").length,
      data_sha256: sha256Hex(Buffer.from(dataB64, "base64")),
      executable: fixture.executable,
      lamports: fixture.lamports,
      owner: fixture.owner,
      path: accountPath,
      program_id: fixture.owner,
      rent_epoch: fixture.rent_epoch,
      sha256_hash: sha256Hex(fileBytes),
      source: sourceByPubkey.get(pubkey) ?? "discovered"
    };
    accountCount += 1;
  }

  const manifest: JsonValue = {
    version: 1,
    kind: "state-pack",
    name: input.name,
    mode,
    rpc_url: input.rpcUrl,
    commitment: input.commitment,
    slot,
    source: source as JsonValue,
    program_ids: programIds,
    address_lookup_tables: addressLookupTables,
    warnings,
    groups,
    accounts: manifestAccounts
  };
  const manifestPath = path.join(packDir, "manifest.json");
  await writeFile(manifestPath, canonicalJson(manifest), "utf8");
  return { packDir, manifestPath, accountCount, warnings };
}

function discoveredFromTransaction(
  input: ReturnType<typeof discoverTransactionAccounts>
): DiscoveredAccount[] {
  const sourceByPubkey = new Map<string, string>();
  for (const pubkey of input.staticAccountKeys) sourceByPubkey.set(pubkey, "tx-static");
  for (const pubkey of input.loadedAddresses.writable) {
    if (!sourceByPubkey.has(pubkey)) sourceByPubkey.set(pubkey, "tx-loaded-writable");
  }
  for (const pubkey of input.loadedAddresses.readonly) {
    if (!sourceByPubkey.has(pubkey)) sourceByPubkey.set(pubkey, "tx-loaded-readonly");
  }
  for (const pubkey of input.addressLookupTables) {
    if (!sourceByPubkey.has(pubkey)) sourceByPubkey.set(pubkey, "address-lookup-table");
  }
  return [...sourceByPubkey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pubkey, source]) => ({ pubkey, source }));
}

async function fetchAccounts(
  rpc: RpcClient,
  pubkeys: string[],
  commitment: string
): Promise<{ slot: number; accounts: Record<string, RpcAccountInfo | null> }> {
  const accounts: Record<string, RpcAccountInfo | null> = {};
  let slot = 0;
  for (let i = 0; i < pubkeys.length; i += 100) {
    const chunk = pubkeys.slice(i, i + 100);
    const response = await getMultipleAccounts(rpc, chunk, commitment);
    slot = Math.max(slot, response.slot);
    response.accounts.forEach((account, idx) => {
      accounts[chunk[idx]!] = account;
    });
  }
  return { slot, accounts };
}

function accountFixture(pubkey: string, account: RpcAccountInfo): AccountFixtureJson {
  const data = account.data;
  const dataB64 = Array.isArray(data) ? data[0] : data;
  const rentEpoch = account.rentEpoch ?? account.rent_epoch ?? 0;
  return {
    data_b64: dataB64,
    executable: account.executable,
    lamports: normalizeU64(account.lamports),
    owner: account.owner,
    pubkey,
    rent_epoch: normalizeU64(rentEpoch)
  };
}

function normalizeU64(value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return 0;
}

function sanitizePackName(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(
      `state pack name ${JSON.stringify(name)} must match [A-Za-z0-9_.-]+ so it cannot escape .riptide/state-packs/`
    );
  }
  return name;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}
