import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, type Hex, type TransactionSerialized } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { createApp, VOUCHER_TYPES } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { claimMany, DISTRIBUTOR, drip, FAUCET, pause, proposeRoot, unpause, veto } from "./fixtures.ts";

const key = (n: string) => `0x${n.repeat(64)}` as Hex;
const TOKEN = "signer-test-token-0123456789abcdef";
const env = {
  SIGNER_TOKEN: TOKEN,
  CHAIN_ID: "668801",
  DISTRIBUTOR_ADDRESS: DISTRIBUTOR,
  FAUCET_ADDRESS: FAUCET,
  PUBLISHER_KEY: key("1"),
  RELAYER_KEY: key("2"),
  FAUCET_SIGNER_KEY: key("3"),
  WATCH_KEY: key("4"),
};
const NOW = 1_800_000_000_000;

const servers: Server[] = [];
const logs: Record<string, unknown>[] = [];
let clock = NOW;

async function start(extra: Record<string, string> = {}): Promise<string> {
  const server = createServer(createApp(loadConfig({ ...env, ...extra }), { now: () => clock, log: (entry) => logs.push(entry) }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let base: string;
before(async () => {
  base = await start();
});
after(() => {
  for (const server of servers) server.close();
});

const call = (url: string, path: string, body?: unknown, token: string | null = TOKEN, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const wire = (over: Record<string, unknown> = {}) => ({
  type: "eip1559",
  chainId: 668801,
  to: DISTRIBUTOR,
  data: proposeRoot,
  value: "0",
  nonce: 7,
  gas: "300000",
  maxFeePerGas: "2000000",
  maxPriorityFeePerGas: "1000000",
  ...over,
});

test("health needs no token; everything else does", async () => {
  assert.deepEqual(await (await call(base, "/health", undefined, null)).json(), { ok: true });
  for (const token of [null, "wrong", `${TOKEN}x`, TOKEN.slice(0, -1)]) {
    assert.equal((await call(base, "/v1/accounts", undefined, token)).status, 401);
    assert.equal((await call(base, "/v1/sign/transaction", { role: "publisher", transaction: wire() }, token)).status, 401);
    assert.equal((await call(base, "/v1/sign/voucher", {}, token)).status, 401);
    assert.equal((await call(base, "/nothing", undefined, token)).status, 401);
  }
  assert.equal((await call(base, "/nothing")).status, 404);
  assert.equal((await call(base, "/v1/accounts", {})).status, 404, "accounts is read with GET");
});

test("accounts lists the addresses and what the policy is bound to", async () => {
  const r = await call(base, "/v1/accounts");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), {
    chainId: 668801,
    distributor: DISTRIBUTOR,
    faucet: FAUCET,
    publisher: privateKeyToAddress(key("1")),
    relayer: privateKeyToAddress(key("2")),
    faucetSigner: privateKeyToAddress(key("3")),
    watch: privateKeyToAddress(key("4")),
  });
});

test("the watch key signs a veto and a pause, and nothing else", async () => {
  for (const data of [veto, pause]) {
    const r = await call(base, "/v1/sign/transaction", { role: "watch", transaction: wire({ data }) });
    assert.equal(r.status, 200);
    const { signedTransaction } = (await r.json()) as { signedTransaction: TransactionSerialized };
    assert.equal(await recoverTransactionAddress({ serializedTransaction: signedTransaction }), privateKeyToAddress(key("4")));
    assert.equal(parseTransaction(signedTransaction).data, data);
  }
  for (const data of [proposeRoot, unpause]) {
    const r = await call(base, "/v1/sign/transaction", { role: "watch", transaction: wire({ data }) });
    assert.deepEqual([r.status, await r.json()], [403, { error: "call_not_allowed" }]);
  }
});

test("the publisher signs a root proposal exactly as asked", async () => {
  const r = await call(base, "/v1/sign/transaction", { role: "publisher", transaction: wire() });
  assert.equal(r.status, 200);
  const { signedTransaction, hash } = (await r.json()) as { signedTransaction: TransactionSerialized; hash: Hex };
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: signedTransaction }), privateKeyToAddress(key("1")));
  const parsed = parseTransaction(signedTransaction);
  assert.equal(parsed.type, "eip1559");
  assert.equal(parsed.chainId, 668801);
  assert.equal(parsed.to?.toLowerCase(), DISTRIBUTOR);
  assert.equal(parsed.data, proposeRoot);
  assert.equal(parsed.value ?? 0n, 0n);
  assert.equal(parsed.nonce, 7);
  assert.equal(parsed.gas, 300_000n);
  assert.equal(parsed.maxFeePerGas, 2_000_000n);
  assert.equal(parsed.maxPriorityFeePerGas, 1_000_000n);
});

