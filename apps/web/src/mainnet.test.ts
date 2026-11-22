// Runs with the mainnet profile loaded first (node --import ./test-mainnet.mjs, as npm test does).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { DEFAULT_L1_RPC, L1_CHAIN_ID, L1_EXPLORER, L2_CHAIN_ID, describeWithdrawal, errorMessage, l1TxUrl, longyuChainParams, parseConfig, wiringProblems } from "./bridge-core.ts";
import { CALLS, CHAIN_NAMES } from "./safe-core.ts";
import { explorerTxUrl } from "./pay-core.ts";
import { rewardSymbol } from "./chain.ts";
import { L1_CHAIN, PROFILE } from "./profile.ts";
import { MINING_PHASE, WBNB, rateText, standing, tokenFrom } from "./swap-core.ts";
import { launchErrorMessage } from "./launch-core.ts";

const address = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const live = {
  l1Portal: address(1),
  l1OutputOracle: address(2),
  l1StandardBridge: address(3),
  l2RpcUrl: "https://rpc.longyu.network",
  explorerUrl: "https://scan.longyu.network",
};

test("mainnet: the pages see BNB Smart Chain and LONGYU 668800", () => {
  assert.equal(PROFILE.network, "mainnet", "run with --import ./test-mainnet.mjs");
  assert.equal(L1_CHAIN_ID, 56);
  assert.equal(L2_CHAIN_ID, 668800);
  assert.equal(L1_CHAIN.id, 56);
  assert.equal(L1_CHAIN.name, "BNB Smart Chain");
  assert.equal(L1_CHAIN.testnet, undefined);
  assert.equal(DEFAULT_L1_RPC, "https://bsc-rpc.publicnode.com");
  assert.equal(L1_EXPLORER, "https://bscscan.com");
  assert.deepEqual(PROFILE.l2.chain, {}, "LONGYU's viem chain carries no testnet flag");
  assert.deepEqual(CHAIN_NAMES, { 56: "BNB Smart Chain", 668800: "LONGYU" });
});

test("mainnet: the bridge moves BNB only, so it needs no token addresses and ignores them", () => {
  const bare = parseConfig(live);
  assert.ok(bare.ok, bare.ok ? "" : bare.problems.join("; "));
  assert.equal(bare.config.l1Token, null);
  assert.equal(bare.config.l2Token, null);
  assert.equal(bare.config.l1RpcUrl, "https://bsc-rpc.publicnode.com");
  const given = parseConfig({ ...live, l1Token: address(4), l2Token: "not an address" });
  assert.ok(given.ok);
  assert.equal(given.config.l2Token, null);
  // Still closed without a contract it cannot do without.
  assert.deepEqual(parseConfig({ ...live, l1Portal: "" }), { ok: false, problems: ["L1_PORTAL is missing"] });

  const observed = {
    l1ChainId: 56,
    l2ChainId: 668800,
    portalVersion: "2.8.1-beta.1",
    portalOracle: live.l1OutputOracle,
    bridgeMessenger: address(9),
    messengerPortal: live.l1Portal,
    l2OtherBridge: live.l1StandardBridge,
    l2OtherMessenger: address(9),
  };
  assert.deepEqual(wiringProblems(observed, bare.config), []);
  assert.deepEqual(wiringProblems({ ...observed, l1ChainId: 97, l2ChainId: 668801 }, bare.config), [
    "L1_RPC_URL serves chain 97, not 56",
    "L2_RPC_URL serves chain 668801, not 668800",
  ]);
  // A BNB withdrawal reads as BNB.
  const plain = { sender: address(5), target: address(6), value: 10n ** 18n, data: "0x" as const };
  assert.deepEqual(describeWithdrawal(plain, bare.config), { asset: "BNB", amount: 10n ** 18n, to: address(6) });
});

test("mainnet: names, symbols and links", () => {
  assert.deepEqual(longyuChainParams(live), {
    chainId: "0xa3480",
    chainName: "LONGYU",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://rpc.longyu.network"],
    blockExplorerUrls: ["https://scan.longyu.network"],
  });
  assert.equal(l1TxUrl("0xab"), "https://bscscan.com/tx/0xab");
  assert.equal(explorerTxUrl(56, "0xab"), "https://bscscan.com/tx/0xab");
  assert.equal(explorerTxUrl(97, "0xab"), "https://bscscan.com/tx/0xab");
  assert.equal(errorMessage(new Error("insufficient funds for gas * price + value")), "Not enough BNB for gas.");
  const network = { chainId: "668800", chainName: "LONGYU", rpcUrl: "https://rpc.longyu.network", explorerUrl: "", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, distributor: address(7) };
  assert.equal(rewardSymbol(network), "LONG");
});

test("mainnet: the Safe page knows no faucet call", () => {
  const names = new Set(CALLS.map((c) => c.fn.name));
  for (const name of ["drip", "lastDripAt", "dispensedToday", "maxPerVoucher"]) assert.ok(!names.has(name), name);
  assert.ok(names.has("grantRole"), "the other contracts' calls stay");
});

test("mainnet: the swap page lists LONG as not tradable yet, refuses look-alikes and trades other tokens against BNB", () => {
  const LONG = "0xc6D2B2483EC93C15109FCe43d21Ac05919031655";
  assert.equal(PROFILE.tradeToken, false);
  assert.equal(MINING_PHASE, "Official LONG is in its mining phase and not tradable yet.");
  assert.deepEqual(standing({ address: LONG.toLowerCase(), name: "LONGYU", symbol: "LONG" }, LONG, false), { kind: "mining", trade: false, note: MINING_PHASE });
  assert.deepEqual(standing({ address: address(8), name: "LONG", symbol: "L0NG" }, LONG, false), { kind: "imitation", trade: false, note: `Not LONGYU's token. The only official LONG is ${LONG}.` });
  assert.equal(standing({ address: address(8), name: "Moon Coffee", symbol: "MOON" }, LONG, true).trade, true);
  assert.equal(rateText({ bnb: 10n ** 18n, token: 2500n * 10n ** 18n }, 18, "MOON"), "1 BNB = 2500 MOON");
  assert.deepEqual(tokenFrom(WBNB, { name: { status: "success", result: "Wrapped BNB" }, symbol: { status: "success", result: "WBNB" }, decimals: { status: "success", result: 18 } }), { ok: false, error: "That is wrapped BNB. Choose the token to trade against BNB." });
  assert.equal(launchErrorMessage(new Error("insufficient funds for gas * price + value")), "Not enough BNB for gas.");
});
