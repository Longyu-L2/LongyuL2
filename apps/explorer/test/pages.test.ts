/**
 * Pages and API answers that have a limit or a rule of their own: long lists are cut or paged,
 * counts stop at 10,000, the bridge page says what each deposit and withdrawal carried, numbers too
 * long for a block are not looked up, and an error page is headed by what went wrong. Calldata and
 * event data are cut at 4,096 bytes in lists, the Etherscan transaction list at 100 a page, the
 * token list is read once in 10 seconds, and visitors' queries have a time limit in the database.
 * The home page: its figures, the chart of 14 days, the latest of each list and LONGYU's links.
 */
import { createServer } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi } from "viem";
import { buildApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgDb, createPgliteDb, migrate, type Db } from "../src/db.ts";
import { bridgedToken, L2_BRIDGE, L2_MESSENGER, MESSAGE_PASSER } from "../src/decode.ts";
import { Indexer, TRANSFER_TOPIC } from "../src/indexer.ts";
import * as Q from "../src/queries.ts";
import { hex, type Hex, type RawLog, type RawReceipt, type RawTx } from "../src/rpc.ts";
import { ALICE, BOB, CAROL, FakeChain, GENESIS_TIME, pad, TOKEN, ZERO } from "./fake-chain.ts";

type Log = Pick<RawLog, "address" | "topics" | "data">;

