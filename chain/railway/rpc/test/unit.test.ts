import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { Limiter, clientKey } from "../src/limiter.ts";
import { MAX_DEPTH, METHODS, classify, idOf, logName, logRange, rangeLength } from "../src/policy.ts";

const env = { UPSTREAM_URL: "http://op-geth.railway.internal:8545", CHAIN_ID: "668801" };

test("config: defaults, and bad settings are refused", () => {
  const c = loadConfig(env);
  assert.equal(c.chainId, 668801n);
  assert.equal(c.originSecret, null);
  assert.ok(c.burst >= c.maxBatch * 4);
  assert.throws(() => loadConfig({ CHAIN_ID: "668801" }), /UPSTREAM_URL/);
  assert.throws(() => loadConfig({ ...env, UPSTREAM_URL: "file:///etc/passwd" }), /http/);
  assert.throws(() => loadConfig({ ...env, CHAIN_ID: "0x1" }), /CHAIN_ID/);
  assert.throws(() => loadConfig({ ...env, ORIGIN_SECRET: "short" }), /ORIGIN_SECRET/);
  assert.throws(() => loadConfig({ ...env, RATE_PER_SECOND: "0" }), /RATE_PER_SECOND/);
  assert.throws(() => loadConfig({ ...env, MAX_BATCH: "1e3" }), /MAX_BATCH/);
  assert.throws(() => loadConfig({ ...env, RATE_BURST: "50", MAX_BATCH: "25" }), /RATE_BURST/);
});

test("policy: only wallet, dapp and bridge methods are served", () => {
  for (const m of ["eth_call", "eth_getLogs", "eth_sendRawTransaction", "eth_getProof", "eth_estimateGas", "eth_getTransactionReceipt"]) assert.ok(m in METHODS, m);
  for (const m of [
    "debug_traceTransaction", "admin_peers", "txpool_content", "personal_sign", "miner_setGasPrice", "engine_newPayloadV3",
    "eth_sendTransaction", "eth_sign", "eth_newFilter", "eth_subscribe", "constructor", "toString", "__proto__", "hasOwnProperty",
  ]) {
    const v = classify({ jsonrpc: "2.0", id: 1, method: m, params: [] }, { chainId: 668801n });
    assert.equal(v.kind, "reject", m);
    assert.equal(v.kind === "reject" && v.code, -32601, m);
  }
});

test("policy: request shape", () => {
  const opts = { chainId: 668801n };
  for (const bad of [null, 1, "x", [], {}, { jsonrpc: "1.0", id: 1, method: "eth_call" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, method: 5 }]) {
    const v = classify(bad, opts);
    assert.equal(v.kind === "reject" && v.code, -32600, JSON.stringify(bad));
  }
  // A notification (no id) is refused: nothing served here is one.
  assert.equal(classify({ jsonrpc: "2.0", method: "eth_blockNumber" }, opts).kind, "reject");
  const named = classify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: { to: "0x" } }, opts);
  assert.equal(named.kind === "reject" && named.code, -32602);
  const ok = classify({ jsonrpc: "2.0", id: "a", method: "eth_call", params: [{}, "latest"] }, opts);
  assert.deepEqual(ok, { kind: "forward", id: "a", idSafe: true, method: "eth_call", params: [{}, "latest"], cost: 4 });

  // The node matches keys without regard to case, so only the four exact ones are accepted.
  for (const extra of ["Method", "METHOD", "Params", "ID", "Id", "Jsonrpc", "JSONRPC", "extra", "__proto__", "metho\\u017f", ""]) {
    const v = classify(JSON.parse(`{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[],"${extra}":"eth_newFilter"}`), opts);
    assert.deepEqual(v.kind === "reject" && [v.id, v.code], [1, -32600], extra);
  }
  // An id that cannot be repeated exactly is refused, whatever the method.
  for (const id of [2 ** 60, 1.5, -0.5, { a: 1 }, [1], true]) {
    const v = classify({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] }, opts);
    assert.deepEqual(v.kind === "reject" && [v.id, v.idSafe, v.code], [null, false, -32600], JSON.stringify(id));
  }
  for (const id of [0, -1, Number.MAX_SAFE_INTEGER, "", "abc", null]) assert.equal(classify({ jsonrpc: "2.0", id, method: "eth_blockNumber" }, opts).kind, "forward", String(id));

  // Params may nest only so deep.
  const nested = (levels: number) => JSON.parse(`${"[".repeat(levels)}${"]".repeat(levels)}`) as unknown;
  assert.equal(classify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: nested(MAX_DEPTH) }, opts).kind, "forward");
  const deep = classify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: nested(MAX_DEPTH + 1) }, opts);
  assert.equal(deep.kind === "reject" && deep.code, -32602);
  const deepObject = classify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [JSON.parse(`${'{"a":'.repeat(MAX_DEPTH)}1${"}".repeat(MAX_DEPTH)}`)] }, opts);
  assert.equal(deepObject.kind === "reject" && deepObject.code, -32602);
});

