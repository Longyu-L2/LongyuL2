/**
 * Plain JSON-RPC to the LONGYU node. Raw responses are used on purpose: they keep the OP Stack
 * fields (deposit source hash and mint, the L1 data fee on receipts) that typed clients drop.
 */
export type Hex = `0x${string}`;

export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: Hex;
  transactionHash: Hex;
}

export interface RawTx {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  value: Hex;
  gas: Hex;
  gasPrice?: Hex;
  nonce: Hex;
  input: Hex;
  type: Hex;
  transactionIndex: Hex;
  /** Absent on transactions read inside a block; set by eth_getTransactionByHash once mined. */
  blockNumber?: Hex | null;
  sourceHash?: Hex;
  mint?: Hex;
}

export interface RawReceipt {
  transactionHash: Hex;
  status?: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  contractAddress: Hex | null;
  logs: RawLog[];
  l1Fee?: Hex;
}

export interface RawBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
  miner: Hex;
  gasUsed: Hex;
  gasLimit: Hex;
  baseFeePerGas?: Hex;
  size?: Hex;
  transactions: RawTx[];
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
  /** All results, or throws on the first error. */
  batch<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]>;
  /** Every result or error, for calls that may fail one by one (eth_call to unknown contracts). */
  batchSettled<T>(calls: { method: string; params: unknown[] }[]): Promise<Settled<T>[]>;
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export function httpRpc(url: string, timeoutMs = 20_000): Rpc {
  let id = 0;
  const post = async (body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new RpcError(res.status, `RPC HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const unwrap = <T>(r: { result?: T; error?: { code: number; message: string } }): T => {
    if (r.error) throw new RpcError(r.error.code, r.error.message);
    return r.result as T;
  };
  return {
    async call<T>(method: string, params: unknown[]) {
      return unwrap<T>((await post({ jsonrpc: "2.0", id: ++id, method, params })) as never);
    },
    async batch<T>(calls: { method: string; params: unknown[] }[]) {
      return (await settled<T>(calls)).map((r) => {
        if (!r.ok) throw r.error;
        return r.value;
      });
    },
    batchSettled: <T>(calls: { method: string; params: unknown[] }[]) => settled<T>(calls),
  };

  async function settled<T>(calls: { method: string; params: unknown[] }[]): Promise<Settled<T>[]> {
    if (calls.length === 0) return [];
    const first = id + 1;
    const out = (await post(calls.map((c) => ({ jsonrpc: "2.0", id: ++id, method: c.method, params: c.params })))) as { id: number }[];
    if (!Array.isArray(out)) throw new RpcError(-32603, "RPC batch answered with a single object");
    const byId = new Map(out.map((r) => [r.id, r]));
    return calls.map((_, i) => {
      const r = byId.get(first + i);
      if (!r) return { ok: false as const, error: new RpcError(-32603, "RPC batch response is missing an entry") };
      try {
        return { ok: true as const, value: unwrap<T>(r as never) };
      } catch (e) {
        return { ok: false as const, error: e as RpcError };
      }
    });
  }
}

export const hex = (n: bigint | number) => `0x${n.toString(16)}` as Hex;
export const big = (h: Hex | undefined | null): bigint | null => (h === undefined || h === null ? null : BigInt(h));