test("the relayer signs claims and drips, legacy or not, with its own key", async () => {
  for (const transaction of [wire({ data: claimMany }), wire({ to: FAUCET, data: drip }), wire({ data: claimMany, type: "legacy", gasPrice: "1000000", maxFeePerGas: undefined, maxPriorityFeePerGas: undefined })]) {
    const r = await call(base, "/v1/sign/transaction", { role: "relayer", transaction });
    assert.equal(r.status, 200);
    const { signedTransaction } = (await r.json()) as { signedTransaction: TransactionSerialized };
    assert.equal(await recoverTransactionAddress({ serializedTransaction: signedTransaction }), privateKeyToAddress(key("2")));
    assert.equal(parseTransaction(signedTransaction).chainId, 668801);
  }
});

test("requests outside the policy are refused and logged", async () => {
  const refuse = async (body: unknown, status: number, error: string) => {
    const r = await call(base, "/v1/sign/transaction", body);
    assert.deepEqual([r.status, await r.json()], [status, { error }], JSON.stringify(body).slice(0, 120));
  };
  logs.length = 0;
  await refuse({ role: "publisher", transaction: wire({ data: claimMany }) }, 403, "call_not_allowed");
  await refuse({ role: "relayer", transaction: wire() }, 403, "call_not_allowed");
  await refuse({ role: "publisher", transaction: wire({ to: FAUCET, data: drip }) }, 403, "target_not_allowed");
  await refuse({ role: "publisher", transaction: wire({ value: "1" }) }, 403, "value_not_allowed");
  await refuse({ role: "publisher", transaction: wire({ chainId: 97 }) }, 403, "wrong_chain");
  await refuse({ role: "publisher", transaction: wire({ gas: "5000001" }) }, 403, "gas_out_of_range");
  await refuse({ role: "publisher", transaction: wire({ maxFeePerGas: "1000000001" }) }, 403, "fee_too_high");
  assert.equal(logs.filter((l) => l.event === "refused").length, 7);
  await refuse({ role: "publisher", transaction: wire({ accessList: [] }) }, 400, "invalid_request");
  await refuse({ role: "publisher", transaction: wire({ authorizationList: [] }) }, 400, "invalid_request");
  await refuse({ role: "faucetSigner", transaction: wire() }, 400, "invalid_request");
  await refuse({ role: "publisher", transaction: wire(), extra: 1 }, 400, "invalid_request");
  await refuse({ role: "publisher" }, 400, "invalid_request");
  await refuse([], 400, "invalid_request");
  await refuse("{not json", 400, "invalid_json");
});

test("only JSON of a sane size is read", async () => {
  const text = await call(base, "/v1/sign/transaction", JSON.stringify({ role: "publisher", transaction: wire() }), TOKEN, { "content-type": "text/plain" });
  assert.deepEqual([text.status, await text.json()], [415, { error: "json_required" }]);
  const big = await call(base, "/v1/sign/transaction", { role: "publisher", transaction: wire({ data: `0x${"00".repeat(160_000)}` }) });
  assert.deepEqual([big.status, await big.json()], [413, { error: "body_too_large" }]);
});

