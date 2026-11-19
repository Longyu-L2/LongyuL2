/** Runs the gateway against a stand-in node over real HTTP. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, type Config } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";

type Call = { jsonrpc: string; id: unknown; method: string; params?: unknown[] };

/**
 * A stand-in node: records each request body and answers every call with its method name. Like the
 * real node, it reads the method without regard to the key's case and lets the last match win.
 */
const seen: string[] = [];
const methodOf = (c: object) => String(Object.entries(c).reduce<unknown>((found, [k, v]) => (k.toLowerCase() === "method" ? v : found), undefined));
let nodeDelayMs = 0;
let nodeAnswerBytes = 0;
const node = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push(body);
    // The id is copied from the request text, as a real node would, so numbers of any size survive.
    const one = (c: Call, rawId: string, method = methodOf(c)) =>
      method === "eth_blockNumber" ? `{"jsonrpc":"2.0","id":${rawId},"result":"0x3e8"}`
      : method === "eth_call" && nodeAnswerBytes ? `{"jsonrpc":"2.0","id":${rawId},"result":"0x${"00".repeat(nodeAnswerBytes)}"}`
      : method === "eth_estimateGas" ? `{"jsonrpc":"2.0","id":${rawId},"error":{"code":3,"message":"execution reverted","data":"0x08c379a0"}}`
      : `{"jsonrpc":"2.0","id":${rawId},"result":"${method}"}`;
    const parsed = JSON.parse(body) as Call | Call[];
    const rawIds = [...body.matchAll(/"id"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\s]+)/g)].map((m) => m[1]!);
    const out = Array.isArray(parsed) ? `[${parsed.map((c, i) => one(c, rawIds[i]!)).join(",")}]` : one(parsed, rawIds[0]!);
    setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(out), nodeDelayMs);
  });
});

const servers: Server[] = [node];
let nodeUrl = "";
let clock = 1_000_000;

async function gateway(overrides: Record<string, string> = {}, upstream = nodeUrl, log: (line: string) => void = () => {}): Promise<{ url: string; config: Config }> {
  const config = loadConfig({ UPSTREAM_URL: upstream, CHAIN_ID: "668801", ...overrides });
  const g = createGateway(config, { now: () => clock, log });
  const server = createServer((req, res) => void g.handle(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, config };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any, headers: res.headers };
}
const call = (method: string, params: unknown[] = [], id: unknown = 1) => ({ jsonrpc: "2.0", id, method, params });

