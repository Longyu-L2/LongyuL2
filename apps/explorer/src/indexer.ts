/**
 * Follows the LONGYU chain block by block into Postgres: blocks, transactions, receipts, logs,
 * token transfers and token balances. Each block is written in one database transaction, so a page
 * never sees half a block. Before extending the tip, the new block's parent hash is checked against
 * the stored tip; on a mismatch (a reorganisation) the tip is undone, balances included, and the
 * next step re-reads that height from the node.
 *
 * LONGYU makes four blocks a second, and each starts with the sequencer's own deposit that records
 * BSC's latest block. Storing those would be 345,600 rows a day of nothing a visitor looks for, so
 * that transaction is not indexed, and blocks holding nothing else are deleted after a retention
 * period. Pages read both from the node when asked (see app.ts).
 */
import type { Db, Queryable } from "./db.ts";
import { hex, RpcError, type Hex, type RawBlock, type RawReceipt, type RawTx, type Rpc } from "./rpc.ts";
import { refreshTokenMetadata } from "./tokens.ts";

/** keccak256("Transfer(address,address,uint256)"): ERC-20 and ERC-721 share it. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const SYSTEM_DEPOSITOR = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001";
export const L1_BLOCK = "0x4200000000000000000000000000000000000015";
const DEPOSIT_TYPE = 126n;
/** Seconds in a day: transactions are counted by UTC day for the home page. */
const DAY = 86_400n;
/** Between passes that read token metadata again: this long after a clean pass, doubling after each failed one up to the maximum. */
const METADATA_RETRY_MS = 30_000;
const METADATA_RETRY_MAX_MS = 3_600_000;
/**
 * Most new tokens whose metadata a step reads before it goes on to the next blocks, and most a
 * retry pass reads. Anyone can make a block announce hundreds of tokens; the rest wait for the
 * retry passes, so indexing never stands still for them.
 */
const METADATA_PER_PASS = 5;

const lower = (h: string) => h.toLowerCase();
const topicAddress = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

/** The deposit each block starts with: the system account writing BSC's latest block to the L1 Block contract. */
export const isSystemTx = (t: Pick<RawTx, "type" | "from" | "to">) =>
  BigInt(t.type) === DEPOSIT_TYPE && lower(t.from) === SYSTEM_DEPOSITOR && t.to !== null && lower(t.to) === L1_BLOCK;

export interface StepResult {
  indexed: number;
  rolledBack: boolean;
  head: bigint;
  tip: bigint | null;
}

export class Indexer {
  /** Whether the node answers eth_getBlockReceipts; learnt on first use. */
  private blockReceipts: boolean | null = null;
  /** The metadata retry pass: the last token it tried, when the next pass is due and the wait after it. */
  private metadata = { after: "", at: 0, wait: METADATA_RETRY_MS };

  constructor(
    private readonly db: Db,
    private readonly rpc: Rpc,
    private readonly opts: { startBlock: bigint; batchSize: number; log?: (msg: string) => void },
  ) {}

  async tip(): Promise<{ number: bigint; hash: string } | null> {
    return (await this.db.query<{ number: bigint; hash: string }>("SELECT number, hash FROM blocks ORDER BY number DESC LIMIT 1")).rows[0] ?? null;
  }