/** Indexes the chain into a new database and serves it. */
async function serve(chain: FakeChain, env: Record<string, string> = {}, broken?: (db: Db) => Db) {
  const db = await createPgliteDb();
  await migrate(db);
  await new Indexer(db, chain, { startBlock: 0n, batchSize: 50 }).step();
  const config = ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", NODE_ENV: "test", ...env });
  const app = await buildApp({ db: broken ? broken(db) : db, rpc: chain, config });
  return {
    db,
    get: (url: string) => app.inject({ method: "GET", url }),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

let made = 0n;
/** Adds a block of these transactions, each with the events it emitted, and returns their hashes. */
function addBlock(chain: FakeChain, items: { tx?: Partial<RawTx>; logs?: Log[] }[]): Hex[] {
  let logIndex = 0;
  const txs: RawTx[] = [];
  const receipts: RawReceipt[] = [];
  items.forEach(({ tx = {}, logs = [] }, i) => {
    const hash = pad(0xfeed00000000n + made++);
    txs.push({ hash, from: ALICE, to: BOB, value: "0x0", gas: "0x5208", gasPrice: "0x1", nonce: hex(i), input: "0x", type: "0x2", transactionIndex: hex(i), ...tx });
    receipts.push({
      transactionHash: hash, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null,
      logs: logs.map((l) => ({ ...l, logIndex: hex(logIndex++), transactionHash: hash })),
    });
  });
  const hashes = txs.map((t) => t.hash);
  chain.addBlock(txs, receipts);
  return hashes;
}

const transfer = (from: Hex, to: Hex, amount: bigint): Log => ({ address: TOKEN, topics: [TRANSFER_TOPIC as Hex, pad(from), pad(to)], data: pad(amount) });
const count = (body: string, piece: string) => body.split(piece).length - 1;

test("every answer carries the security headers", async () => {
  const chain = new FakeChain();
  chain.add([]);
  const s = await serve(chain);
  for (const url of ["/blocks", "/api/v1/stats", "/static/app.css", "/nothing-here"]) {
    const h = (await s.get(url)).headers;
    assert.equal(h["strict-transport-security"], "max-age=31536000", url);
    assert.equal(h["x-content-type-options"], "nosniff", url);
  }
  await s.close();
});

test("pages ask for static files by the release's fingerprint, and only that address is kept for long", async () => {
  const chain = new FakeChain();
  chain.add([]);
  const s = await serve(chain);
  const page = (await s.get("/blocks")).body;
  const links = [...page.matchAll(/(?:href|src)="(\/static\/[^"]+)"/g)].map((m) => m[1]!);
  // The mark is on the page twice, in the header and in the footer.
  assert.deepEqual(links.map((l) => l.split("?")[0]), ["/static/favicon.svg", "/static/app.css", "/static/app.js", "/static/mark.svg", "/static/mark.svg"]);
  const build = /\?v=([0-9a-f]{12})$/.exec(links[0]!)?.[1];
  assert.ok(build);
  for (const link of links) {
    assert.ok(link.endsWith(`?v=${build}`), link);
    assert.equal((await s.get(link)).headers["cache-control"], "public, max-age=31536000, immutable", link);
  }
  // Any other address for the same file is short-lived, so a stale copy cannot outlive a release by much.
  for (const url of ["/static/app.css", "/static/app.css?v=000000000000", "/static/app.css?v="]) {
    const r = await s.get(url);
    assert.deepEqual([r.statusCode, r.headers["cache-control"]], [200, "public, max-age=300"], url);
  }
  // The stylesheet names its fonts and icons without a fingerprint: every one of them is served, the fonts for a week.
  const css = (await s.get("/static/app.css")).body;
  const named = [...new Set([...css.matchAll(/url\("(\/static\/[^"]+)"\)/g)].map((m) => m[1]!))];
  assert.equal(named.filter((u) => u.endsWith(".woff2")).length, 4);
  assert.ok(named.some((u) => u.endsWith(".svg")));
  for (const url of named) {
    const r = await s.get(url);
    const font = url.endsWith(".woff2");
    assert.deepEqual([r.statusCode, r.headers["content-type"], r.headers["cache-control"]], [200, font ? "font/woff2" : "image/svg+xml", font ? "public, max-age=604800" : "public, max-age=300"], url);
  }
  await s.close();
});

test("a number too long for a block is not looked up", async () => {
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ALICE, to: BOB, amount: 1n }]);
  const s = await serve(chain);
  // 19 digits can pass the largest block number the database holds; 18 never do.
  const long = "9".repeat(19);
  assert.equal((await s.get(`/block/${long}`)).statusCode, 404);
  assert.equal((await s.get(`/api/v1/block/${long}`)).statusCode, 404);
  const search = await s.get(`/search?q=${long}`);
  assert.equal(search.statusCode, 200);
  assert.ok(search.body.includes("Nothing found"));
  const list = await s.get(`/api?module=account&action=txlist&address=${ALICE}&startblock=${long}&endblock=${long}`);
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().result.length, 1, "the range is ignored, as any other that cannot be read");

  const fits = "9".repeat(18);
  assert.equal((await s.get(`/block/${fits}`)).statusCode, 404);
  assert.equal((await s.get(`/search?q=${fits}`)).headers.location, `/block/${fits}`);
  assert.equal((await s.get(`/api?module=account&action=txlist&address=${ALICE}&startblock=${fits}`)).json().message, "No transactions found");
  assert.equal((await s.get("/search?q=1")).headers.location, "/block/1");
  await s.close();
});

test("an error page is headed by what went wrong", async () => {
  const chain = new FakeChain();
  chain.add([]);
  const mark = `<section class="notfound"><img class="mark big" src="/static/mark.svg" alt="" width="45" height="56">`;

  const s = await serve(chain, { RATE_LIMIT: "10" });
  const missing = await s.get("/nothing-here");
  assert.equal(missing.statusCode, 404);
  assert.ok(missing.body.includes(`${mark}<h1>Not found</h1><p class="muted">There is nothing at this address.</p>`));
  assert.ok(missing.body.includes("<title>Not found · LONGYU Scan</title>"));
  for (let i = 0; i < 10; i++) await s.get("/blocks");
  const limited = await s.get("/blocks");
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.body.includes(`${mark}<h1>Too many requests</h1><p class="muted">Try again in a minute.</p>`));
  assert.ok(limited.body.includes("<title>Too many requests · LONGYU Scan</title>"));
  assert.ok(!limited.body.includes("Not found"));
  assert.deepEqual((await s.get("/api/v1/blocks")).json(), { error: "rate_limited" });
  await s.close();

  const down = await serve(chain, {}, (db) => ({ ...db, query: () => Promise.reject(new Error("the database is down")) }));
  const failed = await down.get("/blocks");
  assert.equal(failed.statusCode, 500);
  assert.ok(failed.body.includes(`${mark}<h1>Something went wrong</h1><p class="muted">Try again in a moment.</p>`));
  assert.ok(failed.body.includes("<title>Something went wrong · LONGYU Scan</title>"));
  assert.ok(!failed.body.includes("Not found") && !failed.body.includes("database"));
  assert.deepEqual((await down.get("/api/v1/blocks")).json(), { error: "internal" });
  await down.close();
});

