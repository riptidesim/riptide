import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { discoverTransactionAccounts } from "../state-pack/account-groups.js";
import { canonicalJson, type JsonValue } from "../state-pack/json.js";
import { getTransaction, HttpRpcClient, type RpcClient } from "../state-pack/rpc.js";

export interface CreateTemplateInput {
  name: string;
  tx: string;
  cwd: string;
  rpcUrl: string;
  outputDir?: string;
  rpc?: RpcClient;
}

export interface CreateTemplateResult {
  templatePath: string;
  instructionCount: number;
}

export async function createTransactionTemplate(
  input: CreateTemplateInput
): Promise<CreateTemplateResult> {
  const rpc = input.rpc ?? new HttpRpcClient(input.rpcUrl);
  const tx = await getTransaction(rpc, input.tx);
  const discovery = discoverTransactionAccounts(tx);
  const message = tx.transaction?.message;
  if (!message) throw new Error("transaction response is missing transaction.message");

  const template: JsonValue = {
    version: 0,
    kind: "transaction-template",
    name: input.name,
    source_transaction: input.tx,
    rpc_url: input.rpcUrl,
    slot: tx.slot ?? 0,
    recent_blockhash: message.recentBlockhash ?? "",
    signatures: tx.transaction?.signatures ?? [],
    static_account_keys: discovery.staticAccountKeys,
    loaded_addresses: {
      readonly: discovery.loadedAddresses.readonly,
      writable: discovery.loadedAddresses.writable
    },
    address_lookup_tables: discovery.addressLookupTables,
    instructions: discovery.instructions.map((ix, index) => ({
      index,
      program_id: ix.programId,
      program_id_index: ix.programIdIndex,
      accounts: ix.accounts,
      data: ix.data,
      data_encoding: "base58"
    })),
    mutators: {
      byte_ranges: [],
      signer_replacements: [],
      account_replacements: []
    },
    supports: ["byte_range_mutators", "signer_replacement", "account_replacement"],
    warnings: [
      "template v0 stores a transaction skeleton for simulation actions; exact historical replay is out of scope"
    ]
  };

  const templateDir = path.resolve(input.outputDir ?? path.join(input.cwd, ".riptide", "templates"));
  await mkdir(templateDir, { recursive: true });
  const templatePath = path.join(templateDir, `${sanitizeTemplateName(input.name)}.json`);
  await writeFile(templatePath, canonicalJson(template), "utf8");
  return {
    templatePath,
    instructionCount: discovery.instructions.length
  };
}

function sanitizeTemplateName(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(
      `template name ${JSON.stringify(name)} must match [A-Za-z0-9_.-]+ so it cannot escape .riptide/templates/`
    );
  }
  return name;
}
