import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkTransaction, checkVoucher, DailyBudget, PolicyError, TransactionSchema } from "../src/policy.ts";
import { claimMany, DISTRIBUTOR, drip, FAUCET, limits, OTHER, pause, proposeRoot, tx, unpause, veto } from "./fixtures.ts";

const refused = (fn: () => unknown, code: string, status = 403) =>
  assert.throws(fn, (e) => e instanceof PolicyError && e.code === code && e.status === status, `expected ${code}`);

test("the publisher may only propose a root on the distributor", () => {
  assert.deepEqual(checkTransaction("publisher", tx(), limits), { call: "proposeRoot", maxFee: 600_000_000_000n });
  refused(() => checkTransaction("publisher", tx({ data: claimMany }), limits), "call_not_allowed");
  refused(() => checkTransaction("publisher", tx({ data: pause }), limits), "call_not_allowed");
  refused(() => checkTransaction("publisher", tx({ data: "0x" }), limits), "call_not_allowed");
  refused(() => checkTransaction("publisher", tx({ to: FAUCET, data: drip }), limits), "target_not_allowed");
  refused(() => checkTransaction("publisher", tx({ to: OTHER }), limits), "target_not_allowed");
});

test("the relayer may only relay claims and faucet drips", () => {
  assert.equal(checkTransaction("relayer", tx({ data: claimMany }), limits).call, "claimMany");
  assert.equal(checkTransaction("relayer", tx({ to: FAUCET, data: drip }), limits).call, "drip");
  refused(() => checkTransaction("relayer", tx(), limits), "call_not_allowed");
  refused(() => checkTransaction("relayer", tx({ to: FAUCET, data: claimMany }), limits), "call_not_allowed");
  refused(() => checkTransaction("relayer", tx({ to: DISTRIBUTOR, data: drip }), limits), "call_not_allowed");
  refused(() => checkTransaction("relayer", tx({ to: OTHER, data: claimMany }), limits), "target_not_allowed");
  // Without a faucet, its address is not a target.
  refused(() => checkTransaction("relayer", tx({ to: FAUCET, data: drip }), { ...limits, faucet: undefined }), "target_not_allowed");
});

test("the watch may only veto a waiting root and pause the distributor", () => {
  assert.equal(checkTransaction("watch", tx({ data: veto }), limits).call, "vetoPendingRoot");
  assert.equal(checkTransaction("watch", tx({ data: pause }), limits).call, "pause");
  for (const data of [proposeRoot, claimMany, unpause, "0x", `${pause}00`, `${veto}${"00".repeat(32)}`]) {
    refused(() => checkTransaction("watch", tx({ data: data as `0x${string}` }), limits), "call_not_allowed");
  }
  refused(() => checkTransaction("watch", tx({ to: FAUCET, data: pause }), limits), "target_not_allowed");
  refused(() => checkTransaction("watch", tx({ to: OTHER, data: veto }), limits), "target_not_allowed");
  refused(() => checkTransaction("watch", tx({ data: veto, value: 1n }), limits), "value_not_allowed");
  // The other keys cannot stop roots or claims.
  refused(() => checkTransaction("publisher", tx({ data: veto }), limits), "call_not_allowed");
  refused(() => checkTransaction("relayer", tx({ data: pause }), limits), "call_not_allowed");
});

test("the address check ignores letter case", () => {
  const upper = `0x${DISTRIBUTOR.slice(2).toUpperCase()}`;
  assert.equal(checkTransaction("publisher", tx({ to: upper }), { ...limits, distributor: "0x1111111111111111111111111111111111111111" }).call, "proposeRoot");
});

test("call data with anything after the call is refused", () => {
  refused(() => checkTransaction("publisher", tx({ data: `${proposeRoot}00` }), limits), "call_not_allowed");
  refused(() => checkTransaction("publisher", tx({ data: `${proposeRoot}${"00".repeat(32)}` }), limits), "call_not_allowed");
  refused(() => checkTransaction("publisher", tx({ data: proposeRoot.slice(0, -64) }), limits), "call_not_allowed");
});

test("value, chain, gas, fee and size limits", () => {
  refused(() => checkTransaction("publisher", tx({ value: 1n }), limits), "value_not_allowed");
  refused(() => checkTransaction("publisher", tx({ chainId: 97 }), limits), "wrong_chain");
  refused(() => checkTransaction("publisher", tx({ gas: 0n }), limits), "gas_out_of_range");
  refused(() => checkTransaction("publisher", tx({ gas: 5_000_001n }), limits), "gas_out_of_range");
  refused(() => checkTransaction("publisher", tx({ maxFeePerGas: 1_000_000_001n }), limits), "fee_too_high");
  refused(() => checkTransaction("publisher", tx({ maxPriorityFeePerGas: 2_000_001n }), limits), "fee_fields_invalid", 400);
  refused(() => checkTransaction("publisher", tx({ gasPrice: 1n }), limits), "fee_fields_invalid", 400);
  refused(() => checkTransaction("publisher", tx({ maxFeePerGas: undefined }), limits), "fee_fields_invalid", 400);
  refused(() => checkTransaction("publisher", tx(), { ...limits, maxDataBytes: 100 }), "data_too_large");
  refused(() => checkTransaction("publisher", tx(), { ...limits, distributor: undefined }), "not_configured", 503);
});