test("a transaction's events and token transfers are cut at 200, with the count of all", async () => {
  const chain = new FakeChain();
  chain.add([]);
  const [many, one] = addBlock(chain, [
    { logs: Array.from({ length: 250 }, (_, i) => transfer(ZERO, ALICE, BigInt(i + 1))) },
    { logs: [transfer(ALICE, BOB, 1n)] },
  ]) as [Hex, Hex];
  const s = await serve(chain);

  const page = (await s.get(`/tx/${many}`)).body;
  assert.equal(count(page, `class="card log"`), 200);
  assert.ok(page.includes(`<h2>Events <span class="muted">250</span></h2><p class="muted">Showing the first 200 of 250.</p>`));
  assert.ok(page.includes(`<h2>Token transfers</h2><p class="muted">Showing the first 200 of 250.</p>`));
  const json = (await s.get(`/api/v1/tx/${many}`)).json();
  assert.deepEqual([json.logs.length, json.logsTotal, json.transfers.length, json.transfersTotal], [200, 250, 200, 250]);
  assert.deepEqual([json.logs[0].log_index, json.logs[199].log_index, json.logs[0].decoded.name], [0, 199, "Transfer"]);
  assert.equal(json.transfers[199].value, "200");

  // A transaction with fewer is shown whole, and nothing is counted twice.
  const whole = (await s.get(`/tx/${one}`)).body;
  assert.ok(whole.includes(`<h2>Events <span class="muted">1</span></h2><section class="card log">`));
  assert.ok(!whole.includes("Showing the first"));
  const small = (await s.get(`/api/v1/tx/${one}`)).json();
  assert.deepEqual([small.logs.length, small.logsTotal, small.transfers.length, small.transfersTotal], [1, 1, 1, 1]);
  assert.equal((await Q.txLogs(s.db, many, 250)).total, 250, "a list of exactly the limit is whole");
  assert.equal((await Q.txLogs(s.db, pad(1n))).total, 0);
  await s.close();
});

test("a block's transactions come a page at a time, and lists leave out the input data", async () => {
  const chain = new FakeChain();
  chain.add([]);
  chain.add(Array.from({ length: 30 }, () => ({ from: ALICE, to: BOB, amount: 1n })));
  chain.add([{ from: ALICE, to: BOB, amount: 1n }]);
  const s = await serve(chain);
  const indexes = (json: { transactions: { tx_index: number }[] }) => json.transactions.map((t) => t.tx_index);
  const first = (await s.get("/api/v1/block/1")).json();
  assert.equal(first.tx_count, 30);
  assert.deepEqual(indexes(first), Array.from({ length: 25 }, (_, i) => i));
  assert.deepEqual(indexes((await s.get("/api/v1/block/1?p=2")).json()), [25, 26, 27, 28, 29]);
  assert.deepEqual(indexes((await s.get("/api/v1/block/1?p=3")).json()), []);

  const page = (await s.get("/block/1")).body;
  assert.equal(count(page, "<tr class="), 25);
  assert.ok(page.includes(`<a href="/block/1?p=2">Next →</a>`) && !page.includes("← Previous"));
  const last = (await s.get("/block/1?p=2")).body;
  assert.equal(count(last, "<tr class="), 5);
  assert.ok(last.includes(`<a href="/block/1?p=1">← Previous</a>`) && !last.includes("Next →"));
  assert.ok(!(await s.get("/block/2")).body.includes(`class="pager"`), "a block that fits one page has no pager");

  // The input data is on the transaction itself, and in the Etherscan list, which has always had it.
  const lists = [first.transactions, (await s.get("/api/v1/txs")).json(), (await s.get("/api/v1/home")).json().txs, (await s.get(`/api/v1/address/${ALICE}/txs`)).json()];
  for (const list of lists) {
    assert.ok(list.length > 0);
    for (const t of list) assert.deepEqual(["hash" in t, "method_id" in t, "input" in t], [true, true, false]);
  }
  assert.equal((await s.get(`/api/v1/tx/${first.transactions[0].hash}`)).json().input, "0xa9059cbb");
  assert.equal((await s.get(`/api?module=account&action=txlist&address=${ALICE}`)).json().result[0].input, "0xa9059cbb");
  await s.close();
});

