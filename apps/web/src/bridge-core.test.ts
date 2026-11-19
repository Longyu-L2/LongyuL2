import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { concat, encodeFunctionData, keccak256, type Hex } from "viem";
// @ts-expect-error a plain JavaScript module without type declarations
import { DEFAULT_L1_RPC as BUILD_L1_RPC, connectSource, connectSources, publishedPage } from "../build.mjs";
import {
  CANCELLED,
  DEFAULT_L1_RPC,
  L2_CROSS_DOMAIN_MESSENGER,
  L2_STANDARD_BRIDGE,
  MAX_TRACKED,
  addTracked,
  describeWithdrawal,
  errorMessage,
  finalizeBridgeAbi,
  formatAmount,
  formatDuration,
  gasReserve,
  secondsToProve,
  isUnknownChain,
  l1TxUrl,
  l2TxUrl,
  loadTracked,
  longyuChainParams,
  messengerAbi,
  outputRootOf,
  parseAddress,
  parseAmount,
  parseConfig,
  parseTxHash,
  portalMajor,
  shareAmount,
  removeTracked,
  shortHex,
  statusView,
  wiringProblems,
  type BridgeConfig,
  type Observed,
  type RawConfig,
} from "./bridge-core.ts";

const E18 = 10n ** 18n;
const raw: RawConfig = {
  l1Portal: "0x1111111111111111111111111111111111111111",
  l1OutputOracle: "0x2222222222222222222222222222222222222222",
  l1StandardBridge: "0x3333333333333333333333333333333333333333",
  l1Token: "0x4444444444444444444444444444444444444444",
  l2Token: "0x5555555555555555555555555555555555555555",
  l2RpcUrl: "https://rpc-testnet.longyu.network",
  l1RpcUrl: "",
  explorerUrl: "https://scan-testnet.longyu.network/",
};
const cfg = (() => {
  const r = parseConfig(raw);
  assert.ok(r.ok);
  return r.config;
})();
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

test("amounts: exact parsing at 18 decimals", () => {
  assert.equal(parseAmount("1"), E18);
  assert.equal(parseAmount("1.5"), 15n * 10n ** 17n);
  assert.equal(parseAmount("0.000000000000000001"), 1n);
  assert.equal(parseAmount(".5"), 5n * 10n ** 17n);
  assert.equal(parseAmount("2."), 2n * E18);
  assert.equal(parseAmount("  007.25 "), 725n * 10n ** 16n);
  assert.equal(parseAmount("0"), 0n);
  assert.equal(parseAmount("123456789.123456789123456789"), 123456789123456789123456789n);
  assert.equal(parseAmount("1.5", 6), 1_500_000n);
});

test("amounts: anything else is refused", () => {
  const bad = ["", " ", ".", "-1", "+1", "1e18", "1E3", "1.0000000000000000001", "0x10", "1,5", "1.2.3", "Infinity", "NaN", "abc", "1 000", "١", "１", "--1", "1-"];
  for (const s of bad) assert.equal(parseAmount(s), null, JSON.stringify(s));
  assert.equal(parseAmount("1".repeat(61)), null);
  assert.equal(parseAmount("1.5", 0), null);
});

test("amounts: a share of the balance leaves gas behind and never exceeds what can be sent", () => {
  const E18 = 10n ** 18n;
  // A token that does not pay for gas: plain shares, the whole balance at Max.
  assert.equal(shareAmount(1000n * E18, 25), 250n * E18);
  assert.equal(shareAmount(1000n * E18, 100), 1000n * E18);
  const odd = 3_097_365_294_975_608n;
  assert.equal(formatAmount(shareAmount(odd, 25)), "0.000774");
  assert.equal(formatAmount(shareAmount(odd, 50)), "0.001548");
  assert.equal(shareAmount(odd, 100), odd);
  // Dust keeps its exact share, so a button never fills in nothing while there is a balance.
  assert.equal(shareAmount(999n, 50), 499n);
  assert.equal(shareAmount(0n, 100), 0n);

  // tBNB: the reserve stays, whatever share is asked for.
  const reserve = gasReserve(1_000_000n);
  assert.equal(reserve, 50_000_000_000_000n);
  assert.equal(shareAmount(odd, 100, reserve), odd - reserve);
  assert.equal(formatAmount(shareAmount(odd, 75, reserve)), "0.002323");
  assert.equal(shareAmount(reserve * 2n, 75, reserve), reserve);
  assert.equal(shareAmount(reserve, 100, reserve), 0n);
  assert.equal(shareAmount(reserve - 1n, 25, reserve), 0n);
  for (const percent of [1, 25, 50, 75, 99, 100]) {
    for (const balance of [0n, 1n, reserve, reserve + 1n, odd, 7n * E18 + 3n]) {
      const amount = shareAmount(balance, percent, reserve);
      assert.ok(amount >= 0n && amount + reserve <= (balance > reserve ? balance : reserve), `${percent}% of ${balance}`);
    }
  }
  // The reserve follows the gas price: half a million gas, and never under the floor.
  assert.equal(gasReserve(0n), 50_000_000_000_000n);
  assert.equal(gasReserve(-1n), 50_000_000_000_000n);
  assert.equal(gasReserve(3_000_000_000n), 1_500_000_000_000_000n);
  for (const bad of [0, 101, 12.5, Number.NaN]) assert.throws(() => shareAmount(E18, bad), RangeError);
});

