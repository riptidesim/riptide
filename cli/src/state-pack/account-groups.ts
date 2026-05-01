import type { RpcCompiledInstruction, RpcLoadedAddresses, RpcTransaction } from "./rpc.js";

export type AccountGroupName = "tick_arrays" | "vaults" | "oracle_set" | "lookup_tables";

export interface AccountGroupResolution {
  name: AccountGroupName;
  resolver: string;
  accounts: string[];
  missing: Array<{
    account: string;
    expected_resolver: string;
    command: string;
  }>;
}

export interface TxAccountDiscovery {
  staticAccountKeys: string[];
  loadedAddresses: Required<RpcLoadedAddresses>;
  addressLookupTables: string[];
  instructions: Array<{
    programId: string;
    programIdIndex: number;
    accounts: string[];
    data: string;
  }>;
}

export function discoverTransactionAccounts(tx: RpcTransaction): TxAccountDiscovery {
  const message = tx.transaction?.message;
  if (!message) {
    throw new Error("transaction response is missing transaction.message");
  }
  const staticAccountKeys = (message.accountKeys ?? []).map(accountKeyToString);
  const loadedAddresses = {
    writable: [...(tx.meta?.loadedAddresses?.writable ?? [])],
    readonly: [...(tx.meta?.loadedAddresses?.readonly ?? [])]
  };
  const resolvedKeys = [
    ...staticAccountKeys,
    ...loadedAddresses.writable,
    ...loadedAddresses.readonly
  ];
  const instructions = (message.instructions ?? []).map((ix) =>
    resolveInstructionAccounts(ix, resolvedKeys)
  );
  const addressLookupTables = (message.addressTableLookups ?? [])
    .map((lookup) => lookup.accountKey)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return {
    staticAccountKeys,
    loadedAddresses,
    addressLookupTables,
    instructions
  };
}

export function resolveAccountGroups(input: {
  discovery: TxAccountDiscovery;
  fetchedAccounts: Set<string>;
  requested?: AccountGroupName[];
}): AccountGroupResolution[] {
  const requested = input.requested ?? inferredGroups(input.discovery);
  const out: AccountGroupResolution[] = [];
  for (const name of requested) {
    if (name === "lookup_tables") {
      out.push({
        name,
        resolver: "address_lookup_tables",
        accounts: input.discovery.addressLookupTables,
        missing: missingDiagnostics(name, input.discovery.addressLookupTables, input.fetchedAccounts)
      });
      continue;
    }
    out.push(resolveOrcaWhirlpoolGroup(name, input.discovery, input.fetchedAccounts));
  }
  return out;
}

function inferredGroups(discovery: TxAccountDiscovery): AccountGroupName[] {
  const groups: AccountGroupName[] = [];
  if (discovery.addressLookupTables.length > 0) groups.push("lookup_tables");
  if (discovery.instructions.some((ix) => isLikelyWhirlpoolProgram(ix.programId))) {
    groups.push("vaults", "tick_arrays", "oracle_set");
  }
  return groups;
}

function resolveOrcaWhirlpoolGroup(
  name: AccountGroupName,
  discovery: TxAccountDiscovery,
  fetchedAccounts: Set<string>
): AccountGroupResolution {
  const candidates = discovery.instructions.filter((ix) => isLikelyWhirlpoolProgram(ix.programId));
  const accounts = new Set<string>();
  for (const ix of candidates) {
    for (const account of orcaAccountsForGroup(name, ix.accounts)) {
      accounts.add(account);
    }
  }
  const sorted = [...accounts].sort();
  return {
    name,
    resolver: "orca_whirlpool_v0",
    accounts: sorted,
    missing: missingDiagnostics(name, sorted, fetchedAccounts)
  };
}

function orcaAccountsForGroup(name: AccountGroupName, accounts: string[]): string[] {
  // Orca Whirlpool swap-style instructions commonly carry:
  // token program, authority, whirlpool, owner ATA A/B, vault A/B,
  // tick_array_0/1/2, oracle. The resolver is deliberately diagnostic:
  // it discovers closure candidates and reports missing state, but it
  // does not pretend to replay historical instruction semantics.
  if (name === "vaults") return accounts.slice(5, 7);
  if (name === "tick_arrays") return accounts.slice(7, 10);
  if (name === "oracle_set") return accounts.slice(10, 11);
  return [];
}

function missingDiagnostics(
  group: AccountGroupName,
  accounts: string[],
  fetchedAccounts: Set<string>
): AccountGroupResolution["missing"] {
  return accounts
    .filter((account) => !fetchedAccounts.has(account))
    .map((account) => ({
      account,
      expected_resolver: group === "lookup_tables" ? "address_lookup_tables" : "orca_whirlpool_v0",
      command: `riptide pack-state --account ${account} --name <pack>`
    }));
}

function resolveInstructionAccounts(
  ix: RpcCompiledInstruction,
  resolvedKeys: string[]
): TxAccountDiscovery["instructions"][number] {
  const programId = resolvedKeys[ix.programIdIndex] ?? `program-index:${ix.programIdIndex}`;
  return {
    programId,
    programIdIndex: ix.programIdIndex,
    accounts: (ix.accounts ?? []).map((idx) => resolvedKeys[idx] ?? `account-index:${idx}`),
    data: ix.data
  };
}

function accountKeyToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.pubkey === "string") return record.pubkey;
  }
  throw new Error(`transaction account key is not a string/pubkey object: ${JSON.stringify(value)}`);
}

function isLikelyWhirlpoolProgram(programId: string): boolean {
  return programId.startsWith("whirL");
}
