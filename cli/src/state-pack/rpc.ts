export interface RpcClient {
  call<T>(method: string, params: unknown[]): Promise<RpcResponse<T>>;
}

export interface RpcResponse<T> {
  context?: { slot?: number };
  value: T;
}

export interface RpcAccountInfo {
  data: [string, string] | string;
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch?: number;
  rent_epoch?: number;
}

export interface RpcLoadedAddresses {
  writable?: string[];
  readonly?: string[];
}

export interface RpcCompiledInstruction {
  programIdIndex: number;
  accounts?: number[];
  data: string;
}

export interface RpcTransaction {
  slot?: number;
  blockTime?: number | null;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: unknown[];
      recentBlockhash?: string;
      instructions?: RpcCompiledInstruction[];
      addressTableLookups?: Array<{ accountKey?: string; writableIndexes?: number[]; readonlyIndexes?: number[] }>;
    };
  };
  meta?: {
    loadedAddresses?: RpcLoadedAddresses;
  } | null;
}

export class HttpRpcClient implements RpcClient {
  constructor(private readonly rpcUrl: string) {}

  async call<T>(method: string, params: unknown[]): Promise<RpcResponse<T>> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "riptide",
        method,
        params
      })
    });
    if (!response.ok) {
      throw new Error(`RPC ${method} failed with HTTP ${response.status}: ${response.statusText}`);
    }
    const payload = (await response.json()) as {
      error?: { code?: number; message?: string };
      result?: RpcResponse<T> | T;
    };
    if (payload.error) {
      throw new Error(
        `RPC ${method} failed (${payload.error.code ?? "unknown"}): ${payload.error.message ?? "unknown error"}`
      );
    }
    if (payload.result === undefined) {
      throw new Error(`RPC ${method} returned no result`);
    }
    if (isRpcResponse<T>(payload.result)) {
      return payload.result;
    }
    return { value: payload.result as T };
  }
}

export async function getTransaction(
  rpc: RpcClient,
  signature: string
): Promise<RpcTransaction> {
  const response = await rpc.call<RpcTransaction>("getTransaction", [
    signature,
    {
      encoding: "json",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    }
  ]);
  if (response.value === null) {
    throw new Error(`transaction not found: ${signature}`);
  }
  return response.value;
}

export async function getMultipleAccounts(
  rpc: RpcClient,
  pubkeys: string[],
  commitment: string
): Promise<{ slot: number; accounts: Array<RpcAccountInfo | null> }> {
  const response = await rpc.call<Array<RpcAccountInfo | null>>("getMultipleAccounts", [
    pubkeys,
    { encoding: "base64", commitment }
  ]);
  return {
    slot: response.context?.slot ?? 0,
    accounts: response.value
  };
}

function isRpcResponse<T>(value: unknown): value is RpcResponse<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "value")
  );
}