before(async () => {
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  nodeUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}/`;
});
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

test("a served request reaches the node as a fresh encoding of what was checked; the answer passes through", async () => {
  const { url } = await gateway();
  seen.length = 0;
  // The client's own spacing and key order stay here; the largest whole number an id can be survives.
  const body = '{ "params":["0x0000000000000000000000000000000000000001","latest"], "method":"eth_getBalance", "id": 9007199254740991, "jsonrpc":"2.0" }';
  const r = await post(url, body);
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['{"jsonrpc":"2.0","id":9007199254740991,"method":"eth_getBalance","params":["0x0000000000000000000000000000000000000001","latest"]}']);
  assert.equal(r.text, '{"jsonrpc":"2.0","id":9007199254740991,"result":"eth_getBalance"}');
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(r.headers.get("cache-control"), "no-store");

  // The node's own errors (a revert with its data) reach the caller unchanged.
  const reverted = await post(url, call("eth_estimateGas", [{}], "q"));
  assert.deepEqual(reverted.json, { jsonrpc: "2.0", id: "q", error: { code: 3, message: "execution reverted", data: "0x08c379a0" } });

  // An id that cannot be repeated exactly (too large, a fraction, not a string or number) is refused here.
  seen.length = 0;
  for (const id of ["90071992547409931234", "1.5", "{}", "[1]", "true"]) {
    const refused = await post(url, `{"jsonrpc":"2.0","id":${id},"method":"eth_blockNumber","params":[]}`);
    assert.equal(refused.status, 200);
    assert.deepEqual([refused.json.id, refused.json.error.code], [null, -32600], id);
    assert.match(refused.json.error.message, /id must be a string or a whole number/);
  }
  assert.equal(seen.length, 0);
});

test("the chain's identity is answered without the node", async () => {
  const { url } = await gateway();
  seen.length = 0;
  assert.deepEqual((await post(url, call("eth_chainId", [], 5))).json, { jsonrpc: "2.0", id: 5, result: "0xa3481" });
  assert.deepEqual((await post(url, call("net_version", [], "n"))).json, { jsonrpc: "2.0", id: "n", result: "668801" });
  assert.deepEqual((await post(url, call("web3_clientVersion", [], null))).json, { jsonrpc: "2.0", id: null, result: "LONGYU" });
  assert.equal(seen.length, 0);
});

test("the chain's identity is answered without the node inside a batch too", async () => {
  const { url } = await gateway();
  // A batch of nothing else does not reach the node at all.
  seen.length = 0;
  const all = await post(url, [call("web3_clientVersion", [], "v"), call("eth_chainId", [], 2), call("net_version", [], null), call("web3_clientVersion", [], 2)]);
  assert.equal(all.status, 200);
  assert.deepEqual(all.json, [
    { jsonrpc: "2.0", id: "v", result: "LONGYU" },
    { jsonrpc: "2.0", id: 2, result: "0xa3481" },
    { jsonrpc: "2.0", id: null, result: "668801" },
    { jsonrpc: "2.0", id: 2, result: "LONGYU" },
  ]);
  assert.equal(seen.length, 0);

  // Among other requests each keeps its place and its id, and the node is sent only what it must answer.
  const mixed = await post(url, [
    call("eth_blockNumber", [], 1),
    call("web3_clientVersion", [], 2),
    call("debug_setHead", ["0x0"], 3),
    call("eth_chainId", [], 1),
    call("eth_estimateGas", [{}], "e"),
    call("net_version", [], 0),
    { jsonrpc: "2.0", id: 6, method: "eth_gasPrice" },
  ]);
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.json, [
    { jsonrpc: "2.0", id: 1, result: "0x3e8" },
    { jsonrpc: "2.0", id: 2, result: "LONGYU" },
    { jsonrpc: "2.0", id: 3, error: { code: -32601, message: "the method debug_setHead is not available on this endpoint" } },
    { jsonrpc: "2.0", id: 1, result: "0xa3481" },
    { jsonrpc: "2.0", id: "e", error: { code: 3, message: "execution reverted", data: "0x08c379a0" } },
    { jsonrpc: "2.0", id: 0, result: "668801" },
    { jsonrpc: "2.0", id: 6, result: "eth_gasPrice" },
  ]);
  assert.deepEqual(seen, ['[{"jsonrpc":"2.0","id":0,"method":"eth_blockNumber","params":[]},{"jsonrpc":"2.0","id":4,"method":"eth_estimateGas","params":[{}]},{"jsonrpc":"2.0","id":6,"method":"eth_gasPrice"}]']);

  // With one request for the node, in the order wallets and libraries send them at start.
  seen.length = 0;
  const pair = await post(url, [call("eth_chainId", [], 1), call("eth_blockNumber", [], 2)]);
  assert.deepEqual(pair.json, [{ jsonrpc: "2.0", id: 1, result: "0xa3481" }, { jsonrpc: "2.0", id: 2, result: "0x3e8" }]);
  assert.deepEqual(seen, ['[{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}]']);

  // A request without an id is refused as everywhere else and gets no result; so is one this endpoint would refuse alone.
  seen.length = 0;
  const refused = await post(url, '[{"jsonrpc":"2.0","method":"web3_clientVersion"},{"jsonrpc":"2.0","id":1.5,"method":"eth_chainId"},{"jsonrpc":"2.0","id":3,"method":"web3_clientVersion","Method":"eth_blockNumber"},{"jsonrpc":"2.0","id":4,"method":"web3_clientVersion","params":{}}]');
  assert.deepEqual(refused.json.map((a: any) => [a.id, a.error?.code, "result" in a]), [[null, -32600, false], [null, -32600, false], [3, -32600, false], [4, -32602, false]]);
  assert.equal(seen.length, 0);
});

test("answers given here count against the allowance and need no free place at the node, in a batch as alone", async () => {
  const { url } = await gateway({ RATE_PER_SECOND: "1", RATE_BURST: "8", MAX_BATCH: "2", MAX_IN_FLIGHT_PER_CLIENT: "1" });
  const a = { "x-real-ip": "203.0.113.90" };
  const both = [call("web3_clientVersion", [], 1), call("eth_chainId", [], 2)];
  nodeDelayMs = 300;
  try {
    const slow = post(url, call("eth_gasPrice"), a); // costs 1
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await post(url, [call("eth_blockNumber", [], 1), call("eth_chainId", [], 2)], a)).status, 429, "one request for the node at a time"); // 2
    seen.length = 0;
    assert.deepEqual((await post(url, both, a)).json.map((r: any) => r.result), ["LONGYU", "0xa3481"]); // 2
    assert.equal((await post(url, both, a)).status, 200); // 2
    const limited = await post(url, both, a); // 2, only 1 left
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json.map((r: any) => [r.id, r.error.code]), [[1, -32005], [2, -32005]]);
    assert.equal(seen.length, 0);
    assert.equal((await slow).status, 200);
  } finally {
    nodeDelayMs = 0;
  }
});

test("the access log names served methods only; any other name is cut down to a few plain characters", async () => {
  const lines: string[] = [];
  const { url } = await gateway({ ACCESS_LOG: "true" }, nodeUrl, (line) => lines.push(line));
  await post(url, call("eth_blockNumber"));
  await post(url, [call("eth_chainId"), call("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]), 7, call("debug_setHead")]);
  assert.deepEqual(lines, ["rpc: 127.0.0.1 200 0ms eth_blockNumber", "rpc: 127.0.0.1 200 0ms eth_chainId,eth_getLogs,?,unserved:debug_setHead"]);

  // A name that carries a line of its own, and one as large as a request may be.
  lines.length = 0;
  const forged = await post(url, call("x\nrpc: 203.0.113.9 200 1ms eth_sendRawTransaction\r\n"));
  assert.equal(forged.json.error.code, -32601);
  await post(url, call("A".repeat(400_000)));
  await post(url, { jsonrpc: "2.0", id: 1, method: `eth_call\n${"b".repeat(100)}`, params: {} });
  await post(url, [1, 2, 3, 4, 5, 6].map((i) => call(`m${i}\u2028${"\n".repeat(1000)},${"c".repeat(1000)}`, [], i)));
  assert.deepEqual(lines, [
    "rpc: 127.0.0.1 200 0ms unserved:xrpc203011392001mseth_sendRawTransaction",
    `rpc: 127.0.0.1 200 0ms unserved:${"A".repeat(40)}`,
    `rpc: 127.0.0.1 200 0ms unserved:eth_call${"b".repeat(32)}`,
    `rpc: 127.0.0.1 200 0ms ${[1, 2, 3, 4, 5].map((i) => `unserved:m${i}${"c".repeat(38)}`).join(",")}`,
  ]);
});

test("methods outside the list never reach the node", async () => {
  const { url } = await gateway();
  seen.length = 0;
  for (const m of ["debug_traceTransaction", "admin_nodeInfo", "txpool_content", "eth_sendTransaction", "personal_unlockAccount", "eth_newFilter", "miner_stop"]) {
    const r = await post(url, call(m, [], 9));
    assert.equal(r.status, 200);
    assert.equal(r.json.error.code, -32601, m);
    assert.equal(r.json.id, 9);
  }
  assert.equal(seen.length, 0);
});

test("a batch: answers in order, refused members answered here, the rest by the node", async () => {
  const { url } = await gateway();
  seen.length = 0;
  const all = await post(url, [call("eth_blockNumber", [], 1), call("eth_syncing", [], 2)]);
  assert.deepEqual(all.json, [{ jsonrpc: "2.0", id: 1, result: "0x3e8" }, { jsonrpc: "2.0", id: 2, result: "eth_syncing" }]);
  assert.equal(seen.length, 1, "a fully served batch is one pass-through request");

  seen.length = 0;
  const mixed = await post(url, [call("eth_blockNumber", [], "same"), call("debug_setHead", ["0x0"], "same"), 7, call("eth_estimateGas", [{}], 3), { jsonrpc: "2.0", id: 4, method: "eth_gasPrice" }]);
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.json.map((a: any) => a.id), ["same", "same", null, 3, 4]);
  assert.equal(mixed.json[0].result, "0x3e8");
  assert.equal(mixed.json[1].error.code, -32601);
  assert.equal(mixed.json[2].error.code, -32600);
  assert.deepEqual(mixed.json[3].error, { code: 3, message: "execution reverted", data: "0x08c379a0" });
  assert.equal(mixed.json[4].result, "eth_gasPrice");
  assert.equal(seen.length, 1);
  const sent = JSON.parse(seen[0]!) as Call[];
  assert.deepEqual(sent.map((c) => c.method), ["eth_blockNumber", "eth_estimateGas", "eth_gasPrice"]);
  assert.ok(!("params" in sent[2]!), "absent params stay absent");
  assert.ok(!seen[0]!.includes("debug_setHead"));

  seen.length = 0;
  const refused = await post(url, [call("debug_setHead", ["0x0"], 1), call("admin_peers", [], 2)]);
  assert.deepEqual(refused.json.map((a: any) => a.error.code), [-32601, -32601]);
  assert.equal(seen.length, 0);

  // A member whose id cannot be repeated exactly is refused; the others get their own answers.
  seen.length = 0;
  const big = await post(url, '[{"jsonrpc":"2.0","id":90071992547409931234,"method":"eth_blockNumber"},{"jsonrpc":"2.0","id":1,"method":"debug_x"},{"jsonrpc":"2.0","id":2,"method":"eth_gasPrice"}]');
  assert.deepEqual(big.json.map((a: any) => [a.id, a.error?.code ?? a.result]), [[null, -32600], [1, -32601], [2, "eth_gasPrice"]]);
  assert.deepEqual(seen, ['[{"jsonrpc":"2.0","id":2,"method":"eth_gasPrice"}]']);
});

test("malformed requests, empty and oversized batches", async () => {
  const { url } = await gateway({ MAX_BATCH: "3", RATE_BURST: "100" });
  seen.length = 0;
  assert.equal((await post(url, "{not json")).json.error.code, -32700);
  assert.equal((await post(url, "[]")).json.error.code, -32600);
  assert.equal((await post(url, "5")).json.error.code, -32600);
  assert.equal((await post(url, { jsonrpc: "2.0", method: "eth_blockNumber" })).json.error.code, -32600);
  const over = await post(url, [1, 2, 3, 4].map((i) => call("eth_blockNumber", [], i)));
  assert.equal(over.json.error.code, -32600);
  assert.match(over.json.error.message, /at most 3/);
  assert.equal(seen.length, 0);
  assert.equal((await post(url, [1, 2, 3].map((i) => call("eth_blockNumber", [], i)))).json.length, 3);
});

test("eth_getLogs: a range over the limit is refused before the node scans anything", async () => {
  const { url } = await gateway({ MAX_LOG_RANGE: "100" });
  seen.length = 0;
  const wide = await post(url, call("eth_getLogs", [{ fromBlock: "0x0", toBlock: "0x64" }]));
  assert.equal(wide.json.error.code, -32602);
  assert.match(wide.json.error.message, /limited to 100 blocks/);
  assert.equal(seen.length, 0);

  assert.equal((await post(url, call("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x64" }]))).json.result, "eth_getLogs");
  assert.equal((await post(url, call("eth_getLogs", [{ blockHash: `0x${"11".repeat(32)}` }]))).json.result, "eth_getLogs");
  assert.equal((await post(url, call("eth_getLogs", [{ address: "0x4200000000000000000000000000000000000006" }]))).json.result, "eth_getLogs");
  assert.equal(seen.length, 3, "closed ranges and the newest block alone need no look at the chain's height");

  // The stand-in node's newest block is 1,000 (0x3e8).
  seen.length = 0;
  clock += 10_000;
  const open = await post(url, call("eth_getLogs", [{ fromBlock: "0x383" }]));
  assert.equal(open.json.error.code, -32602, "blocks 899 to 1,000 are 102 blocks");
  assert.deepEqual(seen.map((b) => (JSON.parse(b) as Call).method), ["eth_blockNumber"]);
  assert.equal((await post(url, call("eth_getLogs", [{ fromBlock: "0x385", toBlock: "latest" }]))).json.result, "eth_getLogs");
  assert.equal((await post(url, call("eth_getLogs", [{ fromBlock: "earliest", toBlock: "latest" }]))).json.error.code, -32602);
  assert.equal(seen.filter((b) => b.includes("eth_blockNumber")).length, 1, "the height is remembered for two seconds");
  assert.equal((await post(url, call("eth_getLogs", ["0x1"]))).json.error.code, -32602);

  // Safe and finalized lie an unknown distance behind the newest block: refused as the start of a range, fine as its end.
  seen.length = 0;
  for (const tag of ["safe", "finalized"]) {
    const lagging = await post(url, call("eth_getLogs", [{ fromBlock: tag, toBlock: "latest" }], 6));
    assert.deepEqual([lagging.json.id, lagging.json.error.code], [6, -32602], tag);
    assert.match(lagging.json.error.message, /cannot start at safe or finalized/);
    assert.equal((await post(url, call("eth_getLogs", [{ fromBlock: tag }]))).json.error.code, -32602, tag);
  }
  assert.equal(seen.length, 0);
  for (const tag of ["safe", "finalized"]) {
    assert.equal((await post(url, call("eth_getLogs", [{ fromBlock: "0x3e0", toBlock: tag }]))).json.result, "eth_getLogs", tag);
    assert.equal((await post(url, call("eth_getLogs", [{ fromBlock: "0x0", toBlock: tag }]))).json.error.code, -32602, tag);
  }
  assert.equal((await post(url, call("eth_getLogs", [{ fromBlock: "pending", toBlock: "pending" }]))).json.result, "eth_getLogs");
});

test("keys the node would read differently from the check never reach it", async () => {
  const { url } = await gateway({ MAX_LOG_RANGE: "100" });
  seen.length = 0;
  const attacks: [body: string, code: number][] = [
    // "Method" and "Params" would replace the checked method and params in the node.
    ['{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","Method":"eth_newFilter","params":[{}]}', -32600],
    ['{"jsonrpc":"2.0","id":1,"Method":"eth_newFilter","method":"eth_blockNumber","params":[{}]}', -32600],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x3e7","toBlock":"0x3e8"}],"Params":[{"fromBlock":"0x0","toBlock":"0x3e8"}]}', -32600],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","PARAMS":[],"METHOD":"debug_setHead"}', -32600],
    ['{"jsonrpc":"2.0","id":1,"ID":2,"method":"eth_blockNumber"}', -32600],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","extra":true}', -32600],
    // "FROMBLOCK" would widen the range past the limit after it was counted.
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"FROMBLOCK":"0x0","toBlock":"latest"}]}', -32602],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x3e7","FromBlock":"0x0","toBlock":"0x3e8"}]}', -32602],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x3e7","toBlock":"0x3e8","TOBLOCK":"0xffffff"}]}', -32602],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromblock":"earliest"}]}', -32602],
    // The node's reader also takes the Kelvin sign for a "k".
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBloc\\u212a":"0x0"}]}', -32602],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","toBlock":"0x3e8","BlockHash":null}]}', -32602],
    ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x3e7","toBlock":"0x3e8","limit":5}]}', -32602],
  ];
  for (const [body, code] of attacks) {
    const r = await post(url, body);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.id, r.json.error.code], [1, code], body);
  }
  assert.equal(seen.length, 0);

  // Inside a batch each one is refused the same way, and the rest of the batch is served.
  const batch = await post(url, `[{"jsonrpc":"2.0","id":"ok","method":"eth_gasPrice","params":[]},${attacks.map(([body]) => body).join(",")}]`);
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.json[0], { jsonrpc: "2.0", id: "ok", result: "eth_gasPrice" });
  assert.deepEqual(batch.json.slice(1).map((a: any) => a.error.code), attacks.map(([, code]) => code));
  assert.deepEqual(seen, ['[{"jsonrpc":"2.0","id":0,"method":"eth_gasPrice","params":[]}]']);

  // A batch of nothing but these does not reach the node at all.
  seen.length = 0;
  const all = await post(url, `[${attacks.slice(0, 3).map(([body]) => body).join(",")}]`);
  assert.deepEqual(all.json.map((a: any) => a.error.code), [-32600, -32600, -32600]);
  assert.equal(seen.length, 0);
});

test("duplicate keys: the node is sent only the value that was checked", async () => {
  const { url } = await gateway({ MAX_LOG_RANGE: "100" });
  // Of two equal keys the last one counts, here as in the node, and the other is never sent on.
  seen.length = 0;
  const last = await post(url, '{"jsonrpc":"2.0","id":1,"method":"eth_newFilter","method":"eth_blockNumber","id":2}');
  assert.deepEqual(last.json, { jsonrpc: "2.0", id: 2, result: "0x3e8" });
  assert.deepEqual(seen, ['{"jsonrpc":"2.0","id":2,"method":"eth_blockNumber"}']);

  seen.length = 0;
  assert.equal((await post(url, '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","method":"eth_newFilter"}')).json.error.code, -32601);
  const wide = await post(url, '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x3e7","fromBlock":"0x0","toBlock":"0x3e8"}]}');
  assert.equal(wide.json.error.code, -32602);
  assert.match(wide.json.error.message, /limited to 100 blocks/);
  const swapped = await post(url, '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x3e7","toBlock":"0x3e8"}],"params":[{"fromBlock":"0x0","toBlock":"0x3e8"}]}');
  assert.equal(swapped.json.error.code, -32602);
  assert.equal(seen.length, 0);

  const narrow = await post(url, '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x0","fromBlock":"0x3e7","toBlock":"0x3e8"}]}');
  assert.equal(narrow.json.result, "eth_getLogs");
  assert.deepEqual(seen, ['{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x3e7","toBlock":"0x3e8"}]}']);

  // The same inside a batch, served whole and partly refused.
  seen.length = 0;
  const whole = await post(url, '[{"jsonrpc":"2.0","id":1,"method":"eth_newFilter","method":"eth_gasPrice"},{"jsonrpc":"2.0","id":2,"method":"eth_getLogs","params":[{"toBlock":"0xffff","fromBlock":"0x3e7","toBlock":"0x3e8"}]}]');
  assert.deepEqual(whole.json.map((a: any) => a.result), ["eth_gasPrice", "eth_getLogs"]);
  assert.deepEqual(seen, ['[{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice"},{"jsonrpc":"2.0","id":2,"method":"eth_getLogs","params":[{"toBlock":"0x3e8","fromBlock":"0x3e7"}]}]']);
  seen.length = 0;
  const partly = await post(url, '[{"jsonrpc":"2.0","id":1,"method":"eth_newFilter","method":"eth_gasPrice"},{"jsonrpc":"2.0","id":2,"method":"eth_gasPrice","method":"eth_newFilter"}]');
  assert.deepEqual(partly.json.map((a: any) => a.error?.code ?? a.result), ["eth_gasPrice", -32601]);
  assert.deepEqual(seen, ['[{"jsonrpc":"2.0","id":0,"method":"eth_gasPrice"}]']);
});

test("standard wallet and library requests are served as sent", async () => {
  const { url } = await gateway();
  const a = "0x4200000000000000000000000000000000000006";
  const b = "0x52908400098527886E0F7030069857D2E4169EE7";
  const hash = `0x${"11".repeat(32)}`;
  const topic = `0x${"dd".repeat(32)}`;
  const legacy = { from: b, to: a, data: "0x70a08231", value: "0x0", gas: "0x5208", gasPrice: "0x3b9aca00", nonce: "0x1", chainId: "0xa3481", type: "0x0" };
  const dynamic = { from: b, to: a, input: "0x70a08231", value: "0x1", gas: "0x5208", maxFeePerGas: "0x3b9aca00", maxPriorityFeePerGas: "0x1", nonce: "0x2", accessList: [{ address: a, storageKeys: [hash] }], chainId: "0xa3481", type: "0x2" };
  const requests = [
    call("eth_blockNumber", [], 1),
    { jsonrpc: "2.0", id: 2, method: "eth_gasPrice" },
    call("eth_maxPriorityFeePerGas", [], 3),
    call("eth_feeHistory", ["0x4", "latest", [25, 75]], 4),
    call("eth_getBalance", [b, "latest"], 5),
    call("eth_getTransactionCount", [b, "pending"], 6),
    call("eth_getCode", [a, "latest"], 7),
    call("eth_getStorageAt", [a, "0x0", "latest"], 8),
    call("eth_getBlockByNumber", ["latest", false], 9),
    call("eth_getBlockByNumber", ["finalized", true], 10),
    call("eth_getBlockByHash", [hash, false], 11),
    call("eth_getTransactionByHash", [hash], 12),
    call("eth_getTransactionReceipt", [hash], 13),
    call("eth_sendRawTransaction", ["0x02f86c83a3481"], 14),
    call("eth_call", [legacy, "latest"], 15),
    // A block given by hash, and state overrides keyed by an address in mixed case.
    call("eth_call", [dynamic, { blockHash: hash, requireCanonical: true }, { [b]: { balance: "0x1", nonce: "0x1", code: "0x00", stateDiff: { [hash]: hash } } }], 16),
    call("eth_call", [{ to: a, data: "0x70a08231" }, "latest"], "3f0a6d5e-6f1c-4b53-9a52-0d6f3f0a6d5e"),
    call("eth_estimateGas", [dynamic], 18),
    call("eth_estimateGas", [legacy, "pending"], 19),
    call("eth_createAccessList", [dynamic, "latest"], 20),
    call("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2", address: [a, b], topics: [topic, null, [topic, topic]] }], 21),
    call("eth_getLogs", [{ blockHash: hash, address: a, topics: [] }], 22),
    call("eth_getLogs", [{ fromBlock: "latest", toBlock: "latest", address: a, topics: [topic] }], 23),
    call("eth_getProof", [a, [hash], "latest"], 24),
    call("eth_getBlockReceipts", ["latest"], 25),
  ];
  for (const request of requests) {
    seen.length = 0;
    const r = await post(url, request);
    assert.equal(r.status, 200, request.method);
    assert.equal(r.json.id, request.id, request.method);
    assert.ok(r.json.error === undefined || r.json.error.code === 3, `${request.method}: ${r.text}`);
    assert.equal(seen.length, 1, request.method);
    assert.deepEqual(JSON.parse(seen[0]!), request, request.method);
  }
  // The same as one batch, with the keys in the order ethers writes them.
  seen.length = 0;
  clock += 10_000;
  const batch = await post(url, requests.map(({ jsonrpc, id, method, ...rest }) => ({ method, ...rest, id, jsonrpc })));
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.json.map((r: any) => r.id), requests.map((r) => r.id));
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0]!), requests);
});

test("params nested too deeply are refused, alone and in a batch", async () => {
  const { url } = await gateway();
  seen.length = 0;
  const nested = (levels: number, id = 1) => `{"jsonrpc":"2.0","id":${id},"method":"eth_call","params":${"[".repeat(levels)}${"]".repeat(levels)}}`;
  for (const levels of [33, 20_000]) {
    const r = await post(url, nested(levels));
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.id, r.json.error.code], [1, -32602], String(levels));
    assert.match(r.json.error.message, /nested too deeply/);
  }
  assert.equal(seen.length, 0);
  assert.equal((await post(url, nested(32))).json.result, "eth_call");
  const batch = await post(url, `[${nested(20_000, 1)},${nested(3, 2)}]`);
  assert.deepEqual(batch.json.map((a: any) => a.error?.code ?? a.result), [-32602, "eth_call"]);
});

test("rate limit: per client address, by cost, refilled over time", async () => {
  const { url } = await gateway({ RATE_PER_SECOND: "2", RATE_BURST: "8", MAX_BATCH: "2" });
  const a = { "x-real-ip": "203.0.113.7" };
  assert.equal((await post(url, call("eth_call", [{}]), a)).status, 200); // costs 4
  assert.equal((await post(url, [call("eth_blockNumber"), call("eth_gasPrice")], a)).status, 200); // 2
  assert.equal((await post(url, call("eth_blockNumber"), a)).status, 200); // 1
  const limited = await post(url, call("eth_sendRawTransaction", ["0x00"], 77), a); // 2, only 1 left
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.deepEqual(limited.json, { jsonrpc: "2.0", id: 77, error: { code: -32005, message: "rate limit exceeded; slow down and retry" } });
  // Refused methods and unparseable text use the allowance too.
  assert.equal((await post(url, call("debug_x"), a)).status, 200);
  assert.equal((await post(url, call("debug_x"), a)).status, 429);
  // Another address has its own allowance, and so has another IPv6 network.
  assert.equal((await post(url, call("eth_call", [{}]), { "x-real-ip": "203.0.113.8" })).status, 200);
  const v6 = { "x-real-ip": "2001:db8:5:6::1" };
  assert.equal((await post(url, [call("eth_call", [{}]), call("eth_call", [{}])], v6)).status, 200);
  assert.equal((await post(url, call("eth_blockNumber"), { "x-real-ip": "2001:db8:5:6:ffff::2" })).status, 429, "the same /64 is one client");
  assert.equal((await post(url, call("eth_blockNumber"), { "x-real-ip": "2001:db8:5:7::2" })).status, 200);
  clock += 1000;
  assert.equal((await post(url, call("eth_sendRawTransaction", ["0x00"]), a)).status, 200);
  assert.equal((await post(url, call("eth_blockNumber"), a)).status, 429);
});

test("requests in flight are capped per client and in total", async () => {
  const { url } = await gateway({ MAX_IN_FLIGHT: "3", MAX_IN_FLIGHT_PER_CLIENT: "2" });
  nodeDelayMs = 300;
  try {
    const a = { "x-real-ip": "198.51.100.1" };
    const slow = [post(url, call("eth_call", [{}]), a), post(url, call("eth_call", [{}]), a)];
    await new Promise((r) => setTimeout(r, 100));
    const third = await post(url, call("eth_call", [{}], 3), a);
    assert.equal(third.status, 429);
    assert.match(third.json.error.message, /too many requests at once/);
    // Answers that need no node are still given.
    assert.equal((await post(url, call("eth_chainId"), a)).status, 200);
    const other = post(url, call("eth_call", [{}]), { "x-real-ip": "198.51.100.2" });
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post(url, call("eth_call", [{}]), { "x-real-ip": "198.51.100.3" });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "1");
    assert.deepEqual((await Promise.all([...slow, other])).map((r) => r.status), [200, 200, 200]);
    // Once answered, the client may send again.
    nodeDelayMs = 0;
    assert.equal((await post(url, call("eth_call", [{}]), a)).status, 200);
  } finally {
    nodeDelayMs = 0;
  }
});

test("oversized requests and answers", async () => {
  const { url } = await gateway({ MAX_BODY_BYTES: "2000", MAX_RESPONSE_BYTES: "70000" });
  seen.length = 0;
  const big = await post(url, call("eth_sendRawTransaction", [`0x${"ab".repeat(1500)}`]));
  assert.equal(big.status, 413);
  assert.equal(seen.length, 0);

  // Without a declared length the body is cut off as it arrives.
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, method: "POST", path: "/", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.write('{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x');
    req.write("ab".repeat(1500));
    req.end('"]}');
  });
  assert.equal(status, 413);
  assert.equal(seen.length, 0);

  nodeAnswerBytes = 40_000;
  try {
    const r = await post(url, call("eth_call", [{}], 4));
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.id, r.json.error.code], [4, -32005]);
    assert.match(r.json.error.message, /larger than 70000 bytes/);
    nodeAnswerBytes = 30_000;
    assert.equal((await post(url, call("eth_call", [{}], 4))).json.result.length, 60_002);
  } finally {
    nodeAnswerBytes = 0;
  }
});

test("a node that does not answer gives 502, never a hang", async () => {
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/`;
  await new Promise((r) => dead.close(r));
  const down = await gateway({}, deadUrl);
  const r = await post(down.url, call("eth_blockNumber", [], 8));
  assert.equal(r.status, 502);
  assert.deepEqual([r.json.id, r.json.error.code], [8, -32603]);
  const batch = await post(down.url, [call("eth_blockNumber", [], 1), call("eth_gasPrice", [], 2)]);
  assert.deepEqual(batch.json.map((a: any) => [a.id, a.error.code]), [[1, -32603], [2, -32603]]);
  assert.equal((await post(down.url, call("eth_getLogs", [{ fromBlock: "0x1" }]))).status, 502);
  assert.equal((await post(down.url, call("eth_chainId"))).status, 200);

  const slow = await gateway({ UPSTREAM_TIMEOUT_MS: "100" });
  nodeDelayMs = 400;
  try {
    assert.equal((await post(slow.url, call("eth_blockNumber"))).status, 502);
  } finally {
    nodeDelayMs = 0;
  }
});

