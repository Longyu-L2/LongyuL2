import test from "node:test";
import assert from "node:assert/strict";
import { createCache } from "./cache.ts";

/** A fetcher whose answers are given by hand, in the order the requests were made. */
function remote() {
  const calls: { key: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const fetcher = (key: string) => new Promise<unknown>((resolve, reject) => calls.push({ key, resolve, reject }));
  return { calls, fetcher };
}
const settle = () => new Promise((r) => setImmediate(r));

test("an answer is kept, and asked for again only once it is stale", async () => {
  const { calls, fetcher } = remote();
  let clock = 1000;
  const kept: [string, unknown][] = [];
  const cache = createCache(fetcher, { fresh: 5000, now: () => clock, onData: (key, data) => kept.push([key, data]) });
  assert.deepEqual(cache.get("/a"), { data: undefined, error: null, loading: false, at: 0 });

  const first = cache.load("/a");
  assert.equal(cache.get("/a").loading, true);
  calls[0]!.resolve({ n: 1 });
  await first;
  assert.deepEqual(cache.get("/a"), { data: { n: 1 }, error: null, loading: false, at: 1000 });
  assert.deepEqual(kept, [["/a", { n: 1 }]]);

  clock += 4999;
  await cache.load("/a");
  assert.equal(calls.length, 1);
  clock += 1;
  const again = cache.load("/a");
  // What is held stays on the page while the next answer is on its way.
  assert.deepEqual(cache.get("/a"), { data: { n: 1 }, error: null, loading: true, at: 1000 });
  calls[1]!.resolve({ n: 2 });
  await again;
  assert.deepEqual(cache.get<{ n: number }>("/a").data, { n: 2 });
});

test("the entry is the same object until it changes, and listeners hear each change", async () => {
  const { calls, fetcher } = remote();
  const cache = createCache(fetcher);
  let heard = 0;
  const stop = cache.subscribe("/a", () => heard++);
  let other = 0;
  cache.subscribe("/b", () => other++);
  assert.equal(cache.get("/a"), cache.get("/a"));
  const load = cache.load("/a");
  const loading = cache.get("/a");
  assert.equal(cache.get("/a"), loading);
  calls[0]!.resolve(1);
  await load;
  assert.notEqual(cache.get("/a"), loading);
  assert.equal(cache.get("/a"), cache.get("/a"));
  assert.equal(heard, 2);
  assert.equal(other, 0);
  stop();
  await Promise.all([cache.load("/a", true), settle().then(() => calls[1]!.resolve(2))]);
  assert.equal(heard, 2);
});

test("requests for the same path share one flight; a forced one asks again after it", async () => {
  const { calls, fetcher } = remote();
  const cache = createCache(fetcher);
  const a = cache.load("/a");
  const b = cache.load("/a");
  assert.equal(calls.length, 1);
  const forced = cache.load("/a", true);
  assert.equal(calls.length, 1);
  calls[0]!.resolve("before");
  await Promise.all([a, b]);
  await settle();
  assert.equal(calls.length, 2);
  calls[1]!.resolve("after");
  await forced;
  assert.equal(cache.get("/a").data, "after");
  // Different paths do not wait for each other.
  void cache.load("/b");
  void cache.load("/c");
  assert.deepEqual(calls.slice(2).map((c) => c.key), ["/b", "/c"]);
});

test("a failure keeps what was held, and the next try clears it", async () => {
  const { calls, fetcher } = remote();
  let clock = 0;
  const cache = createCache(fetcher, { fresh: 10, now: () => clock });
  const miss = cache.load("/a");
  calls[0]!.reject(new Error("offline"));
  await miss;
  assert.equal(cache.get("/a").data, undefined);
  assert.equal((cache.get("/a").error as Error).message, "offline");
  assert.equal(cache.get("/a").loading, false);

  const ok = cache.load("/a");
  calls[1]!.resolve("x");
  await ok;
  assert.deepEqual([cache.get("/a").data, cache.get("/a").error], ["x", null]);

  clock = 100;
  const down = cache.load("/a");
  calls[2]!.reject(new Error("down"));
  await down;
  assert.deepEqual([cache.get("/a").data, (cache.get("/a").error as Error).message, cache.get("/a").at], ["x", "down", 0]);
});

test("clearing forgets everything, and an answer still on its way is dropped", async () => {
  const { calls, fetcher } = remote();
  const kept: string[] = [];
  const cache = createCache(fetcher, { onData: (key) => kept.push(key) });
  const done = cache.load("/a");
  calls[0]!.resolve("mine");
  await done;
  let heard = 0;
  cache.subscribe("/a", () => heard++);

  const late = cache.load("/a", true);
  cache.clear();
  assert.equal(cache.get("/a").data, undefined);
  assert.ok(heard >= 1);
  calls[1]!.resolve("someone else's");
  await late;
  assert.deepEqual(cache.get("/a"), { data: undefined, error: null, loading: false, at: 0 });
  assert.deepEqual(kept, ["/a"]);

  // The next account starts a request of its own.
  const next = cache.load("/a");
  assert.equal(calls.length, 3);
  calls[2]!.resolve("theirs");
  await next;
  assert.equal(cache.get("/a").data, "theirs");
});