test("amounts: exact formatting, and it round-trips", () => {
  assert.equal(formatAmount(0n), "0");
  assert.equal(formatAmount(E18), "1");
  assert.equal(formatAmount(1n), "0.000000000000000001");
  assert.equal(formatAmount(1_234_500_000_000_000_000n), "1.2345");
  assert.equal(formatAmount(123456789123456789123456789n), "123456789.123456789123456789");
  assert.equal(formatAmount(-15n * 10n ** 17n), "-1.5");
  assert.equal(formatAmount(1_500_000n, 6), "1.5");
  for (const v of [0n, 1n, 10n, E18 - 1n, E18, 7n * E18 + 3n, 2n ** 255n]) assert.equal(parseAmount(formatAmount(v)), v);
});

test("config: a complete configuration opens the bridge", () => {
  assert.equal(cfg.l1Portal, "0x1111111111111111111111111111111111111111");
  assert.equal(cfg.l1RpcUrl, DEFAULT_L1_RPC, "the L1 RPC defaults to a public BSC testnet node");
  assert.equal(cfg.explorerUrl, "https://scan-testnet.longyu.network", "trailing slash removed");
  const checksummed = parseConfig({ ...raw, l1Token: "0x55d398326f99059fF775485246999027B3197955" });
  assert.ok(checksummed.ok);
  assert.equal(checksummed.config.l1Token, "0x55d398326f99059fF775485246999027B3197955");
  const noExplorer = parseConfig({ ...raw, explorerUrl: "" });
  assert.ok(noExplorer.ok);
  assert.equal(noExplorer.config.explorerUrl, null);
  const local = parseConfig({ ...raw, l2RpcUrl: "http://localhost:8545", l1RpcUrl: "https://bsc.example/key/abc" });
  assert.ok(local.ok);
  assert.equal(local.config.l1RpcUrl, "https://bsc.example/key/abc");
});

test("config: a missing or bad value keeps the bridge closed", () => {
  const closed = (r: RawConfig | null | undefined, want: RegExp) => {
    const res = parseConfig(r);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.problems.some((p) => want.test(p)), `${res.problems.join("; ")} should match ${want}`);
  };
  closed(null, /L1_PORTAL is missing/);
  closed({}, /L2_RPC_URL is missing/);
  closed({ ...raw, l1Portal: "" }, /L1_PORTAL is missing/);
  closed({ ...raw, l1OutputOracle: "0x123" }, /L1_OUTPUT_ORACLE is not a valid address/);
  closed({ ...raw, l1StandardBridge: "0x0000000000000000000000000000000000000000" }, /L1_STANDARD_BRIDGE is not a valid address/);
  closed({ ...raw, l1Token: "0x55d398326f99059ff775485246999027B3197955" }, /L1_TOKEN is not a valid address/); // bad checksum
  closed({ ...raw, l2Token: "0x5555555555555555555555555555555555555555 0x1" }, /L2_TOKEN is not a valid address/);
  closed({ ...raw, l2Token: raw.l1Token }, /two of the addresses are the same/);
  closed({ ...raw, l2RpcUrl: "http://rpc-testnet.longyu.network" }, /L2_RPC_URL is not an https URL/);
  closed({ ...raw, l2RpcUrl: "https://user:pass@rpc.example" }, /L2_RPC_URL is not an https URL/);
  closed({ ...raw, l2RpcUrl: "javascript:alert(1)" }, /L2_RPC_URL is not an https URL/);
  closed({ ...raw, l1RpcUrl: "ftp://bsc.example" }, /L1_RPC_URL is not an https URL/);
  closed({ ...raw, explorerUrl: "scan.longyu.network" }, /EXPLORER_URL is not an https URL/);
  assert.equal(parseAddress(" 0x1111111111111111111111111111111111111111 "), "0x1111111111111111111111111111111111111111");
});

