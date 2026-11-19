/**
 * Behind Cloudflare: only requests that came through it are served, and each visitor has their own
 * rate limit, counted by the address Cloudflare reports (an IPv6 visitor by their /64 network). The
 * health check, which is served to anyone, costs the database and the node one question in 5 seconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, clientKey } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgliteDb, migrate, type Db } from "../src/db.ts";
import { Indexer } from "../src/indexer.ts";
import { FakeChain } from "./fake-chain.ts";

const SECRET = "s".repeat(40);

async function makeApp(env: Record<string, string>) {
  const db = await createPgliteDb();
  await migrate(db);
  const config = ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", NODE_ENV: "test", ...env });
  return buildApp({ db, rpc: new FakeChain(true), config });
}

test("with ORIGIN_SECRET, a request that did not come through Cloudflare is refused", async () => {
  const app = await makeApp({ ORIGIN_SECRET: SECRET });
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

  assert.equal((await get("/blocks")).statusCode, 403);
  assert.deepEqual((await get("/api/v1/stats")).json(), { error: "origin_required" });
  assert.equal((await get("/blocks", { "x-longyu-origin": "s".repeat(39) })).statusCode, 403);
  assert.equal((await get("/blocks", { "x-longyu-origin": "t".repeat(40) })).statusCode, 403);
  assert.equal((await get("/static/app.css")).statusCode, 403);
  // The platform's health check has no header.
  assert.equal((await get("/health")).statusCode, 200);
  assert.equal((await get("/health?x=1")).statusCode, 403);
  assert.equal((await get("/blocks", { "x-longyu-origin": SECRET })).statusCode, 200);
});

test("with ORIGIN_SECRET, each visitor has their own rate limit", async () => {
  const app = await makeApp({ ORIGIN_SECRET: SECRET, RATE_LIMIT: "10" });
  const from = (ip: string) => app.inject({ method: "GET", url: "/blocks", headers: { "x-longyu-origin": SECRET, "cf-connecting-ip": ip } });

  for (let i = 0; i < 10; i++) assert.equal((await from("203.0.113.7")).statusCode, 200);
  assert.equal((await from("203.0.113.7")).statusCode, 429);
  assert.equal((await from("203.0.113.8")).statusCode, 200);
});

test("without ORIGIN_SECRET, the headers mean nothing: a visitor cannot pick their own address", async () => {
  const app = await makeApp({ RATE_LIMIT: "10" });
  const from = (ip: string) => app.inject({ method: "GET", url: "/blocks", headers: { "cf-connecting-ip": ip } });

  for (let i = 0; i < 10; i++) assert.equal((await from(`203.0.113.${i}`)).statusCode, 200);
  assert.equal((await from("203.0.113.99")).statusCode, 429);
});

test("a short ORIGIN_SECRET is refused", () => {
  assert.throws(() => ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", ORIGIN_SECRET: "short" }));
});

test("an IPv6 visitor is counted by their /64 network, an IPv4 visitor by their address", async () => {
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey(" 203.0.113.7 "), "203.0.113.7");
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:DB8:0001:0002::9"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
  assert.equal(clientKey("not an address"), null);
  assert.equal(clientKey(""), null);

  const app = await makeApp({ ORIGIN_SECRET: SECRET, RATE_LIMIT: "10" });
  const from = (ip: string) => app.inject({ method: "GET", url: "/blocks", headers: { "x-longyu-origin": SECRET, "cf-connecting-ip": ip } });
  // One subscriber has every address of a /64 to send from: ten of them use up one limit.
  for (let i = 1; i <= 10; i++) assert.equal((await from(`2001:db8:1:2::${i}`)).statusCode, 200);
  assert.equal((await from("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).statusCode, 429);
  assert.equal((await from("2001:DB8:1:2::1")).statusCode, 429);
  assert.equal((await from("2001:db8:1:3::1")).statusCode, 200);
  // An IPv4 address written inside IPv6 is that IPv4 address, and its neighbour is someone else.
  for (let i = 0; i < 10; i++) assert.equal((await from("::ffff:203.0.113.7")).statusCode, 200);
  assert.equal((await from("203.0.113.7")).statusCode, 429);
  assert.equal((await from("203.0.113.8")).statusCode, 200);

  // The same without Cloudflare, by the address of the connection.
  const direct = await makeApp({ RATE_LIMIT: "10" });
  const connect = (ip: string) => direct.inject({ method: "GET", url: "/blocks", remoteAddress: ip });
  for (let i = 1; i <= 10; i++) assert.equal((await connect(`2001:db8:1:2::${i}`)).statusCode, 200);
  assert.equal((await connect("2001:db8:1:2::ffff")).statusCode, 429);
  assert.equal((await connect("2001:db8:1:3::1")).statusCode, 200);
});

test("/health asks the database and the node once in 5 seconds, however often it is requested", async (t) => {
  // The clock the server reads, moved by hand.
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const db = await createPgliteDb();
  await migrate(db);
  const chain = new FakeChain();
  chain.add([]);
  chain.add([]);
  await new Indexer(db, chain, { startBlock: 0n, batchSize: 10 }).step();
  // Every query the server makes is counted, and fails while `down` is set.
  let queries = 0;
  let down = false;
  const counted: Db = {
    ...db,
    query: <T>(sql: string, params?: unknown[]) => {
      queries++;
      return down ? Promise.reject(new Error("the database is down")) : db.query<T>(sql, params);
    },
  };
  const config = ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", NODE_ENV: "test", ORIGIN_SECRET: SECRET });
  const app = await buildApp({ db: counted, rpc: chain, config });
  const health = () => app.inject({ method: "GET", url: "/health" });
  const indexing = chain.calls.get("eth_blockNumber") ?? 0;
  const asked = () => [queries, (chain.calls.get("eth_blockNumber") ?? 0) - indexing];

  // Fifty at once, with no header and no rate limit: one reading, and the same answer for all.
  const first = await Promise.all(Array.from({ length: 50 }, health));
  for (const r of first) assert.deepEqual([r.statusCode, r.json()], [200, { ok: true, indexed: "1", node: "1", lag: "0" }]);
  assert.deepEqual(asked(), [1, 1]);

  // The answer is given out for 5 seconds; then the next request reads again.
  chain.add([]);
  now += 4_999;
  assert.deepEqual((await health()).json(), { ok: true, indexed: "1", node: "1", lag: "0" });
  assert.deepEqual(asked(), [1, 1]);
  now += 1;
  assert.deepEqual((await health()).json(), { ok: true, indexed: "1", node: "2", lag: "1" });
  assert.deepEqual((await health()).json(), { ok: true, indexed: "1", node: "2", lag: "1" });
  assert.deepEqual(asked(), [2, 2]);

  // A database that fails is not asked more often either, and the check fails as it did.
  down = true;
  now += 5_000;
  for (const r of await Promise.all([health(), health(), health()])) assert.equal(r.statusCode, 500);
  assert.equal((await health()).statusCode, 500);
  assert.equal(queries, 3);
  down = false;
  now += 5_000;
  assert.deepEqual([(await health()).statusCode, queries], [200, 4]);
  await app.close();
  await db.close();
});