test("policy: the chain's identity is answered without the node; an id that cannot be repeated exactly is refused", () => {
  const ask = (method: string, id: unknown) => classify({ jsonrpc: "2.0", id, method }, { chainId: 668801n });
  assert.deepEqual(ask("eth_chainId", 7), { kind: "local", id: 7, idSafe: true, method: "eth_chainId", result: "0xa3481" });
  assert.deepEqual(ask("net_version", null), { kind: "local", id: null, idSafe: true, method: "net_version", result: "668801" });
  // The node's own answer would name its software and release.
  assert.deepEqual(ask("web3_clientVersion", "v"), { kind: "local", id: "v", idSafe: true, method: "web3_clientVersion", result: "LONGYU" });
  assert.equal(classify({ jsonrpc: "2.0", method: "web3_clientVersion" }, { chainId: 668801n }).kind, "reject");
  assert.equal(ask("eth_chainId", 2 ** 60).kind, "reject");
  assert.equal(ask("eth_chainId", 1.5).kind, "reject");
  assert.deepEqual(idOf({ id: 2 ** 60 }), { id: null, safe: false });
  assert.deepEqual(idOf({ id: { a: 1 } }), { id: null, safe: false });
  assert.deepEqual(idOf({ id: "x" }), { id: "x", safe: true });
});

test("policy: the access log gets a served method's name whole and little of any other", () => {
  for (const m of Object.keys(METHODS)) assert.equal(logName(m), m);
  assert.equal(logName(null), "?");
  assert.equal(logName("debug_traceTransaction"), "unserved:debug_traceTransaction");
  assert.equal(logName(""), "unserved:");
  // A served name with anything added, or in another case, is not a served name.
  assert.equal(logName("eth_call\n"), "unserved:eth_call");
  assert.equal(logName("ETH_CALL"), "unserved:ETH_CALL");
  for (const m of ["constructor", "toString", "__proto__"]) assert.equal(logName(m), `unserved:${m}`);
  // Line breaks, spaces, separators and letters outside ASCII are dropped; what is left is cut at 40.
  assert.equal(logName("x\nrpc: 203.0.113.9 200 1ms eth_call"), "unserved:xrpc203011392001mseth_call");
  assert.equal(logName("a,b:c\r\n\u2028\u0000d\u00e9\u212a e\u001b[31m"), "unserved:abcde31m");
  assert.equal(logName("\n".repeat(50_000)), "unserved:");
  const long = logName(`${"\n".repeat(1000)}${"a1_".repeat(100_000)}`);
  assert.equal(long, `unserved:${"a1_".repeat(14).slice(0, 40)}`);
  assert.equal(long.length, 49);
});

