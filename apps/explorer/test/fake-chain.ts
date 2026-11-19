/** An in-memory chain that answers the JSON-RPC calls the explorer makes. */
import { encodeAbiParameters } from "viem";
import { L1_BLOCK, SYSTEM_DEPOSITOR, TRANSFER_TOPIC } from "../src/indexer.ts";
import { hex, RpcError, type Hex, type RawBlock, type RawReceipt, type RawTx, type Rpc, type Settled } from "../src/rpc.ts";

export const pad = (v: string | bigint) => `0x${(typeof v === "bigint" ? v.toString(16) : v.slice(2)).padStart(64, "0")}` as Hex;
export const TOKEN = "0x00000000000000000000000000000000000071c0" as Hex;
export const ALICE = "0x00000000000000000000000000000000000a11ce" as Hex;
export const BOB = "0x0000000000000000000000000000000000000b0b" as Hex;
export const CAROL = "0x00000000000000000000000000000000000ca201" as Hex;
export const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
export const GENESIS_TIME = 1_700_000_000n;

export interface Spec { from: Hex; to: Hex; amount: bigint; ok?: boolean }

export class FakeChain implements Rpc {
  blocks: RawBlock[] = [];
  receipts = new Map<string, RawReceipt[]>();
  /** Every call made, by method. */
  calls = new Map<string, number>();
  /** What eth_gasPrice answers; null makes the call fail. */
  gasPrice: bigint | null = 1_000_000n;
  /** The call object of every eth_call made. */
  reads: { to: string; data: string; gas?: string }[] = [];
  /** Contracts whose every call uses up the gas it is given. */
  looping = new Set<string>();

  /** `system`: each block starts with the sequencer's deposit, as LONGYU's blocks do. */
  constructor(private readonly system = false) {}

  /** Adds a block one second after the last, holding one token transfer per spec. */
  add(transfers: Spec[], fork = 0): RawBlock {
    const n = BigInt(this.blocks.length);
    const txs: RawTx[] = transfers.map((t, i) => ({
      hash: pad(n * 1_000_000n + BigInt(fork) * 1000n + BigInt(i) + 7n), from: t.from, to: TOKEN, value: "0x0" as Hex, gas: "0x5208" as Hex,
      gasPrice: "0x1" as Hex, nonce: hex(i), input: "0xa9059cbb" as Hex, type: "0x2" as Hex, transactionIndex: hex(i),
    }));
    const receipts: RawReceipt[] = transfers.map((t, i) => ({
      transactionHash: txs[i]!.hash, status: t.ok === false ? "0x0" : "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
      l1Fee: "0x10",
      logs: t.ok === false ? [] : [{ address: TOKEN, topics: [TRANSFER_TOPIC as Hex, pad(t.from), pad(t.to)], data: pad(t.amount), logIndex: hex(i), transactionHash: txs[i]!.hash }],
    }));
    return this.addBlock(txs, receipts, fork);
  }

  /** Adds a block holding these transactions with their receipts, after the system deposit if the chain has one, and numbers them. */
  addBlock(txs: RawTx[], receipts: RawReceipt[], fork = 0): RawBlock {
    const n = BigInt(this.blocks.length);
    const hash = pad(n * 1000n + BigInt(fork) + 1n);
    const parent = n === 0n ? pad(0n) : this.blocks[Number(n) - 1]!.hash;
    if (this.system) {
      const deposit: RawTx = {
        hash: pad(n * 1_000_000n + BigInt(fork) * 1000n + 999n), from: SYSTEM_DEPOSITOR as Hex, to: L1_BLOCK as Hex, value: "0x0", gas: "0xf4240",
        gasPrice: "0x0", nonce: hex(n), input: "0x440a5e20000000000000", type: "0x7e", transactionIndex: "0x0", sourceHash: pad(n + 5n), mint: "0x0",
      };
      txs.unshift(deposit);
      receipts.unshift({ transactionHash: deposit.hash, status: "0x1", gasUsed: "0xb41c", effectiveGasPrice: "0x0", contractAddress: null, logs: [] });
    }
    txs.forEach((t, i) => (t.transactionIndex = hex(i)));
    const block: RawBlock = {
      number: hex(n), hash, parentHash: parent, timestamp: hex(GENESIS_TIME + n), miner: ZERO, gasUsed: "0x0", gasLimit: "0x1c9c380",
      baseFeePerGas: "0x1", size: "0x100", transactions: txs,
    };
    this.receipts.set(hash, receipts);
    this.blocks.push(block);
    return block;
  }

  /** Drops blocks from `n` on, as a reorganisation would. */
  truncate(n: number) {
    this.blocks.length = n;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.one(method, params)) as T;
  }
  async batch<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    return Promise.all(calls.map((c) => this.one(c.method, c.params))) as Promise<T[]>;
  }
  async batchSettled<T>(calls: { method: string; params: unknown[] }[]): Promise<Settled<T>[]> {
    return Promise.all(calls.map((c) => this.one(c.method, c.params).then(
      (value) => ({ ok: true as const, value: value as T }),
      (error) => ({ ok: false as const, error: error as RpcError }),
    )));
  }

  private find(hash: string): { block: RawBlock; tx: RawTx; receipt: RawReceipt } | null {
    for (const block of this.blocks) {
      const i = block.transactions.findIndex((t) => t.hash === hash);
      if (i >= 0) return { block, tx: block.transactions[i]!, receipt: this.receipts.get(block.hash)![i]! };
    }
    return null;
  }

  private async one(method: string, params: unknown[]): Promise<unknown> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    switch (method) {
      case "eth_blockNumber": return hex(this.blocks.length - 1);
      case "eth_gasPrice": {
        if (this.gasPrice === null) throw new RpcError(-32000, "no price");
        return hex(this.gasPrice);
      }
      case "eth_getBlockByNumber": return this.blocks[Number(BigInt(params[0] as string))] ?? null;
      case "eth_getBlockByHash": return this.blocks.find((b) => b.hash === params[0]) ?? null;
      case "eth_getBlockReceipts": {
        const b = this.blocks[Number(BigInt(params[0] as string))];
        return b ? this.receipts.get(b.hash) : null;
      }
      case "eth_getTransactionByHash": {
        const f = this.find(params[0] as string);
        return f ? { ...f.tx, blockNumber: f.block.number } : null;
      }
      case "eth_getTransactionReceipt": return this.find(params[0] as string)?.receipt ?? null;
      case "eth_call": {
        const { to, data } = params[0] as { to: string; data: string };
        this.reads.push(params[0] as { to: string; data: string });
        if (this.looping.has(to)) throw new RpcError(-32000, "out of gas");
        if (data === "0x06fdde03") return encodeAbiParameters([{ type: "string" }], [`Tether<script>${String.fromCharCode(0x202e)}`]);
        if (data === "0x95d89b41") return encodeAbiParameters([{ type: "string" }], ["tUSD"]);
        if (data === "0x313ce567") return pad(6n);
        throw new RpcError(3, "execution reverted");
      }
      default: throw new RpcError(-32601, `method ${method} not found`);
    }
  }
}
