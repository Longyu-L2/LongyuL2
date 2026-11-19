/**
 * The indexer against an in-memory chain: blocks, receipts, token transfers and balances, hostile
 * token metadata, a reorganisation that replaces the tip, the system deposit that is left out, the
 * deletion of old blocks without transactions, balances no real token could reach, token metadata
 * the node did not give the first time, and a block that announces more tokens than a step reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgliteDb, migrate } from "../src/db.ts";
import { Indexer, TRANSFER_TOPIC } from "../src/indexer.ts";
import { hex, RpcError, type Hex, type RawTx, type Rpc } from "../src/rpc.ts";
import * as Q from "../src/queries.ts";
import { ALICE, BOB, CAROL, FakeChain, GENESIS_TIME, pad, TOKEN, ZERO } from "./fake-chain.ts";

const balance = async (db: Awaited<ReturnType<typeof createPgliteDb>>, holder: string) =>
  (await db.query<{ b: string }>("SELECT balance::text AS b FROM token_balances WHERE token = $1 AND holder = $2", [TOKEN, holder])).rows[0]?.b ?? "0";

test("indexes blocks, transfers and balances, and undoes a reorganised tip", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ZERO, to: ALICE, amount: 100n }]);
  chain.add([{ from: ALICE, to: BOB, amount: 30n }, { from: ALICE, to: BOB, amount: 999n, ok: false }]);
  const indexer = new Indexer(db, chain, { startBlock: 0n, batchSize: 10 });

  const r = await indexer.step();
  assert.deepEqual([r.indexed, r.rolledBack, r.tip], [3, false, 2n]);
  assert.equal(await balance(db, ALICE), "70");
  assert.equal(await balance(db, BOB), "30");
  const s = await Q.stats(db);
  assert.equal(s.transactions, 3n);
  // The same transactions, counted by the UTC day of their block and over the last 24 hours.
  const at = Number(GENESIS_TIME) + 60;
  const today = Math.floor(at / 86_400);
  assert.deepEqual(await Q.dailyTransactions(db, 14, at), [{ day: today, count: 3 }]);
  assert.equal(await Q.lastDayTransactions(db, at), 3n);
  assert.deepEqual([await Q.dailyTransactions(db, 14, at + 14 * 86_400), await Q.lastDayTransactions(db, at + 86_400)], [[], 0n]);
  const tok = await Q.token(db, TOKEN);
  // Hostile metadata is stored without control characters; pages escape the rest.
  assert.deepEqual([tok?.name, tok?.symbol, tok?.decimals, tok?.holders, tok?.transfers], ["Tether<script>", "tUSD", 6, 2n, 2n]);
  const failed = (await Q.blockTxs(db, 2n, 25))[1]!;
  assert.equal(failed.status, 0);
  assert.equal(failed.l1_fee, "16");
  assert.equal((await indexer.step()).indexed, 0, "nothing new");

  // Block 2 is replaced by 2' (Alice pays Carol instead), and 3' follows it.
  chain.truncate(2);
  chain.add([{ from: ALICE, to: CAROL, amount: 50n }], 1);
  chain.add([{ from: CAROL, to: BOB, amount: 5n }], 1);
  const undo = await indexer.step();
  assert.deepEqual([undo.rolledBack, undo.tip], [true, 1n]);
  assert.equal(await balance(db, ALICE), "100", "the reorganised transfer is reversed");
  assert.equal(await balance(db, BOB), "0");
  assert.equal((await Q.stats(db)).transactions, 1n);
  assert.deepEqual(await Q.dailyTransactions(db, 14, at), [{ day: today, count: 1 }], "and leaves the day's count");

  const redo = await indexer.step();
  assert.deepEqual([redo.indexed, redo.tip], [2, 3n]);
  assert.equal(await balance(db, ALICE), "50");
  assert.equal(await balance(db, CAROL), "45");
  assert.equal(await balance(db, BOB), "5");
  assert.equal((await Q.token(db, TOKEN))?.holders, 3n);
  assert.equal((await Q.stats(db)).transactions, 3n);
  assert.deepEqual(await Q.dailyTransactions(db, 14, at), [{ day: today, count: 3 }]);
  assert.equal((await Q.block(db, { number: 2n }))?.hash, chain.blocks[2]!.hash);

  // A database from before the counts by day gets them from the transactions it already holds.
  await db.query("DROP TABLE daily_transactions");
  await db.query("DROP INDEX transactions_timestamp_idx");
  await db.query("DELETE FROM schema_migrations WHERE name = '003_daily_transactions.sql'");
  assert.deepEqual(await migrate(db), ["003_daily_transactions.sql"]);
  assert.deepEqual(await Q.dailyTransactions(db, 14, at), [{ day: today, count: 3 }]);
  await db.close();
});

test("a node without eth_getBlockReceipts is read receipt by receipt", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ZERO, to: ALICE, amount: 7n }]);
  const plain: Rpc = {
    call: (m, p) => chain.call(m, p),
    batch: async (calls) => {
      if (calls.some((c) => c.method === "eth_getBlockReceipts")) throw new RpcError(-32601, "the method eth_getBlockReceipts does not exist");
      return Promise.all(calls.map((c) => {
        if (c.method !== "eth_getTransactionReceipt") return chain.call(c.method, c.params);
        const hash = c.params[0] as string;
        for (const list of chain.receipts.values()) for (const r of list) if (r.transactionHash === hash) return r;
        return null;
      })) as never;
    },
    batchSettled: (calls) => chain.batchSettled(calls),
  };
  const r = await new Indexer(db, plain, { startBlock: 0n, batchSize: 10 }).step();
  assert.equal(r.indexed, 2);
  assert.equal(await balance(db, ALICE), "7");
  await db.close();
});

test("the deposit each block starts with is not indexed, and its blocks ask for no receipts", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain(true);
  chain.add([]);
  chain.add([{ from: ZERO, to: ALICE, amount: 100n }, { from: ALICE, to: BOB, amount: 30n }]);
  chain.add([]);
  const r = await new Indexer(db, chain, { startBlock: 0n, batchSize: 10 }).step();
  assert.equal(r.indexed, 3);
  assert.equal(chain.calls.get("eth_getBlockReceipts"), 1, "only the block with other transactions");
  assert.deepEqual((await Q.latestBlocks(db, 10)).map((b) => b.tx_count), [0, 2, 0]);
  assert.equal((await Q.stats(db)).transactions, 2n);
  // The transactions keep their place in the block, after the deposit, and their own receipts.
  const txs = await Q.blockTxs(db, 1n, 25);
  assert.deepEqual(txs.map((t) => [t.tx_index, t.type, t.from_address]), [[1, 2, ZERO], [2, 2, ALICE]]);
  assert.equal(await balance(db, ALICE), "70");
  assert.equal(await balance(db, BOB), "30");
  assert.equal((await Q.deposits(db, 10)).length, 0);
  assert.equal(await Q.tx(db, chain.blocks[0]!.transactions[0]!.hash), null);
  await db.close();
});

test("old blocks without transactions are deleted; those with transactions and the tip stay", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain(true);
  for (let n = 0; n < 10; n++) chain.add(n === 3 ? [{ from: ZERO, to: ALICE, amount: 9n }] : []);
  const indexer = new Indexer(db, chain, { startBlock: 0n, batchSize: 50 });
  await indexer.step();
  const numbers = async () => (await db.query<{ number: bigint }>("SELECT number FROM blocks ORDER BY number")).rows.map((b) => Number(b.number));
  const at = (n: number) => Number(GENESIS_TIME) + n;

  // Block n was made at second n. Keeping 5 seconds at second 10 leaves blocks 5 to 9.
  assert.equal(await indexer.prune(5, 3, at(10)), 3, "a pass covers at most `limit` heights");
  assert.deepEqual(await numbers(), [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(await indexer.prune(5, 3, at(10)), 1);
  assert.deepEqual(await numbers(), [3, 5, 6, 7, 8, 9]);
  assert.equal(await indexer.prune(5, 3, at(10)), 0, "nothing else is old enough");
  assert.equal((await Q.stats(db)).transactions, 1n);
  assert.deepEqual((await Q.dailyTransactions(db, 14, at(10))).map((d) => d.count), [1], "deleting empty blocks takes nothing from the count by day");
  assert.equal(await balance(db, ALICE), "9");

  // Long after: everything is old, and the tip still stays so that the next block can be checked against it.
  assert.equal(await indexer.prune(5, 20_000, at(10_000)), 4);
  assert.deepEqual(await numbers(), [3, 9]);
  chain.add([]);
  assert.deepEqual([(await indexer.step()).indexed, await numbers()], [1, [3, 9, 10]]);

  // Blocks 9 and 10 are replaced after the blocks below them were deleted: indexing resumes from
  // the last block still stored, and the heights it reads again are deleted again later.
  chain.truncate(9);
  chain.add([], 1);
  chain.add([{ from: ALICE, to: BOB, amount: 4n }], 1);
  chain.add([], 1);
  assert.equal((await indexer.step()).rolledBack, true);
  assert.equal((await indexer.step()).rolledBack, true);
  assert.deepEqual(await numbers(), [3]);
  assert.equal((await indexer.step()).indexed, 8);
  assert.deepEqual(await numbers(), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(await indexer.prune(5, 20_000, at(10_000)), 6);
  assert.deepEqual(await numbers(), [3, 10, 11]);
  assert.equal(await balance(db, BOB), "4");
  assert.equal((await Q.stats(db)).transactions, 2n);
  await db.close();
});

test("transfers that add up past any uint256 are indexed, and undone, like the rest", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain();
  chain.add([]);
  // A token's contract writes whatever Transfer events it likes: twelve of the largest amount come to 79 digits.
  const max = 2n ** 256n - 1n;
  for (let n = 0; n < 3; n++) chain.add(Array.from({ length: 4 }, () => ({ from: ZERO, to: ALICE, amount: max })));
  chain.add([{ from: ALICE, to: BOB, amount: max }]);
  const indexer = new Indexer(db, chain, { startBlock: 0n, batchSize: 2 });
  for (let r = await indexer.step(); r.tip !== r.head; r = await indexer.step());
  assert.equal((12n * max).toString().length, 79);
  assert.equal(await balance(db, ALICE), (11n * max).toString());
  assert.equal(await balance(db, BOB), max.toString());
  assert.equal((await Q.stats(db)).transactions, 13n);
  const column = await db.query<{ p: number | null }>("SELECT numeric_precision AS p FROM information_schema.columns WHERE table_name = 'token_balances' AND column_name = 'balance'");
  assert.deepEqual(column.rows, [{ p: null }], "the balance has no limit of digits");

  // The last two blocks are replaced: their transfers are taken back out of a balance that long.
  chain.truncate(3);
  chain.add([{ from: ALICE, to: CAROL, amount: max }], 1);
  chain.add([], 1);
  chain.add([], 1);
  assert.equal((await indexer.step()).rolledBack, true);
  assert.equal(await balance(db, ALICE), (12n * max).toString());
  assert.equal(await balance(db, BOB), "0");
  assert.equal((await indexer.step()).rolledBack, true);
  assert.equal(await balance(db, ALICE), (8n * max).toString());
  for (let r = await indexer.step(); r.tip !== r.head; r = await indexer.step());
  assert.equal(await balance(db, ALICE), (7n * max).toString());
  assert.equal(await balance(db, CAROL), max.toString());
  assert.deepEqual((await Q.tokenHolders(db, TOKEN, 10)).map((h) => h.holder), [ALICE, CAROL]);
  await db.close();
});

test("token metadata the node did not give is read again later, a few tokens a pass", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ZERO, to: ALICE, amount: 1n }]);
  // The node gives no answer about the tokens in `down`; `asked` lists every token it was asked about.
  const down = new Set<string>([TOKEN]);
  let asked: string[] = [];
  const rpc: Rpc = {
    call: (m, p) => chain.call(m, p),
    batch: (calls) => chain.batch(calls),
    batchSettled: (calls) => {
      const { to } = calls[0]!.params[0] as { to: string };
      asked.push(to);
      return down.has(to) ? Promise.reject(new Error("no answer")) : chain.batchSettled(calls);
    },
  };
  const indexer = new Indexer(db, rpc, { startBlock: 0n, batchSize: 10 });
  const unread = async () => (await db.query<{ address: string }>("SELECT address FROM tokens WHERE metadata_at IS NULL ORDER BY address")).rows.map((t) => t.address);
  /** One pass at `now`: how many tokens it read, and which it asked the node about. */
  const pass = async (now: number) => {
    asked = [];
    return [await indexer.retryMetadata(now), asked];
  };

  // The block is indexed all the same, and the token waits without a name.
  assert.equal((await indexer.step()).indexed, 2);
  assert.equal(await balance(db, ALICE), "1");
  assert.deepEqual(await unread(), [TOKEN]);
  assert.equal((await Q.token(db, TOKEN))?.symbol, null);

  // Each pass that fails doubles the wait before the next: a minute, two minutes...
  let now = 1_000_000;
  assert.deepEqual(await pass(now), [0, [TOKEN]]);
  assert.deepEqual(await pass(now + 59_999), [0, []]);
  assert.deepEqual(await pass((now += 60_000)), [0, [TOKEN]]);
  assert.deepEqual(await pass(now + 119_999), [0, []]);
  // ...up to an hour, however long the token goes on failing.
  for (let i = 0; i < 10; i++) assert.deepEqual(await pass((now += 3_600_000)), [0, [TOKEN]]);
  assert.deepEqual(await pass(now + 3_599_999), [0, []]);
  down.clear();
  assert.deepEqual(await pass((now += 3_600_000)), [1, [TOKEN]]);
  assert.deepEqual(await unread(), []);
  assert.deepEqual([(await Q.token(db, TOKEN))?.name, (await Q.token(db, TOKEN))?.symbol], ["Tether<script>", "tUSD"]);
  // A pass that reads everything puts the wait back to half a minute.
  assert.deepEqual(await pass(now + 29_999), [0, []]);
  assert.deepEqual(await pass((now += 30_000)), [0, []]);

  // Nine tokens wait, and the third never answers. A pass reads five at most and stops at one that
  // fails; the next goes on after it, and the failing one is asked again when its turn comes round.
  const t = Array.from({ length: 9 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  await db.query("INSERT INTO tokens (address, kind, first_block) SELECT unnest($1::text[]), 'erc20', 1", [t]);
  down.add(t[2]!);
  assert.deepEqual(await pass((now += 3_600_000)), [2, t.slice(0, 3)]);
  assert.deepEqual(await pass((now += 3_600_000)), [5, t.slice(3, 8)]);
  assert.deepEqual(await pass((now += 3_600_000)), [1, t.slice(8)]);
  assert.deepEqual(await unread(), [t[2]]);
  assert.deepEqual(await pass((now += 3_600_000)), [0, [t[2]]]);
  down.clear();
  assert.deepEqual(await pass((now += 3_600_000)), [1, [t[2]]]);
  assert.deepEqual(await unread(), []);
  assert.deepEqual(await pass((now += 3_600_000)), [0, []]);
  await db.close();
});