  async step(): Promise<StepResult> {
    const head = BigInt(await this.rpc.call<Hex>("eth_blockNumber", []));
    const tip = await this.tip();
    const from = tip ? tip.number + 1n : this.opts.startBlock;
    if (from > head) return { indexed: 0, rolledBack: false, head, tip: tip?.number ?? null };
    const to = head < from + BigInt(this.opts.batchSize) - 1n ? head : from + BigInt(this.opts.batchSize) - 1n;
    const numbers: bigint[] = [];
    for (let n = from; n <= to; n++) numbers.push(n);
    const fetched = await this.rpc.batch<RawBlock | null>(numbers.map((n) => ({ method: "eth_getBlockByNumber", params: [hex(n), true] })));

    // Keep the run of blocks that links to the stored tip and to each other.
    const blocks: RawBlock[] = [];
    let parent = tip?.hash;
    for (const b of fetched) {
      if (!b) break;
      if (parent !== undefined && lower(b.parentHash) !== parent) {
        if (blocks.length === 0 && tip) {
          await this.rollback(tip.number);
          this.opts.log?.(`reorg: block ${tip.number} replaced; undone`);
          return { indexed: 0, rolledBack: true, head, tip: tip.number - 1n };
        }
        break;
      }
      blocks.push(b);
      parent = lower(b.hash);
    }
    if (blocks.length === 0) return { indexed: 0, rolledBack: false, head, tip: tip?.number ?? null };

    const receipts = await this.receipts(blocks);
    const discovered = new Set<string>();
    await this.db.tx(async (q) => {
      for (const b of blocks) await this.insertBlock(q, b, receipts.get(lower(b.hash)) ?? [], discovered);
    });
    if (discovered.size) {
      // A token not read here, or whose read fails, keeps metadata_at empty; retryMetadata reads those.
      await refreshTokenMetadata(this.db, this.rpc, [...discovered].slice(0, METADATA_PER_PASS)).catch((e) => this.opts.log?.(`token metadata: ${(e as Error).message}`));
    }
    return { indexed: blocks.length, rolledBack: false, head, tip: BigInt(blocks.at(-1)!.number) };
  }

  /**
   * Receipts for each block, in transaction order, checked against the block's transactions.
   * Blocks holding only the system deposit are not asked for: nothing of theirs is indexed.
   */
  private async receipts(all: RawBlock[]): Promise<Map<string, RawReceipt[]>> {
    const out = new Map<string, RawReceipt[]>();
    const blocks = all.filter((b) => !b.transactions.every(isSystemTx));
    if (blocks.length && this.blockReceipts !== false) {
      try {
        const got = await this.rpc.batch<RawReceipt[] | null>(blocks.map((b) => ({ method: "eth_getBlockReceipts", params: [b.number] })));
        this.blockReceipts = true;
        blocks.forEach((b, i) => out.set(lower(b.hash), got[i] ?? []));
      } catch (e) {
        if (!(e instanceof RpcError) || (e.code !== -32601 && !/not (found|supported|available)|does not exist/i.test(e.message))) throw e;
        this.blockReceipts = false;
      }
    }
    if (this.blockReceipts === false) {
      for (const b of blocks) {
        out.set(lower(b.hash), await this.rpc.batch<RawReceipt>(b.transactions.map((t) => ({ method: "eth_getTransactionReceipt", params: [t.hash] }))));
      }
    }
    for (const b of blocks) {
      const r = out.get(lower(b.hash))!;
      const ok = r.length === b.transactions.length && r.every((x, i) => x && lower(x.transactionHash) === lower(b.transactions[i]!.hash));
      if (!ok) throw new Error(`receipts for block ${BigInt(b.number)} do not match its transactions; retrying`);
    }
    return out;
  }