test("withdrawal status: labels and the one action each allows", () => {
  assert.deepEqual(statusView("waiting-to-prove"), { label: "Waiting to prove", action: null, tone: "wait" });
  assert.deepEqual(statusView("ready-to-prove"), { label: "Ready to prove", action: "prove", tone: "ready" });
  assert.deepEqual(statusView("waiting-to-finalize"), { label: "Waiting to finalize", action: null, tone: "wait" });
  assert.deepEqual(statusView("ready-to-finalize"), { label: "Ready to finalize", action: "finalize", tone: "ready" });
  assert.deepEqual(statusView("finalized"), { label: "Finalized", action: null, tone: "done" });
  assert.equal(statusView("pending").action, null);
  assert.equal(statusView("reverted").tone, "bad");
  assert.equal(statusView("not-withdrawal").action, null);
  assert.equal(statusView("error").label, "Status unavailable");
  assert.deepEqual(statusView("something-new"), { label: "Unknown", action: null, tone: "bad" });
  assert.deepEqual(statusView("ready-to-prove", { paused: true }), { label: "Paused on BSC", action: null, tone: "wait" });
  assert.deepEqual(statusView("ready-to-finalize", { paused: true }).action, null);
  assert.deepEqual(statusView("finalized", { paused: true }).label, "Finalized");
});

test("withdrawal status: time to prove follows LONGYU's block time and the next output", () => {
  const base = { submissionInterval: 3600n, blockTimeMs: 250n };
  // Block 19,500, next output at 21,600, newest block 19,600: 2,000 blocks at 250 ms, plus the proposer's delay.
  assert.equal(secondsToProve({ ...base, withdrawalBlock: 19_500n, nextOutputBlock: 21_600n, head: 19_600n }), 500 + 120);
  // The output's block already exists: only the proposer's delay is left.
  assert.equal(secondsToProve({ ...base, withdrawalBlock: 21_000n, nextOutputBlock: 21_600n, head: 21_700n }), 120);
  // The proposer is behind: the covering output is the first multiple at or after the withdrawal.
  assert.equal(secondsToProve({ ...base, withdrawalBlock: 21_601n, nextOutputBlock: 14_400n, head: 21_700n }), 3500 / 4 + 120);
  assert.equal(secondsToProve({ ...base, withdrawalBlock: 21_600n, nextOutputBlock: 14_400n, head: 21_700n }), 120);
  // Never longer than one interval plus the delay for a new withdrawal, and whole seconds rounded up.
  assert.equal(secondsToProve({ ...base, withdrawalBlock: 18_001n, nextOutputBlock: 21_600n, head: 18_001n }), 900 + 120);
  assert.equal(secondsToProve({ ...base, withdrawalBlock: 5n, nextOutputBlock: 3600n, head: 3599n }), 1 + 120);
  assert.equal(formatDuration(secondsToProve({ ...base, withdrawalBlock: 19_500n, nextOutputBlock: 21_600n, head: 19_600n })), "11 min");
});

test("withdrawal status: time left is rounded up", () => {
  assert.equal(formatDuration(0), "0 min");
  assert.equal(formatDuration(-5), "0 min");
  assert.equal(formatDuration(Number.NaN), "0 min");
  assert.equal(formatDuration(1), "1 min");
  assert.equal(formatDuration(60), "1 min");
  assert.equal(formatDuration(61), "2 min");
  assert.equal(formatDuration(3599), "1 h");
  assert.equal(formatDuration(3600), "1 h");
  assert.equal(formatDuration(3660), "1 h 1 min");
  assert.equal(formatDuration(86_399), "1 d");
  assert.equal(formatDuration(604_800), "7 d");
  assert.equal(formatDuration(604_810), "7 d 1 h", "viem adds a 10 s buffer; the display rounds up");
  assert.equal(formatDuration(608_400), "7 d 1 h");
  assert.equal(formatDuration(6 * 86_400 + 22 * 3600 + 1), "6 d 23 h");
});

