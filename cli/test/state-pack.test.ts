import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { discoverTransactionAccounts, resolveAccountGroups } from "../src/state-pack/account-groups.js";
import { createStatePack } from "../src/state-pack/index.js";
import type { RpcClient, RpcResponse, RpcTransaction } from "../src/state-pack/rpc.js";
import { createTransactionTemplate } from "../src/template/index.js";

const PUBKEY = "So11111111111111111111111111111111111111112";

class FakeRpc implements RpcClient {
  constructor(private readonly replies: Record<string, unknown>) {}

  async call<T>(method: string): Promise<RpcResponse<T>> {
    if (!(method in this.replies)) {
      throw new Error(`unexpected RPC method ${method}`);
    }
    return this.replies[method] as RpcResponse<T>;
  }
}

test("createStatePack writes hash-checked current account fixtures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-pack-state-"));
  const rpc = new FakeRpc({
    getMultipleAccounts: {
      context: { slot: 99 },
      value: [
        {
          data: ["UklQVElERQ==", "base64"],
          executable: false,
          lamports: 123,
          owner: "11111111111111111111111111111111",
          rentEpoch: 0
        }
      ]
    }
  });

  const result = await createStatePack({
    name: "unit",
    cwd: root,
    rpcUrl: "http://rpc.invalid",
    commitment: "confirmed",
    accounts: [PUBKEY],
    rpc
  });

  assert.equal(result.accountCount, 1);
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as {
    mode: string;
    slot: number;
    accounts: Record<string, { sha256_hash: string; path: string }>;
  };
  assert.equal(manifest.mode, "current-from-explicit-accounts");
  assert.equal(manifest.slot, 99);
  assert.match(manifest.accounts[PUBKEY]!.sha256_hash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.accounts[PUBKEY]!.path, `accounts/${PUBKEY}.json`);
});

test("Orca account group resolver maps swap-style vault, tick array, oracle groups", () => {
  const tx = fakeWhirlpoolTx();
  const discovery = discoverTransactionAccounts(tx);
  const groups = resolveAccountGroups({
    discovery,
    fetchedAccounts: new Set(discovery.staticAccountKeys)
  });

  const tickArrays = groups.find((group) => group.name === "tick_arrays");
  const vaults = groups.find((group) => group.name === "vaults");
  const oracleSet = groups.find((group) => group.name === "oracle_set");
  assert.deepEqual(vaults?.accounts, ["VaultA1111111111111111111111111111111111", "VaultB1111111111111111111111111111111111"]);
  assert.deepEqual(tickArrays?.accounts, [
    "TickA1111111111111111111111111111111111",
    "TickB1111111111111111111111111111111111",
    "TickC1111111111111111111111111111111111"
  ]);
  assert.deepEqual(oracleSet?.accounts, ["Oracle111111111111111111111111111111111"]);
});

test("createTransactionTemplate writes a transaction skeleton with mutator slots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-template-"));
  const rpc = new FakeRpc({ getTransaction: { value: fakeWhirlpoolTx() } });

  const result = await createTransactionTemplate({
    name: "swap",
    tx: "sig",
    cwd: root,
    rpcUrl: "http://rpc.invalid",
    rpc
  });

  const template = JSON.parse(await readFile(result.templatePath, "utf8")) as {
    kind: string;
    instructions: unknown[];
    mutators: { byte_ranges: unknown[]; signer_replacements: unknown[]; account_replacements: unknown[] };
  };
  assert.equal(template.kind, "transaction-template");
  assert.equal(template.instructions.length, 1);
  assert.deepEqual(Object.keys(template.mutators).sort(), [
    "account_replacements",
    "byte_ranges",
    "signer_replacements"
  ]);
});

function fakeWhirlpoolTx(): RpcTransaction {
  const keys = [
    "FeePayer111111111111111111111111111111111",
    "whirL111111111111111111111111111111111111",
    "Token111111111111111111111111111111111111",
    "Authority11111111111111111111111111111111",
    "Whirlpool1111111111111111111111111111111",
    "OwnerA1111111111111111111111111111111111",
    "OwnerB1111111111111111111111111111111111",
    "VaultA1111111111111111111111111111111111",
    "VaultB1111111111111111111111111111111111",
    "TickA1111111111111111111111111111111111",
    "TickB1111111111111111111111111111111111",
    "TickC1111111111111111111111111111111111",
    "Oracle111111111111111111111111111111111"
  ];
  return {
    slot: 10,
    transaction: {
      signatures: ["sig"],
      message: {
        accountKeys: keys,
        recentBlockhash: "blockhash",
        instructions: [
          {
            programIdIndex: 1,
            accounts: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            data: "3Bxs"
          }
        ],
        addressTableLookups: [{ accountKey: "Lookup111111111111111111111111111111111" }]
      }
    },
    meta: { loadedAddresses: { writable: [], readonly: [] } }
  };
}
