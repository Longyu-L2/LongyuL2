/** Reads PaymentRouter events on BNB Smart Chain, only from blocks that can no longer change. */
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { paymentRouterAbi } from "@longyu/abis";
import type { Config } from "../config.ts";

export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

export type RouterLog =
  | { kind: "treasury"; treasury: Address; block: bigint; logIndex: number; txHash: Hex }
  | {
      kind: "paid";
      orderId: Hex;
      payer: Address;
      token: Address;
      amount: bigint;
      block: bigint;
      blockTime: bigint;
      logIndex: number;
      txHash: Hex;
    };

export interface PaymentChain {
  /** Newest block that can no longer be reorganised away. */
  safeBlock(): Promise<bigint>;
  /** OrderPaid and TreasurySet events of one router, in chain order. */
  routerLogs(router: Address, from: bigint, to: bigint): Promise<RouterLog[]>;
}

export interface PaymentToken {
  symbol: string;
  address: Address;
  decimals: number;
}

export interface PaymentConfig {
  router: Address;
  startBlock: bigint;
  treasury: Address;
  chainId: bigint;
  /** "finalized" uses the chain's finality tag (BSC fast finality); a number waits that many blocks. */
  finality: "finalized" | number;
  tokens: PaymentToken[];
}

/** Parses "USDT:0x55d3...7955:18,BNB:native:18". Throws on anything malformed. */
export function parsePaymentTokens(spec: string): PaymentToken[] {
  const tokens = spec.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [symbol, addr, dec] = entry.split(":");
    if (!symbol || !/^[A-Z0-9]{2,10}$/.test(symbol)) throw new Error(`PAYMENT_TOKENS: bad symbol in "${entry}"`);
    const address = addr === "native" ? NATIVE : addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? getAddress(addr) : null;
    if (!address) throw new Error(`PAYMENT_TOKENS: bad address in "${entry}"`);
    const decimals = Number(dec);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`PAYMENT_TOKENS: bad decimals in "${entry}"`);
    return { symbol, address, decimals };
  });
  if (!tokens.length) throw new Error("PAYMENT_TOKENS is empty");
  if (new Set(tokens.map((t) => t.symbol)).size !== tokens.length || new Set(tokens.map((t) => t.address)).size !== tokens.length) {
    throw new Error("PAYMENT_TOKENS lists a symbol or address twice");
  }
  return tokens;
}

export function parseFinality(v: string): "finalized" | number {
  if (v === "finalized") return v;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n > 10_000) throw new Error('PAYMENT_FINALITY must be "finalized" or a number of blocks');
  return n;
}

/** Null when payments are not configured. */
export function paymentConfig(config: Config): PaymentConfig | null {
  if (!config.PAYMENT_ROUTER_ADDRESS) return null;
  if (config.PAYMENT_START_BLOCK === undefined || !config.TREASURY_ADDRESS) {
    throw new Error("PAYMENT_START_BLOCK and TREASURY_ADDRESS are required with PAYMENT_ROUTER_ADDRESS");
  }
  return {
    router: getAddress(config.PAYMENT_ROUTER_ADDRESS),
    startBlock: config.PAYMENT_START_BLOCK,
    treasury: getAddress(config.TREASURY_ADDRESS),
    chainId: config.PAYMENT_CHAIN_ID,
    finality: parseFinality(config.PAYMENT_FINALITY),
    tokens: parsePaymentTokens(config.PAYMENT_TOKENS),
  };
}

export function createPaymentChain(o: { rpcUrl: string; chainId: bigint; finality: "finalized" | number }): PaymentChain {
  const client = createPublicClient({ transport: http(o.rpcUrl, { timeout: 20_000, retryCount: 3 }) });
  let checked = false;
  const ensureChain = async () => {
    if (checked) return;
    const id = BigInt(await client.getChainId());
    if (id !== o.chainId) throw new Error(`payment RPC serves chain ${id}, expected ${o.chainId}`);
    checked = true;
  };
  return {
    async safeBlock() {
      await ensureChain();
      if (o.finality === "finalized") {
        const b = await client.getBlock({ blockTag: "finalized" });
        if (b.number === null) throw new Error("RPC returned no finalized block");
        return b.number;
      }
      const latest = await client.getBlockNumber({ cacheTime: 0 });
      return latest - BigInt(o.finality);
    },
    async routerLogs(router, from, to) {
      await ensureChain();
      const logs = await client.getContractEvents({ address: router, abi: paymentRouterAbi, fromBlock: from, toBlock: to, strict: true });
      const times = new Map<bigint, bigint>();
      const out: RouterLog[] = [];
      for (const l of logs) {
        if (l.removed || getAddress(l.address) !== getAddress(router) || l.blockNumber === null || l.logIndex === null || !l.transactionHash) continue;
        if (l.eventName === "TreasurySet") {
          out.push({ kind: "treasury", treasury: getAddress(l.args.treasury), block: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash });
        } else if (l.eventName === "OrderPaid") {
          let t = times.get(l.blockNumber);
          if (t === undefined) {
            t = (await client.getBlock({ blockNumber: l.blockNumber })).timestamp;
            times.set(l.blockNumber, t);
          }
          out.push({
            kind: "paid",
            orderId: l.args.orderId.toLowerCase() as Hex,
            payer: getAddress(l.args.payer),
            token: getAddress(l.args.token),
            amount: l.args.amount,
            block: l.blockNumber,
            blockTime: t,
            logIndex: l.logIndex,
            txHash: l.transactionHash,
          });
        }
      }
      return out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
    },
  };
}