test("tracked withdrawals: stored list is cleaned on load", () => {
  assert.deepEqual(loadTracked(null), []);
  assert.deepEqual(loadTracked(""), []);
  assert.deepEqual(loadTracked("not json"), []);
  assert.deepEqual(loadTracked('{"a":1}'), []);
  assert.deepEqual(loadTracked("null"), []);
  const upper = hash(1).toUpperCase().replace("0X", "0x");
  assert.deepEqual(loadTracked(JSON.stringify([hash(1), upper, 7, null, "0x12", `${hash(2)}00`, { h: hash(3) }, hash(2)])), [hash(1), hash(2)]);
  const many = Array.from({ length: 30 }, (_, i) => hash(i + 1));
  assert.equal(loadTracked(JSON.stringify(many)).length, MAX_TRACKED);
  assert.deepEqual(loadTracked(JSON.stringify(many)), many.slice(0, MAX_TRACKED));
});

test("tracked withdrawals: newest first, no repeats, at most 20, open ones kept", () => {
  assert.deepEqual(addTracked([], hash(1)), [hash(1)]);
  assert.deepEqual(addTracked([hash(1), hash(2)], hash(2)), [hash(2), hash(1)]);
  assert.deepEqual(addTracked([hash(1)], hash(1).toUpperCase().replace("0X", "0x")), [hash(1)]);
  assert.deepEqual(addTracked([hash(1)], "garbage"), [hash(1)]);
  const full = Array.from({ length: MAX_TRACKED }, (_, i) => hash(i + 1));
  const plain = addTracked(full, hash(99));
  assert.equal(plain.length, MAX_TRACKED);
  assert.equal(plain[0], hash(99));
  assert.ok(!plain.includes(hash(MAX_TRACKED)), "without finalized ones, the oldest goes");
  const kept = addTracked(full, hash(99), new Set([hash(3)]));
  assert.equal(kept.length, MAX_TRACKED);
  assert.ok(!kept.includes(hash(3)), "a finalized withdrawal goes first");
  assert.ok(kept.includes(hash(MAX_TRACKED)), "the oldest open withdrawal stays");
  assert.deepEqual(removeTracked([hash(1), hash(2)], hash(1).toUpperCase().replace("0X", "0x")), [hash(2)]);
  assert.equal(parseTxHash(` ${hash(5)} `), hash(5));
  for (const bad of ["", "0x", hash(1).slice(0, 65), `${hash(1)}0`, hash(1).replace("0x", "0X"), `0x${"g".repeat(64)}`]) assert.equal(parseTxHash(bad), null, bad);
});

test("withdrawal contents are read from the bridge message", () => {
  const user = "0x000000000000000000000000000000000000bEEF";
  const relay = (target: Hex, message: Hex, sender: Hex = L2_STANDARD_BRIDGE) =>
    encodeFunctionData({ abi: messengerAbi, functionName: "relayMessage", args: [1n, sender, target, 0n, 200_000n, message] });
  const eth = encodeFunctionData({ abi: finalizeBridgeAbi, functionName: "finalizeBridgeETH", args: [user, user, 3n * E18, "0x"] });
  const erc20 = encodeFunctionData({ abi: finalizeBridgeAbi, functionName: "finalizeBridgeERC20", args: [cfg.l1Token, cfg.l2Token, user, user, 5n, "0x"] });
  const other = encodeFunctionData({ abi: finalizeBridgeAbi, functionName: "finalizeBridgeERC20", args: [cfg.l1Token, user, user, user, 5n, "0x"] });
  const w = (data: Hex, sender: Hex = L2_CROSS_DOMAIN_MESSENGER, value = 0n) => ({ sender, target: "0x9999999999999999999999999999999999999999" as Hex, value, data });

  assert.deepEqual(describeWithdrawal(w(relay(cfg.l1StandardBridge, eth), L2_CROSS_DOMAIN_MESSENGER, 3n * E18), cfg), { asset: "tBNB", amount: 3n * E18, to: user });
  assert.deepEqual(describeWithdrawal(w(relay(cfg.l1StandardBridge, erc20)), cfg), { asset: "tLONG", amount: 5n, to: user });
  const none = { asset: null, amount: null, to: null };
  assert.deepEqual(describeWithdrawal(w(relay(cfg.l1StandardBridge, other)), cfg), none, "a different token pair is not tLONG");
  assert.deepEqual(describeWithdrawal(w(relay(cfg.l1Portal, eth)), cfg), none, "not addressed to the L1 bridge");
  assert.deepEqual(describeWithdrawal(w(relay(cfg.l1StandardBridge, eth, user)), cfg), none, "not sent by the L2 bridge");
  assert.deepEqual(describeWithdrawal(w(relay(cfg.l1StandardBridge, eth), user), cfg), none, "not from the L2 messenger");
  assert.deepEqual(describeWithdrawal(w("0xdeadbeef"), cfg), none);
  assert.deepEqual(describeWithdrawal(w("0x", user, 2n), cfg), { asset: "tBNB", amount: 2n, to: "0x9999999999999999999999999999999999999999" });
  assert.deepEqual(describeWithdrawal(w("0x", user, 0n), cfg), none);
});