test("counts of holders, transfers and an address's transactions stop at 10,000", async () => {
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ALICE, to: ALICE, amount: 5n }]);
  const s = await serve(chain);
  // 10,050 more holders and transfers of the token and as many transactions of Carol's, and 30 of
  // Bob's, written straight to the database. Each transaction is from and to the same address.
  await s.db.query(
    "INSERT INTO token_balances (token, holder, balance) SELECT $1::text, '0x' || lpad(to_hex(g), 40, '0'), 1 FROM generate_series(1000, 11049) g",
    [TOKEN],
  );
  await s.db.query(
    `INSERT INTO token_transfers (block_number, log_index, tx_hash, timestamp, token, from_address, to_address, value)
     SELECT 1, g, $2::text, 0, $1::text, $3::text, $3::text, 1 FROM generate_series(1000, 11049) g`,
    [TOKEN, pad(1n), BOB],
  );
  const txs = (who: string, from: number, to: number) => s.db.query(
    `INSERT INTO transactions (hash, block_number, tx_index, timestamp, from_address, to_address, value, nonce, type, gas_limit, input)
     SELECT '0x' || lpad(to_hex(g), 64, '0'), 1, g, 0, $1::text, $1::text, 0, g, 2, 21000, '0x' FROM generate_series($2::int, $3::int) g`,
    [who, from, to],
  );
  await txs(CAROL, 1000, 11049);
  await txs(BOB, 20000, 20029);

  const token = await Q.token(s.db, TOKEN);
  assert.deepEqual([token?.holders, token?.transfers], [10_000n, 10_000n]);
  assert.equal(await Q.addressTxCount(s.db, CAROL), 10_000n);
  assert.equal(await Q.addressTxCount(s.db, BOB), 30n, "a transaction from and to the address is counted once");
  assert.equal(await Q.addressTxCount(s.db, ALICE), 1n);
  assert.equal(await Q.addressTxCount(s.db, ZERO), 0n);

  const page = (await s.get(`/token/${TOKEN}`)).body;
  assert.ok(page.includes("<span>Holders</span><strong>10,000+</strong>") && page.includes("<span>Transfers</span><strong>10,000+</strong>"));
  assert.ok((await s.get("/tokens")).body.includes(`<td class="r num">10,000+</td><td class="r num">10,000+</td>`));
  assert.ok((await s.get(`/address/${CAROL}`)).body.includes("<span>Transactions</span><strong>10,000+</strong>"));
  assert.ok((await s.get(`/address/${BOB}`)).body.includes("<span>Transactions</span><strong>30</strong>"));
  // The API answers keep their shape.
  const json = (await s.get(`/api/v1/token/${TOKEN}`)).json();
  assert.deepEqual([json.holders, json.transfers], ["10000", "10000"]);
  assert.equal((await s.get(`/api/v1/address/${CAROL}`)).json().transactions, "10000");
  await s.close();
});

const bridge = parseAbi([
  "event ERC20BridgeFinalized(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)",
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
  "function relayMessage(uint256 nonce, address sender, address target, uint256 value, uint256 minGasLimit, bytes message) payable",
  "function finalizeBridgeERC20(address localToken, address remoteToken, address from, address to, uint256 amount, bytes extraData)",
]);
/** The token, the messenger and the bridge on BSC. */
const BSC_TOKEN = "0x00000000000000000000000000000000000b5c01" as Hex;
const BSC_MESSENGER = "0x00000000000000000000000000000000000b5c02" as Hex;
const BSC_BRIDGE = "0x00000000000000000000000000000000000b5c03" as Hex;

/** ERC20BridgeFinalized for `amount` of the token, as `emitter` writes it. */
const finalized = (emitter: string, amount: bigint): Log => ({
  address: emitter as Hex,
  topics: encodeEventTopics({ abi: bridge, eventName: "ERC20BridgeFinalized", args: { localToken: TOKEN, remoteToken: BSC_TOKEN, from: ALICE } }) as Hex[],
  data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [BOB, amount, "0x"]),
});
/** MessagePassed, as the message passer writes it for a call from `sender`. */
const passed = (sender: string, value: bigint, data: Hex): Log => ({
  address: MESSAGE_PASSER as Hex,
  topics: encodeEventTopics({ abi: bridge, eventName: "MessagePassed", args: { nonce: 1n, sender: sender as Hex, target: BSC_MESSENGER } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }], [value, 100_000n, data, pad(9n)]),
});
/** The messenger's message to BSC for a message from `sender` that releases `amount` of the token there. */
const release = (sender: string, amount: bigint) => encodeFunctionData({
  abi: bridge,
  functionName: "relayMessage",
  args: [1n, sender as Hex, BSC_BRIDGE, 0n, 200_000n, encodeFunctionData({ abi: bridge, functionName: "finalizeBridgeERC20", args: [BSC_TOKEN, TOKEN, ALICE, BOB, amount, "0x"] })],
});

