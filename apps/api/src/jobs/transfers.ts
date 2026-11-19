/**
 * Indexes reward-asset transfers out of user wallets (current and earlier ones), for the
 * wallet-sweep rule in risk.ts. Reads the LONGYU chain from where it last stopped.
 */
import { getAddress } from "viem";
import type { Deps } from "../context.ts";
import type { RewardTransfer } from "../services/chain.ts";

/** Blocks per read; a native asset needs one block read per block. */
export const TRANSFER_RANGE = 300n;
const MAX_RANGES_PER_RUN = 10;

export async function indexTransfers(deps: Deps): Promise<number> {
  const latest = await deps.chain.latestBlock();
  let recorded = 0;
  for (let i = 0; i < MAX_RANGES_PER_RUN; i++) {
    const cur = (await deps.db.query<{ block: bigint }>("SELECT block FROM chain_cursor WHERE name = 'transfers'")).rows[0];
    // First run: start at the chain head. The rule only looks back two weeks; history is not needed.
    if (!cur) {
      await deps.db.query("INSERT INTO chain_cursor (name, block) VALUES ('transfers', $1) ON CONFLICT (name) DO NOTHING", [latest]);
      return 0;
    }
    if (cur.block >= latest) break;
    const from = cur.block + 1n;
    const to = latest - from >= TRANSFER_RANGE ? from + TRANSFER_RANGE - 1n : latest;
    const transfers = await deps.chain.rewardTransfers(from, to);

    // Keep only transfers from addresses some user has linked.
    const senders = [...new Set(transfers.map((t) => getAddress(t.from)))];
    const watched = new Set<string>();
    if (senders.length) {
      const rows = (await deps.db.query<{ address: string }>(
        `SELECT address FROM wallets WHERE address = ANY($1::text[])
         UNION SELECT from_address FROM wallet_changes WHERE from_address = ANY($1::text[])
         UNION SELECT to_address FROM wallet_changes WHERE to_address = ANY($1::text[])`,
        [senders],
      )).rows;
      for (const r of rows) watched.add(getAddress(r.address));
    }
    const keep: RewardTransfer[] = [];
    for (const t of transfers) {
      if (!watched.has(getAddress(t.from)) || getAddress(t.from) === getAddress(t.to)) continue;
      // A reverted transaction moves no value; token events only exist for successful transfers.
      if (t.native && !(await deps.chain.transactionSucceeded(t.txHash))) continue;
      keep.push(t);
    }
    recorded += await deps.db.tx(async (q) => {
      let n = 0;
      for (const t of keep) {
        const r = await q.query(
          `INSERT INTO wallet_transfers (tx_hash, log_index, block, block_time, from_address, to_address, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric) ON CONFLICT DO NOTHING RETURNING tx_hash`,
          [t.txHash.toLowerCase(), t.logIndex, t.block, t.blockTime, getAddress(t.from), getAddress(t.to), t.amount.toString()],
        );
        n += r.rows.length;
      }
      const moved = await q.query("UPDATE chain_cursor SET block = $1 WHERE name = 'transfers' AND block = $2 RETURNING name", [to, cur.block]);
      if (!moved.rows[0]) throw new Error("transfer cursor moved concurrently");
      return n;
    });
  }
  return recorded;
}