test("output root: abi.encode of the four proof words, hashed", () => {
  const p = { version: hash(0), stateRoot: hash(1), messagePasserStorageRoot: hash(2), latestBlockhash: hash(3) };
  assert.equal(outputRootOf(p), keccak256(concat([p.version, p.stateRoot, p.messagePasserStorageRoot, p.latestBlockhash])));
});

test("wiring: the configured contracts must be LONGYU's own", () => {
  const messenger = "0x6666666666666666666666666666666666666666";
  const good: Observed = {
    l1ChainId: 97,
    l2ChainId: 668801,
    portalVersion: "2.8.1-beta.1",
    portalOracle: cfg.l1OutputOracle.toLowerCase(),
    bridgeMessenger: messenger,
    messengerPortal: cfg.l1Portal,
    l2OtherBridge: cfg.l1StandardBridge,
    l2OtherMessenger: messenger,
    l2TokenRemote: cfg.l1Token,
    l2TokenBridge: L2_STANDARD_BRIDGE.toLowerCase(),
    l1TokenDecimals: 18,
    l2TokenDecimals: 18,
  };
  assert.deepEqual(wiringProblems(good, cfg), []);
  const bad = (change: Partial<Observed>, want: RegExp) => {
    const p = wiringProblems({ ...good, ...change }, cfg as BridgeConfig);
    assert.equal(p.length, 1, p.join("; "));
    assert.match(p[0]!, want);
  };
  bad({ l1ChainId: 56 }, /L1_RPC_URL serves chain 56/);
  bad({ l2ChainId: 204 }, /L2_RPC_URL serves chain 204/);
  bad({ portalVersion: "3.10.0" }, /not an L2OutputOracle portal/);
  bad({ portalVersion: "" }, /not an L2OutputOracle portal/);
  bad({ portalOracle: messenger }, /L1_OUTPUT_ORACLE/);
  bad({ messengerPortal: messenger }, /L1_PORTAL/);
  bad({ l2OtherBridge: messenger }, /L1_STANDARD_BRIDGE/);
  bad({ l2OtherMessenger: cfg.l1Portal }, /messenger is not LONGYU's/);
  bad({ l2TokenRemote: cfg.l2Token }, /L2_TOKEN is not the LONGYU copy of L1_TOKEN/);
  bad({ l2TokenBridge: messenger }, /minted by the L2 standard bridge/);
  bad({ l1TokenDecimals: 6 }, /18 decimals/);
  bad({ l2TokenDecimals: 8 }, /18 decimals/);
  assert.equal(portalMajor("2.8.1-beta.1"), 2);
  assert.ok(Number.isNaN(portalMajor("v2")));
});

test("wallet: rejections read the same, unknown chains are detected", () => {
  assert.equal(errorMessage({ code: 4001, message: "whatever" }), CANCELLED);
  assert.equal(errorMessage(Object.assign(new Error("outer"), { cause: { name: "UserRejectedRequestError" } })), CANCELLED);
  assert.equal(errorMessage(new Error("MetaMask Tx Signature: User denied transaction signature.")), CANCELLED);
  assert.equal(errorMessage(Object.assign(new Error("long"), { shortMessage: "User rejected the request." })), CANCELLED);
  assert.equal(errorMessage(new Error("insufficient funds for gas * price + value")), "Not enough tBNB for gas.");
  assert.equal(errorMessage({ name: "WaitForTransactionReceiptTimeoutError" }), "Still pending. Check the transaction link.");
  assert.equal(errorMessage(new Error("Something broke")), "Something broke");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(new Error("x".repeat(500))).length, 200);
  assert.ok(isUnknownChain({ code: 4902 }));
  assert.ok(isUnknownChain({ code: -32603, data: { originalError: { code: 4902 } } }));
  assert.ok(isUnknownChain({ code: -32603, message: "Unrecognized chain ID \"0xa3481\"." }));
  assert.ok(!isUnknownChain({ code: 4001 }));
  assert.ok(!isUnknownChain(null));
});