test("the faucet signer signs vouchers the contract will accept, within limits", async () => {
  const voucher = { recipient: "0x4444444444444444444444444444444444444444", amount: "1000000000000000", nonce: "12345", deadline: String(NOW / 1000 + 600) };
  const r = await call(base, "/v1/sign/voucher", voucher);
  assert.equal(r.status, 200);
  const { signature } = (await r.json()) as { signature: Hex };
  const signer = await recoverTypedDataAddress({
    domain: { name: "LONGYU Faucet", version: "1", chainId: 668801, verifyingContract: FAUCET },
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { recipient: voucher.recipient as Hex, amount: 1_000_000_000_000_000n, nonce: 12345n, deadline: BigInt(voucher.deadline) },
    signature,
  });
  assert.equal(signer, privateKeyToAddress(key("3")));

  const refuse = async (body: unknown, status: number, error: string) => {
    const res = await call(base, "/v1/sign/voucher", body);
    assert.deepEqual([res.status, await res.json()], [status, { error }]);
  };
  await refuse({ ...voucher, amount: "1000000000000001" }, 403, "amount_out_of_range");
  await refuse({ ...voucher, deadline: String(NOW / 1000 + 901) }, 403, "deadline_out_of_range");
  await refuse({ ...voucher, deadline: String(NOW / 1000) }, 403, "deadline_out_of_range");
  await refuse({ ...voucher, recipient: `0x${"0".repeat(40)}` }, 403, "recipient_not_allowed");
  await refuse({ ...voucher, verifyingContract: DISTRIBUTOR }, 400, "invalid_request");
  await refuse({ ...voucher, amount: 1 }, 400, "invalid_request");
});

test("daily limits: fees per transaction key, and the faucet's total", async () => {
  // Room for two transactions of 300,000 gas at 2,000,000 wei, and two full vouchers.
  const url = await start({ MAX_DAILY_FEE_WEI: "1200000000000", FAUCET_MAX_DAILY_WEI: "2000000000000000" });
  clock = NOW;
  const sign = async (role: string, transaction: unknown) => (await call(url, "/v1/sign/transaction", { role, transaction })).status;
  assert.deepEqual([await sign("publisher", wire()), await sign("publisher", wire({ nonce: 8 })), await sign("publisher", wire({ nonce: 9 }))], [200, 200, 429]);
  // A refused request takes nothing, and each key has its own allowance.
  assert.equal(await sign("publisher", wire({ value: "1" })), 403);
  assert.equal(await sign("relayer", wire({ data: claimMany })), 200);

  const voucher = (nonce: number) => ({ recipient: "0x4444444444444444444444444444444444444444", amount: "1000000000000000", nonce: String(nonce), deadline: String(clock / 1000 + 600) });
  const drips = [];
  for (const n of [1, 2, 3]) drips.push((await call(url, "/v1/sign/voucher", voucher(n))).status);
  assert.deepEqual(drips, [200, 200, 429]);

  clock = NOW + 86_400_000;
  assert.equal(await sign("publisher", wire({ nonce: 9 })), 200);
  assert.equal((await call(url, "/v1/sign/voucher", voucher(4))).status, 200);
  clock = NOW;
});

test("a role without a key, or a policy without an address, signs nothing", async () => {
  const noKeys = await start({ PUBLISHER_KEY: "", FAUCET_SIGNER_KEY: "" });
  assert.equal((await call(noKeys, "/v1/sign/transaction", { role: "publisher", transaction: wire() })).status, 503);
  assert.equal((await call(noKeys, "/v1/sign/transaction", { role: "relayer", transaction: wire({ data: claimMany }) })).status, 200);
  assert.equal((await call(noKeys, "/v1/sign/voucher", { recipient: FAUCET, amount: "1", nonce: "1", deadline: String(NOW / 1000 + 60) })).status, 503);
  const accounts = (await (await call(noKeys, "/v1/accounts")).json()) as Record<string, unknown>;
  assert.deepEqual([accounts.publisher, accounts.faucetSigner], [null, null]);

  const noAddresses = await start({ DISTRIBUTOR_ADDRESS: "", FAUCET_ADDRESS: "" });
  assert.equal((await call(noAddresses, "/v1/sign/transaction", { role: "publisher", transaction: wire() })).status, 503);
  assert.equal((await call(noAddresses, "/v1/sign/voucher", { recipient: DISTRIBUTOR, amount: "1", nonce: "1", deadline: String(NOW / 1000 + 60) })).status, 503);
  assert.equal(((await (await call(noAddresses, "/v1/accounts")).json()) as Record<string, unknown>).distributor, null);
});

test("no key or token is ever logged or returned", () => {
  const text = JSON.stringify(logs);
  assert.ok(logs.some((l) => l.event === "signed_transaction") && logs.some((l) => l.event === "signed_voucher"));
  for (const secret of [key("1"), key("2"), key("3"), TOKEN]) assert.equal(text.includes(secret.replace(/^0x/, "")), false);
});