test("a legacy transaction is priced by its gas price", () => {
  const legacy = tx({ type: "legacy", gasPrice: 1_000_000n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined });
  assert.equal(checkTransaction("publisher", legacy, limits).maxFee, 300_000_000_000n);
  refused(() => checkTransaction("publisher", { ...legacy, gasPrice: 1_000_000_001n }, limits), "fee_too_high");
  refused(() => checkTransaction("publisher", { ...legacy, gasPrice: undefined }, limits), "fee_fields_invalid", 400);
  refused(() => checkTransaction("publisher", { ...legacy, maxFeePerGas: 1n }, limits), "fee_fields_invalid", 400);
});

test("the request schema refuses fields it does not know", () => {
  const wire = { type: "eip1559", chainId: 668801, to: DISTRIBUTOR, data: proposeRoot, value: "0", nonce: 1, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" };
  assert.equal(TransactionSchema.safeParse(wire).success, true);
  for (const extra of [{ accessList: [] }, { authorizationList: [] }, { blobVersionedHashes: [] }, { from: OTHER }, { type: "eip7702" }, { type: "eip4844" }, { type: "eip2930" }]) {
    assert.equal(TransactionSchema.safeParse({ ...wire, ...extra }).success, false, JSON.stringify(extra));
  }
  for (const bad of [{ value: "0x0" }, { value: "-1" }, { value: "01" }, { gas: 21000 }, { nonce: -1 }, { nonce: 1.5 }, { to: "0x1234" }, { data: "0x123" }, { chainId: "668801" }]) {
    assert.equal(TransactionSchema.safeParse({ ...wire, ...bad }).success, false, JSON.stringify(bad));
  }
  const { to: _to, ...noTarget } = wire;
  assert.equal(TransactionSchema.safeParse(noTarget).success, false, "a contract creation has no target");
});

test("voucher limits", () => {
  const v = { recipient: OTHER, amount: 1_000_000_000_000_000n, nonce: 9n, deadline: 1_600n };
  checkVoucher(v, limits, 1_000n);
  checkVoucher({ ...v, deadline: 1_900n }, limits, 1_000n);
  refused(() => checkVoucher({ ...v, deadline: 1_901n }, limits, 1_000n), "deadline_out_of_range");
  refused(() => checkVoucher({ ...v, deadline: 1_000n }, limits, 1_000n), "deadline_out_of_range");
  refused(() => checkVoucher({ ...v, amount: 1_000_000_000_000_001n }, limits, 1_000n), "amount_out_of_range");
  refused(() => checkVoucher({ ...v, amount: 0n }, limits, 1_000n), "amount_out_of_range");
  refused(() => checkVoucher({ ...v, recipient: `0x${"0".repeat(40)}` }, limits, 1_000n), "recipient_not_allowed");
  refused(() => checkVoucher(v, { ...limits, faucet: undefined }, 1_000n), "not_configured", 503);
});

test("the daily allowance refuses what does not fit and starts again each UTC day", () => {
  const budget = new DailyBudget(10n);
  const day = 86_400_000;
  budget.spend(6n, 5 * day);
  refused(() => budget.spend(5n, 5 * day + 1), "daily_limit_reached", 429);
  budget.spend(4n, 5 * day + 2);
  refused(() => budget.spend(1n, 6 * day - 1), "daily_limit_reached", 429);
  budget.spend(10n, 6 * day);
});

test("configuration refuses shared keys, a key used as the token and a short token", () => {
  const key = (n: string) => `0x${n.repeat(64)}`;
  const env = { SIGNER_TOKEN: "t".repeat(32), CHAIN_ID: "668801", PUBLISHER_KEY: key("1"), RELAYER_KEY: key("2"), FAUCET_SIGNER_KEY: key("3") };
  const config = loadConfig(env);
  assert.equal(config.HOST, "::");
  assert.equal(config.MAX_FEE_PER_GAS_WEI, 1_000_000_000n);
  assert.equal(config.DISTRIBUTOR_ADDRESS, undefined);
  assert.throws(() => loadConfig({ ...env, RELAYER_KEY: key("1") }), /its own key/);
  assert.throws(() => loadConfig({ ...env, WATCH_KEY: key("2") }), /its own key/);
  assert.throws(() => loadConfig({ ...env, SIGNER_TOKEN: key("3") }), /must not be a signing key/);
  assert.throws(() => loadConfig({ ...env, SIGNER_TOKEN: "3".repeat(64) }), /must not be a signing key/);
  assert.throws(() => loadConfig({ ...env, SIGNER_TOKEN: "short" }));
  assert.throws(() => loadConfig({ ...env, PUBLISHER_KEY: "0x1234" }));
  assert.throws(() => loadConfig({ ...env, DISTRIBUTOR_ADDRESS: DISTRIBUTOR, FAUCET_ADDRESS: DISTRIBUTOR }), /must differ/);
  // A blank value is "not set".
  assert.equal(loadConfig({ ...env, FAUCET_SIGNER_KEY: " " }).FAUCET_SIGNER_KEY, undefined);
});