  private async insertBlock(q: Queryable, b: RawBlock, receipts: RawReceipt[], discovered: Set<string>): Promise<void> {
    const number = BigInt(b.number);
    const timestamp = BigInt(b.timestamp);
    await q.query(
      `INSERT INTO blocks (number, hash, parent_hash, timestamp, miner, gas_used, gas_limit, base_fee, size, tx_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [number, lower(b.hash), lower(b.parentHash), timestamp, lower(b.miner), BigInt(b.gasUsed).toString(), BigInt(b.gasLimit).toString(),
        b.baseFeePerGas ? BigInt(b.baseFeePerGas).toString() : null, b.size ? Number(BigInt(b.size)) : null, b.transactions.filter((t) => !isSystemTx(t)).length],
    );
    if (b.transactions.every(isSystemTx)) return;

    const txRows: unknown[][] = [];
    const logRows: unknown[][] = [];
    const transferRows: unknown[][] = [];
    const deltas = new Map<string, bigint>();
    const credit = (token: string, holder: string, amount: bigint) => {
      if (holder === ZERO_ADDRESS) return;
      const k = `${token}|${holder}`;
      deltas.set(k, (deltas.get(k) ?? 0n) + amount);
    };

    b.transactions.forEach((t, i) => {
      if (isSystemTx(t)) return;
      const r = receipts[i]!;
      const input = lower(t.input ?? "0x");
      txRows.push([
        lower(t.hash), number, Number(BigInt(t.transactionIndex)), timestamp, lower(t.from), t.to ? lower(t.to) : null,
        r.contractAddress ? lower(r.contractAddress) : null, BigInt(t.value).toString(), BigInt(t.nonce), Number(BigInt(t.type)),
        BigInt(t.gas).toString(), BigInt(r.gasUsed).toString(),
        (r.effectiveGasPrice ?? t.gasPrice) ? BigInt((r.effectiveGasPrice ?? t.gasPrice)!).toString() : null,
        r.l1Fee ? BigInt(r.l1Fee).toString() : null,
        r.status === undefined ? null : Number(BigInt(r.status)),
        input.length >= 10 ? input.slice(0, 10) : null, input,
        t.sourceHash ? lower(t.sourceHash) : null, t.mint ? BigInt(t.mint).toString() : null,
      ]);
      for (const l of r.logs) {
        const topics = l.topics.map(lower);
        const logIndex = Number(BigInt(l.logIndex));
        const address = lower(l.address);
        logRows.push([number, logIndex, lower(t.hash), address, topics[0] ?? null, topics[1] ?? null, topics[2] ?? null, topics[3] ?? null, lower(l.data)]);
        if (topics[0] !== TRANSFER_TOPIC) continue;
        // ERC-20: three topics and a 32-byte amount. ERC-721: four topics and no data. Anything else is not a token transfer.
        let kind: "erc20" | "erc721" | null = null;
        let value = 0n;
        let tokenId: bigint | null = null;
        if (topics.length === 3 && l.data.length === 66) {
          kind = "erc20";
          value = BigInt(l.data);
        } else if (topics.length === 4 && (l.data === "0x" || l.data === "0x0")) {
          kind = "erc721";
          value = 1n;
          tokenId = BigInt(topics[3]!);
        }
        if (!kind) continue;
        const from = topicAddress(topics[1]!);
        const to = topicAddress(topics[2]!);
        transferRows.push([number, logIndex, lower(t.hash), timestamp, address, from, to, value.toString(), tokenId === null ? null : tokenId.toString(), kind]);
        credit(address, from, -value);
        credit(address, to, value);
      }
    });

    await insertRows(q, "transactions",
      ["hash", "block_number", "tx_index", "timestamp", "from_address", "to_address", "contract_address", "value", "nonce", "type", "gas_limit", "gas_used", "gas_price", "l1_fee", "status", "method_id", "input", "source_hash", "mint"],
      txRows);
    await insertRows(q, "logs", ["block_number", "log_index", "tx_hash", "address", "topic0", "topic1", "topic2", "topic3", "data"], logRows);

    for (const row of transferRows) {
      const [token, kind] = [row[4] as string, row[9] as string];
      const created = await q.query("INSERT INTO tokens (address, kind, first_block) VALUES ($1,$2,$3) ON CONFLICT (address) DO NOTHING RETURNING address", [token, kind, number]);
      if (created.rows.length) discovered.add(token);
    }
    await insertRows(q, "token_transfers", ["block_number", "log_index", "tx_hash", "timestamp", "token", "from_address", "to_address", "value", "token_id"], transferRows.map((r) => r.slice(0, 9)));
    await applyDeltas(q, deltas);
    await q.query("UPDATE counters SET value = value + $1 WHERE name = 'transactions'", [txRows.length]);
    await q.query(
      "INSERT INTO daily_transactions (day, count) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET count = daily_transactions.count + EXCLUDED.count",
      [Number(timestamp / DAY), txRows.length],
    );
  }

  /**
   * Reads the metadata of tokens that have none yet: those a step left for later and those whose
   * read failed because the node did not answer. At most `limit` a pass; returns how many it read.
   * Tokens are taken in address order and round again, so one that never answers waits its turn
   * like the rest. A pass stops at the first token that fails, and each failed pass doubles the wait
   * before the next, up to an hour: a token that always fails costs one request a pass and never
   * holds up indexing for longer than that.
   */
  async retryMetadata(now = Date.now(), limit = METADATA_PER_PASS): Promise<number> {
    const m = this.metadata;
    if (now < m.at) return 0;
    const pending = async (after: string) => (await this.db.query<{ address: string }>(
      "SELECT address FROM tokens WHERE metadata_at IS NULL AND address > $1 ORDER BY address LIMIT $2",
      [after, limit],
    )).rows;
    let rows = await pending(m.after);
    if (!rows.length && m.after) rows = await pending("");
    let read = 0;
    let failed = false;
    for (const { address } of rows) {
      m.after = address;
      try {
        await refreshTokenMetadata(this.db, this.rpc, [address]);
        read++;
      } catch (e) {
        this.opts.log?.(`token metadata: ${address}: ${(e as Error).message}`);
        failed = true;
        break;
      }
    }
    m.wait = failed ? Math.min(METADATA_RETRY_MAX_MS, m.wait * 2) : METADATA_RETRY_MS;
    // A clean pass that reached its limit means more are waiting: the next is due on the next call.
    m.at = !failed && read === limit ? now : now + m.wait;
    return read;
  }

  /**
   * Deletes blocks without transactions that are older than `keepSeconds`, at most `limit` heights
   * a call, and returns how many went. A counter remembers how far it has been, so each call reads
   * only new heights. Blocks with transactions stay for good, and so does the tip, whatever its
   * age: the next block is checked against it.
   */
  async prune(keepSeconds: number, limit = 20_000, now = Math.floor(Date.now() / 1000)): Promise<number> {
    return this.db.tx(async (q) => {
      const from = (await q.query<{ value: bigint }>("SELECT value FROM counters WHERE name = 'pruned_to'")).rows[0]!.value;
      const first = (await q.query<{ number: bigint }>("SELECT number FROM blocks WHERE number > $1 ORDER BY number ASC LIMIT 1", [from])).rows[0]?.number;
      if (first === undefined) return 0;
      const to = (await q.query<{ number: bigint }>(
        `SELECT number FROM blocks WHERE number >= $1 AND number < $2 AND timestamp < $3
           AND number < (SELECT max(number) FROM blocks) ORDER BY number DESC LIMIT 1`,
        [first, first + BigInt(limit), BigInt(now - keepSeconds)],
      )).rows[0]?.number;
      if (to === undefined) return 0;
      const gone = await q.query("DELETE FROM blocks WHERE number > $1 AND number <= $2 AND tx_count = 0 RETURNING number", [from, to]);
      await q.query("UPDATE counters SET value = $1 WHERE name = 'pruned_to'", [to]);
      return gone.rows.length;
    });
  }

  /** Undoes one block: reverses its balance changes, then deletes it and everything hanging off it. */
  async rollback(number: bigint): Promise<void> {
    await this.db.tx(async (q) => {
      const transfers = (await q.query<{ token: string; from_address: string; to_address: string; value: string }>(
        "SELECT token, from_address, to_address, value FROM token_transfers WHERE block_number = $1",
        [number],
      )).rows;
      const deltas = new Map<string, bigint>();
      const add = (token: string, holder: string, amount: bigint) => {
        if (holder === ZERO_ADDRESS) return;
        deltas.set(`${token}|${holder}`, (deltas.get(`${token}|${holder}`) ?? 0n) + amount);
      };
      for (const t of transfers) {
        add(t.token, t.from_address, BigInt(t.value));
        add(t.token, t.to_address, -BigInt(t.value));
      }
      await applyDeltas(q, deltas);
      const gone = (await q.query<{ tx_count: number; timestamp: bigint }>("SELECT tx_count, timestamp FROM blocks WHERE number = $1", [number])).rows[0];
      const count = gone?.tx_count ?? 0;
      await q.query("DELETE FROM blocks WHERE number = $1", [number]);
      await q.query("UPDATE counters SET value = value - $1 WHERE name = 'transactions'", [count]);
      if (gone && count > 0) await q.query("UPDATE daily_transactions SET count = count - $1 WHERE day = $2", [count, Number(BigInt(gone.timestamp) / DAY)]);
      // If the blocks below were deleted as empty, indexing resumes further down: let prune pass there again.
      await q.query("UPDATE counters SET value = LEAST(value, COALESCE((SELECT max(number) FROM blocks), -1)) WHERE name = 'pruned_to'");
      await q.query("DELETE FROM tokens t WHERE t.first_block >= $1 AND NOT EXISTS (SELECT 1 FROM token_transfers x WHERE x.token = t.address)", [number]);
    });
  }
}

/**
 * Adds each change to its holder's balance. A token's events are its contract's word, so a balance
 * can pass uint256 or go below zero; the column has no precision (002_wide_balances.sql) and holds
 * any sum of them, so no event can make this fail and stop the block.
 */
async function applyDeltas(q: Queryable, deltas: Map<string, bigint>): Promise<void> {
  const rows = [...deltas].filter(([, v]) => v !== 0n).map(([k, v]) => {
    const [token, holder] = k.split("|");
    return [token, holder, v.toString()];
  });
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = chunk.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3}::numeric)`).join(",");
    await q.query(
      `INSERT INTO token_balances (token, holder, balance) VALUES ${values}
       ON CONFLICT (token, holder) DO UPDATE SET balance = token_balances.balance + EXCLUDED.balance`,
      chunk.flat(),
    );
  }
}

