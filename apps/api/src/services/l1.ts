/**
 * Reads the gas balances of the accounts that post the chain to its L1: the batcher and the proposer.
 * When one of them runs dry the chain keeps making blocks, so nothing on the L2 shows the fault.
 */
import { createPublicClient, getAddress, http, type Address } from "viem";

export interface L1Account {
  name: string;
  address: Address;
}

export interface L1Watch {
  balances(): Promise<(L1Account & { balance: bigint })[]>;
}

/** Parses L1_WATCH: comma-separated "name:address" pairs, such as "batcher:0x…,proposer:0x…". */
export function parseL1Watch(raw: string | undefined): L1Account[] {
  const accounts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const m = /^([a-z][a-z0-9 -]{0,23}):(0x[0-9a-fA-F]{40})$/.exec(entry);
    if (!m) throw new Error(`L1_WATCH: "${entry}" must be name:address, the name in lower case`);
    return { name: m[1]!, address: getAddress(m[2]!) };
  });
  if (new Set(accounts.map((a) => a.name)).size !== accounts.length) throw new Error("L1_WATCH: every name is used once");
  return accounts;
}

export function createL1Watch(o: { rpcUrl: string; accounts: L1Account[] }): L1Watch {
  const client = createPublicClient({ transport: http(o.rpcUrl, { timeout: 10_000, retryCount: 2 }) });
  return {
    balances: () => Promise.all(o.accounts.map(async (a) => ({ ...a, balance: await client.getBalance({ address: a.address }) }))),
  };
}