test("behind Cloudflare: the origin secret is required and Cloudflare names the client", async () => {
  const secret = "s".repeat(40);
  const { url } = await gateway({ ORIGIN_SECRET: secret, RATE_PER_SECOND: "1", RATE_BURST: "4", MAX_BATCH: "1" });
  seen.length = 0;
  for (const headers of [{}, { "x-longyu-origin": "wrong" }, { "x-longyu-origin": `${secret}x` }] as Record<string, string>[]) {
    assert.equal((await post(url, call("eth_blockNumber"), headers)).status, 403);
  }
  assert.equal(seen.length, 0);
  const cf = (ip: string) => ({ "x-longyu-origin": secret, "cf-connecting-ip": ip, "x-real-ip": "10.0.0.1" });
  assert.equal((await post(url, call("eth_call", [{}]), cf("203.0.113.50"))).status, 200);
  assert.equal((await post(url, call("eth_blockNumber"), cf("203.0.113.50"))).status, 429);
  assert.equal((await post(url, call("eth_call", [{}]), cf("203.0.113.51"))).status, 200);
  // The health check needs no secret.
  assert.equal((await fetch(`${url}health`)).status, 200);
});

test("other HTTP: preflight, health, the front page, wrong paths and methods", async () => {
  const { url } = await gateway();
  const pre = await fetch(url, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.equal(pre.headers.get("access-control-allow-headers"), "*");
  assert.deepEqual(await (await fetch(`${url}health`)).json(), { status: "ok" });
  assert.equal(((await (await fetch(url)).json()) as { chainId: string }).chainId, "668801");
  assert.equal((await fetch(`${url}admin`)).status, 404);
  assert.equal((await post(`${url}debug`, call("eth_blockNumber"))).status, 404);
  assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
  assert.equal((await post(`${url}?key=1`, call("eth_blockNumber"))).status, 200);
});