test("the bridge page shows what each deposit and withdrawal carried", async () => {
  const chain = new FakeChain(true);
  chain.add([]);
  const coin = hex(2n * 10n ** 18n);
  const deposit = (o: Partial<RawTx>): Partial<RawTx> => ({ type: "0x7e", from: CAROL, gasPrice: "0x0", sourceHash: pad(1n), mint: "0x0", ...o });
  const [dCoin, dToken, dMessage, dForged, dBoth] = addBlock(chain, [
    { tx: deposit({ to: BOB, value: coin, mint: coin }) },
    { tx: deposit({ to: L2_MESSENGER as Hex }), logs: [transfer(ZERO, BOB, 5_000_000n), finalized(L2_BRIDGE, 5_000_000n)] },
    { tx: deposit({ to: CAROL }) },
    // The event, but not written by the bridge.
    { tx: deposit({ to: ALICE }), logs: [finalized(CAROL, 9_000_000n)] },
    { tx: deposit({ to: L2_MESSENGER as Hex, value: coin, mint: coin }), logs: [finalized(L2_BRIDGE, 3_500_000n)] },
  ]) as [Hex, Hex, Hex, Hex, Hex];
  const [wCoin, wToken, wMessage, wForged, wImitated] = addBlock(chain, [
    { logs: [passed(ALICE, 10n ** 18n, "0x")] },
    { logs: [passed(L2_MESSENGER, 0n, release(L2_BRIDGE, 7_000_000n))] },
    { logs: [passed(CAROL, 0n, "0x1234")] },
    // The bridge's message, but passed by someone who is not the messenger...
    { logs: [passed(CAROL, 0n, release(L2_BRIDGE, 8_000_000n))] },
    // ...or sent through the messenger by someone who is not the bridge.
    { logs: [passed(L2_MESSENGER, 0n, release(CAROL, 8_000_000n))] },
  ]) as [Hex, Hex, Hex, Hex, Hex];
  const s = await serve(chain);

  const res = await s.get("/bridge");
  assert.equal(res.statusCode, 200);
  const item = (hash: string) => res.body.split("<li>").find((li) => li.includes(hash))!.split("</li>")[0]!;
  const token = (amount: string) => `<span class="num">${amount}</span> <a href="/token/${TOKEN}">tUSD</a>`;
  const message = `<span><span class="muted">Message</span></span></span>`;

  assert.ok(item(dCoin).includes(`<span><span class="num">2 tBNB</span></span></span>`));
  assert.ok(item(dToken).includes(`<span>${token("5")}</span></span>`));
  assert.ok(item(dMessage).includes(message));
  assert.ok(item(dForged).includes(message));
  assert.ok(item(dBoth).includes(`<span><span class="num">2 tBNB</span> + ${token("3.5")}</span></span>`));

  assert.ok(item(wCoin).includes(`<span><span class="num">1 tBNB</span></span></span>`));
  assert.ok(item(wToken).includes(`<span>${token("7")}</span></span>`));
  assert.ok(item(wMessage).includes(message));
  assert.ok(item(wForged).includes(message));
  assert.ok(item(wImitated).includes(message));
  assert.ok(!/>0 tBNB/.test(res.body), "nothing is shown as 0 tBNB");

  await s.close();

  // The same reading, on the rows as the database returns them.
  const row = ({ address, topics, data }: Log) => ({ address, topic0: topics[0] ?? null, topic1: topics[1] ?? null, topic2: topics[2] ?? null, topic3: topics[3] ?? null, data });
  assert.deepEqual(bridgedToken(row(finalized(L2_BRIDGE, 12n))), { token: TOKEN, amount: 12n });
  assert.deepEqual(bridgedToken(row(passed(L2_MESSENGER, 0n, release(L2_BRIDGE, 12n)))), { token: TOKEN, amount: 12n });
  assert.equal(bridgedToken(row(finalized(CAROL, 12n))), null);
  assert.equal(bridgedToken(row(passed(L2_MESSENGER, 5n, "0x"))), null);
  assert.equal(bridgedToken(row(transfer(ALICE, BOB, 12n))), null);
});

test("the API page says what the stats answer holds", async () => {
  const chain = new FakeChain();
  chain.add([]);
  const s = await serve(chain);
  const docs = (await s.get("/api-docs")).body;
  assert.ok(docs.includes(`<td class="mono">GET /api/v1/stats</td><td>Height, base fee, transaction count, token count, block time</td>`));
  assert.ok(!/gas price/i.test(docs));
  const stats = (await s.get("/api/v1/stats")).json();
  assert.deepEqual(Object.keys(stats).sort(), ["blockTime", "head", "tokens", "transactions"]);
  assert.deepEqual(Object.keys(stats.head).sort(), ["base_fee", "number", "timestamp"]);
  await s.close();
});