test("links and wallet network parameters", () => {
  assert.equal(l1TxUrl(hash(1)), `https://testnet.bscscan.com/tx/${hash(1)}`);
  assert.equal(l2TxUrl(cfg.explorerUrl, hash(1)), `https://scan-testnet.longyu.network/tx/${hash(1)}`);
  assert.equal(l2TxUrl(null, hash(1)), null);
  assert.equal(shortHex(hash(1)), "0x0000…0001");
  assert.deepEqual(longyuChainParams(cfg), {
    chainId: "0xa3481",
    chainName: "LONGYU Testnet",
    nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: ["https://rpc-testnet.longyu.network"],
    blockExplorerUrls: ["https://scan-testnet.longyu.network"],
  });
  assert.equal("blockExplorerUrls" in longyuChainParams({ ...cfg, explorerUrl: null }), false);
});

const PAGES = ["index.html", "pay.html", "bridge.html", "swap.html", "safe.html"];
const sourceOf = (page: string) => readFileSync(new URL(`./${page}`, import.meta.url), "utf8");
const policyOf = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/.exec(html)?.[1];
const policy = (connect: string) => `default-src 'self'; connect-src ${connect}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; object-src 'none'`;
// As the live pages are built; the BSC testnet address carries its key in the path.
const live = { API_URL: "https://api-testnet.longyu.network", L2_RPC_URL: "https://rpc-testnet.longyu.network", L1_RPC_URL: "https://bsc-testnet.rpc.example/v1/0123456789abcdef" };

test("pages: every page's policy allows no base address and no plugin, and leaves its connections to the build", () => {
  for (const page of PAGES) {
    const html = sourceOf(page);
    assert.equal(html.match(/Content-Security-Policy/g)?.length, 1, page);
    assert.equal(policyOf(html), policy("https: http://localhost:*"), page);
    assert.doesNotMatch(html, /<(base|object|embed|applet)\b/i, page);
  }
});