test("a block that announces many tokens has five read with it and the rest in later passes, every read with a gas limit", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain();
  chain.add([]);
  // One transaction whose receipt carries a Transfer event from each of twelve contracts.
  const t = Array.from({ length: 12 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex);
  const tx: RawTx = { hash: pad(77n), from: ALICE, to: BOB, value: "0x0", gas: "0x5208", gasPrice: "0x1", nonce: "0x0", input: "0x", type: "0x2", transactionIndex: "0x0" };
  chain.addBlock([tx], [{
    transactionHash: tx.hash, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
    logs: t.map((address, i) => ({ address, topics: [TRANSFER_TOPIC as Hex, pad(ZERO), pad(ALICE)], data: pad(1n), logIndex: hex(i), transactionHash: tx.hash })),
  }]);
  // The eighth loops in every call: the node stops it at the gas limit and says so.
  chain.looping.add(t[7]!);
  const indexer = new Indexer(db, chain, { startBlock: 0n, batchSize: 10 });
  const unread = async () => (await db.query<{ address: string }>("SELECT address FROM tokens WHERE metadata_at IS NULL ORDER BY address")).rows.map((r) => r.address);
  const reads = () => chain.calls.get("eth_call") ?? 0;

  assert.equal((await indexer.step()).indexed, 2);
  assert.equal((await Q.stats(db)).tokens, 12n);
  assert.equal(reads(), 15, "three reads for each of five tokens");
  assert.deepEqual(await unread(), t.slice(5));

  // A pass that read as many as it may is followed by another on the next call; the last waits half a minute.
  const now = 1_000_000;
  assert.equal(await indexer.retryMetadata(now), 5);
  assert.deepEqual(await unread(), t.slice(10));
  assert.equal(await indexer.retryMetadata(now), 2);
  assert.deepEqual(await unread(), []);
  assert.equal(reads(), 36);
  assert.equal(await indexer.retryMetadata(now + 29_999), 0);
  assert.equal(await indexer.retryMetadata(now + 30_000), 0);
  assert.equal(reads(), 36, "running out of gas is an answer: that token is not asked again");
  assert.deepEqual([(await Q.token(db, t[7]!))?.name, (await Q.token(db, t[6]!))?.symbol], [null, "tUSD"]);
  assert.equal(chain.reads.length, 36);
  assert.ok(chain.reads.every((c) => c.gas === "0x186a0"), "100,000 gas a read");
  await db.close();
});
