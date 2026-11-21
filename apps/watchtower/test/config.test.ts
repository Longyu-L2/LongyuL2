import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const env = {
  L1_RPC_URLS: "https://bsc-rpc.publicnode.com, https://bsc-dataseed.bnbchain.org",
  L1_CHAIN_ID: "56",
  L1_OUTPUT_ORACLE: "0x2dC53f20F511Bf079167Ef013d6107787E620fE3",
  VERIFIER_NODE_URL: "http://verifier-node.railway.internal:8547",
  VERIFIER_GETH_URL: "http://verifier-geth.railway.internal:8545",
  L2_SEND_URL: "https://rpc.longyu.network",
  L2_CHAIN_ID: "668800",
  DATA_ORIGINS: "https://api.longyu.network",
};

test("config: mainnet settings, with defaults", () => {
  const c = loadConfig({ ...env, CHALLENGER_KEY: key(1), GUARDIAN_KEY: key(2) });
  assert.deepEqual(c.L1_RPC_URLS, ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"]);
  assert.equal(c.VETO_MARGIN_SECONDS, 7200n);
  assert.equal(c.OUTPUT_LATE_SECONDS, 1200n);
  assert.equal(c.CHALLENGER_MAX_FEE_PER_GAS_WEI, 5_000_000_000n);
});

test("config: refuses shared keys, mismatched chains and paths as origins", () => {
  assert.throws(() => loadConfig({ ...env, CHALLENGER_KEY: key(1), GUARDIAN_KEY: key(1) }), /two different keys/);
  assert.throws(() => loadConfig({ ...env, L2_CHAIN_ID: "668801" }), /mainnet \(668800\)/);
  assert.throws(() => loadConfig({ ...env, L1_CHAIN_ID: "97" }), /testnet \(668801\)/);
  assert.throws(() => loadConfig({ ...env, L1_CHAIN_ID: "1" }), /56 \(BSC\) or 97/);
  assert.throws(() => loadConfig({ ...env, DATA_ORIGINS: "https://api.longyu.network/data" }), /must be origins/);
  assert.throws(() => loadConfig({ ...env, CHALLENGER_KEY: "0x12" }), /32-byte hex key/);
});

test("config: blank values are not set", () => {
  const c = loadConfig({ ...env, CHALLENGER_KEY: " ", DISTRIBUTOR_ADDRESS: "" });
  assert.equal(c.CHALLENGER_KEY, undefined);
  assert.equal(c.DISTRIBUTOR_ADDRESS, undefined);
});
