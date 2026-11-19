import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  LOG_WINDOW,
  MAX_LOG_WINDOWS,
  addChainParams,
  formatAmount,
  logWindows,
  mineLinks,
  owed,
  proofFailure,
  rewardSymbol,
  trustedNetwork,
  watchAssetParams,
  type NetworkInfo,
} from "./chain.ts";

const network: NetworkInfo = {
  chainId: "668801",
  chainName: "LONGYU Testnet",
  rpcUrl: "https://rpc-testnet.longyu.network",
  explorerUrl: "https://scan-testnet.longyu.network",
  nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
  rewardToken: { address: "0x00000000000000000000000000000000000071c0", name: "LONGYU Testnet Token", symbol: "tLONG", decimals: 18 },
  distributor: "0x0",
};

test("wallet network parameters", () => {
  const p = addChainParams(network);
  assert.equal(p.chainId, "0xa3481");
  assert.deepEqual(p.rpcUrls, ["https://rpc-testnet.longyu.network"]);
  assert.equal(p.nativeCurrency.symbol, "tBNB");
});

test("reward token: tLONG on LONGYU, the native token when rewards are native", () => {
  assert.equal(rewardSymbol(network), "tLONG");
  assert.deepEqual(watchAssetParams(network), { type: "ERC20", options: { address: network.rewardToken!.address, symbol: "tLONG", decimals: 18 } });
  assert.equal(rewardSymbol({ ...network, rewardToken: null }), "tBNB");
  assert.equal(watchAssetParams({ ...network, rewardToken: null }), null);
  assert.equal(rewardSymbol({ ...network, rewardToken: undefined }), "tLONG");
});

test("the links to LONGYU MINE come only from an https address", () => {
  assert.deepEqual(mineLinks("https://mine-testnet.longyu.network"), {
    web: "https://mine-testnet.longyu.network/",
    android: "https://mine-testnet.longyu.network/download/android",
  });
  assert.deepEqual(mineLinks("https://mine.example/some/path?x=1#y"), { web: "https://mine.example/", android: "https://mine.example/download/android" });
  for (const bad of ["", "mine.example", "http://mine.example", "javascript:alert(1)", "data:text/html,x", "https://user:pw@mine.example", "//mine.example"]) {
    assert.equal(mineLinks(bad), null, bad);
  }
});

test("network details: a page built with them takes the API's answer only for the same chain and contract", () => {
  const builtIn: NetworkInfo = { ...network, distributor: "0x096ca64cB06f555c56F67FD618684D5C2b7F9e06" };
  const api: NetworkInfo = { ...builtIn, rpcUrl: "https://rpc2-testnet.longyu.network", chainName: "LONGYU" };
  assert.equal(trustedNetwork(api, builtIn), api);
  // An address reads the same in any case, a chain id as decimal text, hex text or a number.
  for (const same of [
    { ...api, distributor: builtIn.distributor.toLowerCase() },
    { ...api, distributor: `0x${builtIn.distributor.slice(2).toUpperCase()}` },
    { ...api, chainId: "0xa3481" },
    { ...api, chainId: 668801 as unknown as string },
  ]) assert.equal(trustedNetwork(same, builtIn), same, JSON.stringify(same));
  assert.equal(trustedNetwork(api, { ...builtIn, chainId: "0xA3481" }), api);

  // Another contract or another chain: the page keeps its own details, whatever else the answer holds.
  for (const other of [
    { ...api, distributor: "0x096ca64cB06f555c56F67FD618684D5C2b7F9e07" },
    { ...api, distributor: builtIn.distributor.slice(0, -1) },
    { ...api, distributor: ` ${builtIn.distributor}` },
    { ...api, distributor: "" },
    { ...api, distributor: undefined as unknown as string },
    { ...api, distributor: [builtIn.distributor] as unknown as string },
    { ...api, chainId: "97" },
    { ...api, chainId: "668801.0" },
    { ...api, chainId: "" },
    { ...api, chainId: null as unknown as string },
    { ...api, chainId: 668801.5 as unknown as string },
    {} as NetworkInfo,
  ]) assert.equal(trustedNetwork(other, builtIn), builtIn, JSON.stringify(other));
  // No answer, or one that is no object: the built-in details, as before.
  assert.equal(trustedNetwork(null, builtIn), builtIn);
  assert.equal(trustedNetwork("0x" as unknown as NetworkInfo, builtIn), builtIn);
  // A page built without a contract address cannot match one, so it never takes the API's.
  const partial = { ...builtIn, distributor: undefined as unknown as string };
  assert.equal(trustedNetwork(api, partial), partial);
  assert.equal(trustedNetwork({ ...api, distributor: undefined as unknown as string }, partial), partial);

  // Built without network details: the API's answer as it is, and nothing when there is none.
  assert.equal(trustedNetwork(api, null), api);
  assert.equal(trustedNetwork(null, null), null);
});

