/**
 * Pages and API for what the database does not hold: blocks without transactions that were deleted,
 * and the deposit each block starts with. They are read from the node, never ahead of the indexer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgliteDb, migrate } from "../src/db.ts";
import { Indexer } from "../src/indexer.ts";
import { ALICE, FakeChain, GENESIS_TIME, pad, ZERO } from "./fake-chain.ts";

test("deleted blocks and system deposits are served from the node, up to the indexed tip", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain(true);
  for (let n = 0; n < 6; n++) chain.add(n === 2 ? [{ from: ZERO, to: ALICE, amount: 5n }] : []);
  const indexer = new Indexer(db, chain, { startBlock: 0n, batchSize: 50 });
  await indexer.step();
  assert.equal(await indexer.prune(1, 20_000, Number(GENESIS_TIME) + 1000), 4);
  chain.add([]); // block 6: on the node, not indexed yet

  const config = ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", NODE_ENV: "test" });
  const app = await buildApp({ db, rpc: chain, config });
  const get = (url: string) => app.inject({ method: "GET", url });

  // A deleted block, by number and by hash.
  const gone = chain.blocks[1]!;
  const page = await get("/block/1");
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes(gone.hash));
  assert.equal((await get(`/block/${gone.hash}`)).statusCode, 200);
  const json = (await get("/api/v1/block/1")).json();
  assert.deepEqual([json.number, json.hash, json.tx_count, json.transactions], ["1", gone.hash, 0, []]);
  assert.equal((await get(`/search?q=${gone.hash}`)).headers.location, `/block/${gone.hash}`);

  // The home page shows the price the node asks, not the block's base fee (1 wei here), and asks once.
  assert.match((await get("/")).body, /<span>Gas price<\/span><strong>0\.001 gwei<\/strong>/);
  await get("/");
  assert.equal(chain.calls.get("eth_gasPrice"), 1);

  // A stored block is still read from the database.
  assert.equal((await get("/api/v1/block/2")).json().transactions.length, 1);

  // The system deposit of any indexed block.
  const deposit = chain.blocks[2]!.transactions[0]!;
  const tx = await get(`/tx/${deposit.hash}`);
  assert.equal(tx.statusCode, 200);
  assert.ok(tx.body.includes("System") && !tx.body.includes("Deposit from BSC"));
  const txJson = (await get(`/api/v1/tx/${deposit.hash}`)).json();
  assert.deepEqual([txJson.block_number, txJson.type, txJson.status, txJson.timestamp], ["2", 126, 1, String(GENESIS_TIME + 2n)]);
  assert.equal((await get(`/search?q=${deposit.hash}`)).headers.location, `/tx/${deposit.hash}`);

  // Nothing ahead of the indexer, and nothing the node does not know.
  assert.equal((await get("/block/6")).statusCode, 404);
  assert.equal((await get(`/block/${chain.blocks[6]!.hash}`)).statusCode, 404);
  assert.equal((await get(`/tx/${chain.blocks[6]!.transactions[0]!.hash}`)).statusCode, 404);
  assert.equal((await get(`/api/v1/tx/${pad(0xdeadn)}`)).statusCode, 404);
  assert.equal((await get(`/tx/${pad(0xdeadn)}`)).statusCode, 404);

  await app.close();
  await db.close();
});

test("a node that does not answer leaves a missing block not found", async () => {
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain(true);
  for (let n = 0; n < 4; n++) chain.add([]);
  const indexer = new Indexer(db, chain, { startBlock: 0n, batchSize: 50 });
  await indexer.step();
  await indexer.prune(1, 20_000, Number(GENESIS_TIME) + 1000);
  const down = { call: () => Promise.reject(new Error("down")), batch: () => Promise.reject(new Error("down")), batchSettled: () => Promise.reject(new Error("down")) };
  const app = await buildApp({ db, rpc: down, config: ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", NODE_ENV: "test" }) });
  assert.equal((await app.inject({ method: "GET", url: "/block/1" })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/tx/${pad(7n)}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/block/3" })).statusCode, 200, "the tip is stored");
  const home = await app.inject({ method: "GET", url: "/" });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /<span>Gas price<\/span><strong>–<\/strong>/, "no price is shown, not the base fee");
  await app.close();
  await db.close();
});