async function insertRows(q: Queryable, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const per = Math.max(1, Math.floor(30_000 / columns.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const values = chunk.map((_, j) => `(${columns.map((__, c) => `$${j * columns.length + c + 1}`).join(",")})`).join(",");
    await q.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}`, chunk.flat());
  }
}

/**
 * Runs the indexer until stopped: fast while catching up, POLL_MS apart once at the head. At the
 * head it also deletes old blocks without transactions (`keepEmptySeconds`; 0 keeps them all) and
 * reads the token metadata that is still missing.
 */
export function runIndexer(indexer: Indexer, pollMs: number, log: (msg: string) => void, keepEmptySeconds = 0): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let failures = 0;
  let pruneAt = 0;
  const loop = async () => {
    if (stopped) return;
    let wait = pollMs;
    try {
      const r = await indexer.step();
      failures = 0;
      const behind = r.tip === null || r.tip < r.head;
      if (r.indexed > 0 || r.rolledBack) wait = behind ? 0 : pollMs;
      if (keepEmptySeconds > 0 && !behind && Date.now() >= pruneAt) {
        // A pass that reached its limit means more is waiting: come back sooner.
        pruneAt = Date.now() + ((await indexer.prune(keepEmptySeconds)) >= 10_000 ? 5_000 : 60_000);
      }
      if (!behind) await indexer.retryMetadata();
    } catch (e) {
      failures++;
      wait = Math.min(60_000, pollMs * 2 ** Math.min(failures, 6));
      log(`indexer: ${(e as Error).message} (retry in ${wait} ms)`);
    }
    if (!stopped) timer = setTimeout(loop, wait);
  };
  void loop();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