test("lists carry at most 4,096 bytes of a transaction's input data and of an event's data", async () => {
  const chain = new FakeChain();
  chain.add([]);
  const bytes = (byte: string, n: number) => `0x${byte.repeat(n)}` as Hex;
  const unknown = (n: number): Log => ({ address: CAROL, topics: [pad(1n)], data: bytes("ef", n) });
  const [long, exact] = addBlock(chain, [
    { tx: { input: bytes("ab", 5000) }, logs: [unknown(5000), transfer(ALICE, BOB, 1n), passed(ALICE, 10n ** 18n, bytes("ee", 5000))] },
    { tx: { input: bytes("cd", 4096) }, logs: [unknown(4096)] },
    { tx: { input: "0xa9059cbb" } },
  ]) as [Hex, Hex, Hex];
  const s = await serve(chain);

  const list = (await s.get(`/api?module=account&action=txlist&address=${ALICE}`)).json().result as { input: string }[];
  assert.deepEqual(list.map((t) => t.input), [bytes("ab", 4096), bytes("cd", 4096), "0xa9059cbb"]);

  // The transaction itself gives its input whole. Its events are cut the same way and say how long they are.
  const json = (await s.get(`/api/v1/tx/${long}`)).json();
  assert.equal(json.input, bytes("ab", 5000));
  assert.deepEqual([json.logs[0].data, json.logs[0].data_bytes, json.logs[0].decoded], [bytes("ef", 4096), 5000, null]);
  assert.deepEqual([json.logs[1].data, json.logs[1].data_bytes, json.logs[1].decoded.name], [pad(1n), 32, "Transfer"]);
  // An event that is known but was cut is given undecoded, never with values read from half of it.
  assert.deepEqual([json.logs[2].data.length, json.logs[2].data_bytes > 5000, json.logs[2].decoded], [2 + 2 * 4096, true, null]);
  const whole = (await s.get(`/api/v1/tx/${exact}`)).json().logs[0];
  assert.deepEqual([whole.data, whole.data_bytes], [bytes("ef", 4096), 4096]);

  const page = await s.get(`/tx/${long}`);
  assert.equal(page.statusCode, 200);
  assert.ok(!page.body.includes("ef".repeat(4097)) && !page.body.includes("ee".repeat(4097)));
  // The bridge page reads withdrawals the same way: one with a message that long is listed, without its amount.
  const [withdrawal] = await Q.withdrawals(s.db, 20);
  assert.deepEqual([withdrawal?.tx_hash, withdrawal?.data.length, withdrawal?.data_bytes], [long, 2 + 2 * 4096, json.logs[2].data_bytes]);
  assert.equal(bridgedToken(withdrawal!), null);
  assert.equal((await s.get("/bridge")).statusCode, 200);
  await s.close();
});

test("a page of the Etherscan transaction list holds 100 transactions at most, and page numbers and sizes are whole numbers", async () => {
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ALICE, to: BOB, amount: 1n }]);
  const s = await serve(chain);
  // 250 transactions of Carol's and 250 transfers of the token to her, written straight to the database.
  await s.db.query(
    `INSERT INTO transactions (hash, block_number, tx_index, timestamp, from_address, to_address, value, nonce, type, gas_limit, input)
     SELECT '0x' || lpad(to_hex(g), 64, '0'), 1, g, 0, $1::text, $1::text, 0, g, 2, 21000, '0x' FROM generate_series(1000, 1249) g`,
    [CAROL],
  );
  await s.db.query(
    `INSERT INTO token_transfers (block_number, log_index, tx_hash, timestamp, token, from_address, to_address, value)
     SELECT 1, g, $2::text, 0, $1::text, $3::text, $3::text, 1 FROM generate_series(1000, 1249) g`,
    [TOKEN, pad(1n), CAROL],
  );
  /** Where in the block each row of an Etherscan list is. */
  const list = async (action: string, rest = "") => {
    const r = await s.get(`/api?module=account&action=${action}&address=${CAROL}${rest}`);
    assert.equal(r.statusCode, 200, `${action}${rest}`);
    return (r.json().result as { transactionIndex?: string; logIndex?: string }[]).map((x) => Number(x.transactionIndex ?? x.logIndex));
  };
  const run = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

  assert.deepEqual(await list("txlist"), run(1000, 100));
  assert.deepEqual(await list("txlist", "&offset=1000"), run(1000, 100));
  assert.deepEqual(await list("txlist", "&offset=1000&page=3"), run(1200, 50));
  assert.deepEqual(await list("txlist", "&offset=30&page=2"), run(1030, 30));
  // Transfers carry no calldata and keep their 1,000 a page.
  assert.deepEqual(await list("tokentx", "&offset=1000"), run(1000, 250));
  assert.deepEqual(await list("tokentx", "&offset=10&page=2"), run(1010, 10));

  // Anything that is not a whole number is taken as if it were not given.
  for (const action of ["txlist", "tokentx"]) {
    for (const rest of ["&page=1.5", "&offset=10.5", "&page=1.5&offset=10.5", "&offset=1e1", "&page=0x2", "&offset=-5", "&page=two", "&offset=", "&page=%201", "&offset=0", "&page=2&page=3"]) {
      assert.deepEqual(await list(action, rest), run(1000, 100), `${action}${rest}`);
    }
  }
  // The pages' own page number: a fraction is the first page.
  for (const url of ["/txs?p=1.5", "/blocks?p=2.5", "/tokens?p=0.5", `/address/${CAROL}?p=1.5`, `/api/v1/address/${CAROL}/txs?p=1.5`, `/api/v1/token/${TOKEN}/holders?p=1.5`]) {
    assert.equal((await s.get(url)).statusCode, 200, url);
  }
  await s.close();
});