test("amounts", () => {
  assert.equal(formatAmount(24n * 10n ** 18n), "24");
  assert.equal(formatAmount(12_345_600_000_000_000_000n), "12.3456");
  assert.equal(owed(50n, 20n), 30n);
  assert.equal(owed(20n, 50n), 0n);
});

test("proof request: a 404 with the API's code is nothing to claim, only no answer or a 5xx reads the chain", () => {
  assert.equal(proofFailure(new ApiError(404, "no_active_root")), "nothing");
  assert.equal(proofFailure(new ApiError(404, "no_entitlement")), "nothing");
  // A 404 from something else in front of the API is not the API's answer.
  assert.equal(proofFailure(new ApiError(404, "not_found")), "error");
  assert.equal(proofFailure(new ApiError(404, undefined)), "error");
  assert.equal(proofFailure(new ApiError(400, "address_invalid")), "error");
  assert.equal(proofFailure(new ApiError(429, { message: "slow down" })), "error");
  assert.equal(proofFailure(new ApiError(500, "internal_error")), "chain");
  assert.equal(proofFailure(new ApiError(522, null)), "chain");
  assert.equal(proofFailure(new TypeError("Failed to fetch")), "chain");
  const e = new ApiError(404, "no_active_root");
  assert.deepEqual([e.status, e.code, e.message], [404, "no_active_root", "The LONGYU API answered 404."]);
  assert.equal(new ApiError(502, 7).code, null);
});

test("event search: the window the root's time points to, then back from the head, never over the RPC's limit", () => {
  const head = { number: 10_000_000n, timestamp: 1_800_000_000n };
  // Posted a day ago: 345,600 blocks back at four a second.
  const windows = logWindows(head, head.timestamp - 86_400n);
  assert.deepEqual(windows[0], { fromBlock: 9_629_400n, toBlock: 9_679_399n });
  assert.deepEqual(windows[1], { fromBlock: 9_950_001n, toBlock: 10_000_000n });
  assert.deepEqual(windows[2], { fromBlock: 9_900_001n, toBlock: 9_950_000n });
  assert.equal(windows.length, 1 + MAX_LOG_WINDOWS);
  assert.equal(windows.at(-1)!.fromBlock, head.number - BigInt(MAX_LOG_WINDOWS) * LOG_WINDOW + 1n);
  for (const w of windows) {
    assert.ok(w.fromBlock >= 0n && w.fromBlock <= w.toBlock && w.toBlock <= head.number);
    assert.ok(w.toBlock - w.fromBlock < LOG_WINDOW);
  }
  // The walk back leaves no gap between windows.
  for (let i = 2; i < windows.length; i++) assert.equal(windows[i]!.toBlock + 1n, windows[i - 1]!.fromBlock);

  // No time known: only the walk back.
  assert.deepEqual(logWindows(head, 0n)[0], { fromBlock: 9_950_001n, toBlock: 10_000_000n });
  assert.equal(logWindows(head, 0n).length, MAX_LOG_WINDOWS);
  // Posted moments ago, or a clock ahead of the head: the window ends at the head.
  assert.deepEqual(logWindows(head, head.timestamp - 10n)[0], { fromBlock: 9_974_960n, toBlock: 10_000_000n });
  assert.deepEqual(logWindows(head, head.timestamp + 60n)[0], { fromBlock: 9_975_000n, toBlock: 10_000_000n });
  // A young chain: everything stops at block 0.
  assert.deepEqual(logWindows({ number: 120_000n, timestamp: 1_800_000_000n }, 1_799_000_000n), [
    { fromBlock: 0n, toBlock: 49_999n },
    { fromBlock: 70_001n, toBlock: 120_000n },
    { fromBlock: 20_001n, toBlock: 70_000n },
    { fromBlock: 0n, toBlock: 20_000n },
  ]);
  assert.deepEqual(logWindows({ number: 0n, timestamp: 1_800_000_000n }, 0n), [{ fromBlock: 0n, toBlock: 0n }]);
});