test("policy: eth_getLogs ranges", () => {
  assert.deepEqual(logRange([{ fromBlock: "0x10", toBlock: "0x20" }]), { from: 16n, to: 32n });
  assert.deepEqual(logRange([{ fromBlock: "earliest" }]), { from: 0n, to: null });
  assert.deepEqual(logRange([{}]), { from: null, to: null });
  assert.deepEqual(logRange([{ fromBlock: "0x1", toBlock: "finalized" }]), { from: 1n, to: null });
  assert.equal(logRange([{ blockHash: `0x${"ab".repeat(32)}` }]), "hash");
  for (const bad of [undefined, [], [1], [{}, {}], [{ fromBlock: 5 }], [{ fromBlock: "0x" }], [{ toBlock: "newest" }], [{ fromBlock: "12" }], [{ blockHash: 1 }], [[]]]) {
    assert.equal(logRange(bad), "invalid", JSON.stringify(bad));
  }
  // Only the five standard filter keys, spelled exactly: the node would also read "FROMBLOCK".
  assert.deepEqual(logRange([{ fromBlock: "0x1", toBlock: "0x2", address: [], topics: [null] }]), { from: 1n, to: 2n });
  assert.equal(logRange([{ blockHash: `0x${"ab".repeat(32)}`, address: "0x4200000000000000000000000000000000000006", topics: [] }]), "hash");
  for (const key of ["FROMBLOCK", "FromBlock", "fromblock", "TOBLOCK", "toblock", "BlockHash", "blockhash", "Address", "Topics", "fromBloc\\u212a", "limit", "__proto__"]) {
    assert.equal(logRange(JSON.parse(`[{"fromBlock":"0x1","toBlock":"0x2","${key}":"0x0"}]`)), "invalid", key);
    assert.equal(logRange(JSON.parse(`[{"${key}":"0x0"}]`)), "invalid", key);
  }
  // Safe and finalized count as the newest block at the end of a range, and are refused at its start.
  for (const tag of ["safe", "finalized"]) {
    assert.equal(logRange([{ fromBlock: tag }]), "lagging", tag);
    assert.equal(logRange([{ fromBlock: tag, toBlock: "latest" }]), "lagging", tag);
    assert.deepEqual(logRange([{ fromBlock: "0x1", toBlock: tag }]), { from: 1n, to: null }, tag);
    const v = classify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: tag, toBlock: "latest" }] }, { chainId: 668801n });
    assert.deepEqual(v.kind === "reject" && [v.code, /cannot start at safe or finalized/.test(v.message)], [-32602, true], tag);
  }
  assert.deepEqual(logRange([{ fromBlock: "pending", toBlock: "latest" }]), { from: null, to: null });
  assert.deepEqual(logRange([{ fromBlock: "latest" }]), { from: null, to: null });
  assert.equal(rangeLength({ from: 0n, to: null }, 99n), 100n);
  assert.equal(rangeLength({ from: null, to: null }, 99n), 1n);
  assert.equal(rangeLength({ from: 10n, to: 5n }, 99n), 0n);
  assert.equal(rangeLength({ from: 5n, to: 5n }, 0n), 1n);
});

test("limiter: one key per IPv4 address and per IPv6 /64", () => {
  assert.equal(clientKey("203.0.113.5"), "203.0.113.5");
  assert.equal(clientKey(" 203.0.113.5 "), "203.0.113.5");
  assert.equal(clientKey("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(clientKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:0db8:0001:0002::1"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("2001:db8::1"), clientKey("2001:db8:0:0:ffff::9"));
  assert.notEqual(clientKey("2001:db8:0:1::1"), clientKey("2001:db8:0:2::1"));
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
  for (const bad of ["", "unknown", "1.2.3", "1.2.3.4, 5.6.7.8", "999.1.1.1", "gggg::1", "203.0.113.5:443"]) assert.equal(clientKey(bad), null, bad);
});

test("limiter: a burst, then the steady rate; clients do not share an allowance", () => {
  const l = new Limiter(10, 20);
  let t = 1_000_000;
  for (let i = 0; i < 20; i++) assert.ok(l.take("a", 1, t), `burst ${i}`);
  assert.equal(l.take("a", 1, t), false);
  assert.ok(l.take("b", 20, t));
  t += 500; // 5 tokens earned
  assert.equal(l.take("a", 6, t), false);
  assert.ok(l.take("a", 5, t));
  t += 60_000;
  assert.ok(l.take("a", 20, t), "never more than the burst is saved");
  assert.equal(l.take("a", 1, t), false);
  // A clock that steps back and forward again earns nothing.
  assert.equal(l.take("a", 1, t - 5000), false);
  assert.equal(l.take("a", 1, t), false);
});

test("limiter: memory stays bounded", () => {
  const l = new Limiter(1, 2, 100);
  const t = 5_000;
  for (let i = 0; i < 1000; i++) l.take(`client-${i}`, 2, t);
  assert.ok(l.size <= 101, `size ${l.size}`);
  // Clients beyond the bound share one bucket, which is empty by now.
  assert.equal(l.take("another", 2, t), false);
  // Once the idle ones have refilled they are forgotten and newcomers get their own bucket again.
  assert.ok(l.take("later", 2, t + 10_000));
  assert.ok(l.size <= 2, `size ${l.size}`);
});