test("the token list is read once in 10 seconds for a page, by the side of the database that has a time limit", async (t) => {
  // The clock the server reads, moved by hand.
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ZERO, to: ALICE, amount: 5n }]);
  // A database with a time-limited side, as Postgres has: what is asked of each side is counted.
  const limits: number[] = [];
  let lists = 0;
  let unlimited = 0;
  const s = await serve(chain, {}, (db) => ({
    ...db,
    query: <T>(sql: string, params?: unknown[]) => {
      unlimited++;
      return db.query<T>(sql, params);
    },
    timed: (ms) => {
      limits.push(ms);
      return {
        query: <T>(sql: string, params?: unknown[]) => {
          if (sql.includes("ORDER BY holders DESC")) lists++;
          return db.query<T>(sql, params);
        },
      };
    },
  }));
  assert.equal(s.db.timed, undefined, "PGlite cannot cancel a statement and has no such side");

  // The page and the API answer, asked together and again: one reading.
  const first = await Promise.all([s.get("/tokens"), s.get("/tokens"), s.get("/api/v1/tokens"), s.get("/api/v1/tokens?p=1")]);
  for (const r of first) assert.equal(r.statusCode, 200);
  assert.deepEqual(first[2]!.json().map((x: { address: string }) => x.address), [TOKEN]);
  assert.equal(lists, 1);

  // A token that appears meanwhile is on the list when the 10 seconds are over.
  await s.db.query("INSERT INTO tokens (address, kind, first_block) VALUES ($1, 'erc20', 1)", [CAROL]);
  now += 9_999;
  assert.equal((await s.get("/api/v1/tokens")).json().length, 1);
  assert.equal(lists, 1);
  now += 1;
  assert.deepEqual((await s.get("/api/v1/tokens")).json().map((x: { address: string }) => x.address), [TOKEN, CAROL]);
  assert.equal((await s.get("/tokens")).statusCode, 200);
  assert.equal(lists, 2);

  // Each page of the list is held on its own.
  assert.deepEqual((await s.get("/api/v1/tokens?p=2")).json(), []);
  assert.equal((await s.get("/tokens?p=2")).statusCode, 200);
  assert.equal(lists, 3);

  // Every query of the server's went to the limited side, which it asked for once, with 5 seconds.
  await s.get("/");
  await s.get(`/api?module=account&action=txlist&address=${ALICE}`);
  assert.deepEqual([limits, unlimited], [[5000], 0]);
  await s.close();
});