test("build: a page may send requests to the addresses it was built with and to no other", () => {
  assert.equal(BUILD_L1_RPC, DEFAULT_L1_RPC);
  assert.deepEqual(connectSources("pay.html", live), ["https://api-testnet.longyu.network"]);
  assert.deepEqual(connectSources("bridge.html", live), ["https://rpc-testnet.longyu.network", "https://bsc-testnet.rpc.example"]);
  assert.deepEqual(connectSources("swap.html", live), ["https://rpc-testnet.longyu.network"]);
  assert.deepEqual(connectSources("safe.html", live), ["https://rpc-testnet.longyu.network", "https://bsc-testnet.rpc.example"]);
  // The claim page reads addresses the build does not know: its policy is left as it is.
  assert.equal(connectSources("index.html", live), null);
  assert.equal(connectSources("toString", live), null);

  // Only the origin is written: no path, key or anything else a setting carries after it.
  assert.equal(connectSource("L1_RPC_URL", "https://rpc.example/a;b 'unsafe-inline' *?key=1#h"), "https://rpc.example");
  assert.equal(connectSource("L2_RPC_URL", " HTTPS://RPC.Example:8545/ ".trim()), "https://rpc.example:8545");
  // Without L1_RPC_URL the pages read the public BSC testnet node.
  assert.deepEqual(connectSources("bridge.html", { ...live, L1_RPC_URL: " " }), ["https://rpc-testnet.longyu.network", DEFAULT_L1_RPC]);
  assert.deepEqual(connectSources("safe.html", { L2_RPC_URL: "https://rpc-testnet.longyu.network" }), ["https://rpc-testnet.longyu.network", DEFAULT_L1_RPC]);
  // One address named twice is written once.
  assert.deepEqual(connectSources("bridge.html", { L2_RPC_URL: "https://rpc.example/l2", L1_RPC_URL: "https://rpc.example/l1" }), ["https://rpc.example"]);
  // A page without its RPC address stays closed and may send nothing; one without an API address asks its own.
  assert.deepEqual(connectSources("swap.html", { ...live, L2_RPC_URL: "" }), ["'none'"]);
  assert.deepEqual(connectSources("bridge.html", { ...live, L2_RPC_URL: "" }), ["https://bsc-testnet.rpc.example"]);
  assert.deepEqual(connectSources("pay.html", { ...live, API_URL: "" }), ["'self'"]);
  // localhost is allowed only to a page built with a localhost address.
  assert.deepEqual(connectSources("pay.html", { ...live, API_URL: "http://localhost:8080" }), ["http://localhost:*"]);
  assert.deepEqual(connectSources("bridge.html", { L2_RPC_URL: "http://localhost:8545", L1_RPC_URL: "http://localhost:8546/" }), ["http://localhost:*"]);
  assert.deepEqual(connectSources("safe.html", { ...live, L2_RPC_URL: "http://localhost:8545" }), ["http://localhost:*", "https://bsc-testnet.rpc.example"]);
  for (const page of PAGES) assert.ok(!connectSources(page, live)?.some((s: string) => s.includes("localhost")), page);

  // In the published page nothing but the connections changes.
  const connect: Record<string, string> = {
    "pay.html": "https://api-testnet.longyu.network",
    "bridge.html": "https://rpc-testnet.longyu.network https://bsc-testnet.rpc.example",
    "swap.html": "https://rpc-testnet.longyu.network",
    "safe.html": "https://rpc-testnet.longyu.network https://bsc-testnet.rpc.example",
  };
  for (const page of PAGES) {
    const html = sourceOf(page);
    const out = publishedPage(page, html, live);
    if (!connect[page]) {
      assert.equal(out, html, page);
      continue;
    }
    assert.equal(policyOf(out), policy(connect[page]!), page);
    assert.equal(out.replace(`connect-src ${connect[page]};`, "connect-src https: http://localhost:*;"), html, page);
    assert.ok(!out.includes("0123456789abcdef"), page);
  }
});

test("build: an address that is not an https address stops the build", () => {
  for (const bad of [
    "rpc.example",
    "https://",
    "//rpc.example",
    "ftp://rpc.example",
    "wss://rpc.example",
    "javascript:alert(1)",
    "data:text/plain,x",
    "http://rpc.example",
    "http://127.0.0.1:8545",
    "http://localhost.rpc.example",
    "https://user:pw@rpc.example",
    "https://user@rpc.example",
    "https://*.example",
    "https://*",
    "https://[::1]:8545",
    "https://rpc'.example",
    "https://rpc.example; script-src *",
    "https://rpc_node.example",
    "https://rpc.example.",
  ]) {
    assert.throws(() => connectSource("L2_RPC_URL", bad), /^Error: L2_RPC_URL/, bad);
    assert.throws(() => publishedPage("swap.html", sourceOf("swap.html"), { ...live, L2_RPC_URL: bad }), /^Error: L2_RPC_URL/, bad);
  }
  assert.throws(() => publishedPage("pay.html", sourceOf("pay.html"), { ...live, API_URL: "api-testnet.longyu.network" }), /^Error: API_URL/);
  assert.throws(() => publishedPage("safe.html", sourceOf("safe.html"), { ...live, L1_RPC_URL: "http://bsc-testnet.rpc.example" }), /^Error: L1_RPC_URL/);
  // A setting a page does not use is not its concern.
  assert.equal(policyOf(publishedPage("swap.html", sourceOf("swap.html"), { ...live, API_URL: "x", L1_RPC_URL: "x" })), policy("https://rpc-testnet.longyu.network"));
  // A page whose policy the build cannot find is not published with the wide one.
  assert.throws(() => publishedPage("pay.html", sourceOf("pay.html").replace("connect-src", "connect-src "), live), /pay\.html/);
  assert.throws(() => publishedPage("pay.html", sourceOf("pay.html").repeat(2), live), /pay\.html/);
});