test("Postgres is told the time limit as each of the visitors' connections opens, and the indexer's have none", async () => {
  // A server that notes what a connection asks for as it opens, and refuses it.
  const opened: Record<string, string>[] = [];
  const nul = String.fromCharCode(0);
  const refusal = Buffer.from(["SFATAL", "C28000", "Mrefused", nul].join(nul));
  const length = Buffer.alloc(4);
  length.writeInt32BE(4 + refusal.length);
  const server = createServer((socket) => {
    socket.once("data", (startup) => {
      const fields = startup.subarray(8).toString("utf8").split(nul);
      const asked: Record<string, string> = {};
      for (let i = 0; fields[i]; i += 2) asked[fields[i]!] = fields[i + 1] ?? "";
      opened.push(asked);
      socket.end(Buffer.concat([Buffer.from("E"), length, refusal]));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };

  const db = createPgDb(`postgres://explorer:secret@127.0.0.1:${port}/explorer`);
  await assert.rejects(db.query("SELECT 1"), /refused/);
  await assert.rejects(db.timed!(5_000).query("SELECT 1"), /refused/);
  await assert.rejects(db.tx((q) => q.query("SELECT 1")), /refused/);
  assert.deepEqual(opened.map((o) => [o.user, o.database, o.statement_timeout]), [["explorer", "explorer", undefined], ["explorer", "explorer", "5000"], ["explorer", "explorer", undefined]]);
  await db.close();
  await new Promise((done) => server.close(done));
});

test("the home page shows the chain at a glance: figures, a chart of 14 days, the latest of each list and LONGYU's links", async (t) => {
  // The server's clock, ten minutes after the fake chain's first block and in the same UTC day.
  t.mock.method(Date, "now", () => (Number(GENESIS_TIME) + 600) * 1000);
  const chain = new FakeChain();
  chain.add([]);
  for (let i = 0; i < 9; i++) chain.add([{ from: ZERO, to: ALICE, amount: 1n }]);
  chain.add([{ from: ALICE, to: BOB, amount: 1n }, { from: ALICE, to: CAROL, amount: 1n }]);
  const s = await serve(chain, {
    PUBLIC_RPC_URL: "https://rpc.example", SWAP_URL: "https://pages.example/swap.html",
    WEBSITE_URL: "https://www.example", MINE_URL: "https://mine.example", GITHUB_URL: "https://code.example/chain",
    DEVELOPERS_URL: "https://www.example/developers",
  });

  const home = (await s.get("/")).body;
  assert.ok(home.includes(`<section class="hero"><div class="wrap">\n    <h1>LONGYU Testnet Explorer</h1>`));
  assert.equal(count(home, `<form class="search"`), 1, "the search is in the hero, not also in the header");
  assert.ok(home.includes(`<span id="stat-height">10</span>`));
  assert.ok(home.includes(`<div><span>Transactions</span><strong>11 <small>11 in 24 h</small></strong></div>`));
  // One bar a day: the 13 days before the chain began are marks on the baseline.
  assert.equal(count(home, `<rect class="bar`), 14);
  assert.equal(count(home, `<rect class="bar zero"`), 13);
  assert.ok(home.includes(`<title>14 Nov: 11</title>`));
  assert.ok(home.includes(`Most in a day <strong>11</strong>`));
  const list = (id: string) => home.split(`id="${id}"`)[1]!.split("</ul>")[0]!;
  assert.equal(count(list("feed-blocks"), "<li>"), 7);
  assert.equal(count(list("feed-txs"), "<li>"), 7);
  assert.ok(list("feed-blocks").includes(`<span>2 txns</span>`) && list("feed-blocks").includes(`<span>1 txn</span>`));
  assert.ok(home.includes(`<a class="more" href="/blocks">View all blocks</a>`) && home.includes(`<a class="more" href="/txs">View all transactions</a>`));
  const feed = (await s.get("/api/v1/home")).json();
  assert.deepEqual([feed.blocks.length, feed.txs.length], [7, 7]);

  // The wallet button carries what a wallet needs to add the chain.
  assert.ok(home.includes(`id="add-network" data-chain-id="668801" data-chain-name="LONGYU Testnet" data-rpc="https://rpc.example" data-symbol="tBNB">Add LONGYU Testnet to wallet</button>`));
  // LONGYU's other pages are linked from the phone menu and from the footer.
  for (const link of [
    `<a href="https://pages.example/swap.html" rel="noopener">Swap</a>`, `<a href="https://mine.example" rel="noopener">Mining app</a>`,
    `<a href="https://www.example" rel="noopener">Website</a>`, `<a href="https://code.example/chain" rel="noopener">GitHub</a>`,
    `<a href="https://www.example/developers" rel="noopener">Developer guide</a>`,
  ]) assert.equal(count(home, link), 2, link);

  // Other pages have the search in the header and their entry in the menu marked.
  const blocks = (await s.get("/blocks")).body;
  assert.ok(!blocks.includes(`class="hero"`));
  assert.equal(count(blocks, `<form class="search"`), 1);
  assert.ok(blocks.includes(`<a href="/blocks" class="on" aria-current="page">Blocks</a>`));
  assert.ok((await s.get("/api-docs")).body.includes(`<a href="/api-docs" class="on" aria-current="page">API</a>`));
  assert.equal(count(home, `class="on"`), 0);
  await s.close();

  // Without those settings there is no wallet button and no link to pages that were not named.
  const bare = await serve(chain);
  const plain = (await bare.get("/")).body;
  for (const piece of ["add-network", "Mining app", "Website", "GitHub", "Developer guide", ">Swap<"]) assert.ok(!plain.includes(piece), piece);
  await bare.close();
  for (const name of ["WEBSITE_URL", "MINE_URL", "DEVELOPERS_URL", "GITHUB_URL"]) {
    assert.throws(() => ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", [name]: "http://plain.example" }), name);
  }
});

test("the home page still goes out when its counts by day cannot be read", async (t) => {
  t.mock.method(Date, "now", () => (Number(GENESIS_TIME) + 600) * 1000);
  const chain = new FakeChain();
  chain.add([]);
  chain.add([{ from: ZERO, to: ALICE, amount: 1n }]);
  const s = await serve(chain, {}, (db) => ({
    ...db,
    query: <T>(sql: string, params?: unknown[]) => (/daily_transactions|timestamp > /.test(sql) ? Promise.reject(new Error("canceling statement due to statement timeout")) : db.query<T>(sql, params)),
  }));
  const res = await s.get("/");
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes(`<div><span>Transactions</span><strong>1</strong></div>`));
  assert.equal(count(res.body, `<rect class="bar zero"`), 14);
  await s.close();
});
