import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "./swap-core.ts";
import { encodeFunctionData, toFunctionSelector, type Address } from "viem";
import { CANCELLED } from "./bridge-core.ts";
import {
  DEADLINE_SECONDS,
  HIGH_IMPACT_BPS,
  LAUNCHED_NOTE,
  LAUNCHED_SHOWN,
  MINING_PHASE,
  MULTICALL3,
  NOT_A_TOKEN,
  PRICE_MOVED,
  SLIPPAGE_CHOICES,
  UNKNOWN_NOTE,
  WBNB,
  amountOut,
  cleanText,
  factoryAbi,
  formatBps,
  formatShort,
  impactBps,
  launcherAbi,
  linkParams,
  matchesSearch,
  mergeTokens,
  minimumOut,
  newestRange,
  orderReserves,
  pairAbi,
  parseSwapConfig,
  passesForLongyu,
  pastedAddress,
  portion,
  quote,
  rateText,
  readsAs,
  routerAbi,
  shareOf,
  standing,
  swapErrorMessage,
  swapWiringProblems,
  tokenFrom,
  type Read,
  type SwapConfig,
} from "./swap-core.ts";

const ROUTER = "0xed3Eb7fe322424C14cc356Ab182021cAb8dCf01A";
const FACTORY = "0xfE5372cA129113bf12EC70D1EE4A7cBB14f172B0";
const TOKEN = "0xF4769160D6dc78F66f61F0eA1638E65d43610163";
const RPC = "https://rpc.longyu.example";
// LONGYU Launch and the Swap contracts on mainnet (chain/mainnet/README.md).
const LAUNCHER = "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF";
const MAINNET = { router: "0x39232e1F40a70e1B9d6c78945a5Bc0aE769646B5", factory: "0xbCb5dFD7F8FBcB63eF4438E62F3b8456F08Ee693", long: "0xc6D2B2483EC93C15109FCe43d21Ac05919031655" } as const;
const raw = { router: ROUTER, factory: FACTORY, token: TOKEN, rpcUrl: RPC, explorerUrl: "https://scan.longyu.example/" };
const E18 = 10n ** 18n;

function config(): SwapConfig {
  const parsed = parseSwapConfig(raw);
  assert.ok(parsed.ok);
  return parsed.config;
}
function problems(change: Record<string, string | null | undefined>): string[] {
  const parsed = parseSwapConfig({ ...raw, ...change });
  assert.ok(!parsed.ok, "expected the settings to be refused");
  return parsed.problems;
}

test("settings: a complete set is accepted", () => {
  assert.deepEqual(config(), { router: ROUTER, factory: FACTORY, token: TOKEN, launcher: null, rpcUrl: RPC, explorerUrl: "https://scan.longyu.example", apiUrl: null });
  // The explorer is optional; lower-case addresses come back checksummed.
  const parsed = parseSwapConfig({ ...raw, explorerUrl: "", router: ROUTER.toLowerCase() });
  assert.ok(parsed.ok);
  assert.equal(parsed.config.explorerUrl, null);
  assert.equal(parsed.config.router, ROUTER);
  assert.ok(parseSwapConfig({ ...raw, rpcUrl: "http://localhost:8545" }).ok);
});

test("settings: nothing is guessed", () => {
  assert.deepEqual(problems({ router: "", factory: null, token: undefined, rpcUrl: " " }), [
    "SWAP_ROUTER is missing",
    "SWAP_FACTORY is missing",
    "L2_TOKEN is missing",
    "L2_RPC_URL is missing",
  ]);
  for (const nothing of [null, undefined, {}]) {
    const parsed = parseSwapConfig(nothing);
    assert.ok(!parsed.ok);
    assert.equal(parsed.problems.length, 4);
  }
  assert.deepEqual(problems({ router: "0x1234" }), ["SWAP_ROUTER is not a valid address"]);
  assert.deepEqual(problems({ factory: `0x${"0".repeat(40)}` }), ["SWAP_FACTORY is not a valid address"]);
  // A wrong checksum is a mistyped address.
  assert.deepEqual(problems({ token: TOKEN.replace("F4", "f4") }), ["L2_TOKEN is not a valid address"]);
  assert.deepEqual(problems({ token: WBNB }), ["L2_TOKEN is the wrapped BNB contract"]);
  assert.deepEqual(problems({ factory: ROUTER }), ["two of the addresses are the same"]);
  assert.deepEqual(problems({ factory: ROUTER.toLowerCase() }), ["two of the addresses are the same"]);
  assert.deepEqual(problems({ rpcUrl: "http://rpc.longyu.example" }), ["L2_RPC_URL is not an https URL"]);
  assert.deepEqual(problems({ rpcUrl: "https://user:pass@rpc.longyu.example" }), ["L2_RPC_URL is not an https URL"]);
  assert.deepEqual(problems({ explorerUrl: "javascript:alert(1)" }), ["EXPLORER_URL is not an https URL"]);
});

test("settings: LONGYU Launch is optional, and checked when it is set", () => {
  const parsed = parseSwapConfig({ ...raw, launcher: LAUNCHER.toLowerCase() });
  assert.ok(parsed.ok);
  assert.equal(parsed.config.launcher, LAUNCHER);
  for (const nothing of ["", " ", null, undefined]) {
    const without = parseSwapConfig({ ...raw, launcher: nothing });
    assert.ok(without.ok);
    assert.equal(without.config.launcher, null);
  }
  assert.deepEqual(problems({ launcher: "0x1234" }), ["TOKEN_LAUNCHER is not a valid address"]);
  assert.deepEqual(problems({ launcher: LAUNCHER.replace("F6f", "f6f") }), ["TOKEN_LAUNCHER is not a valid address"]);
  assert.deepEqual(problems({ launcher: WBNB }), ["TOKEN_LAUNCHER is the wrapped BNB contract"]);
  assert.deepEqual(problems({ launcher: ROUTER }), ["two of the addresses are the same"]);
  assert.deepEqual(problems({ launcher: TOKEN.toLowerCase() }), ["two of the addresses are the same"]);
});

test("wiring: the configured contracts must be LONGYU Swap's", () => {
  const cfg = config();
  const good = { chainId: 668801, routerFactory: FACTORY.toLowerCase(), routerWrapped: WBNB, tokenDecimals: 18 };
  assert.deepEqual(swapWiringProblems(good, cfg, 668801), []);
  assert.deepEqual(swapWiringProblems({ ...good, chainId: 97 }, cfg, 668801), ["L2_RPC_URL serves chain 97, not 668801"]);
  assert.deepEqual(swapWiringProblems({ ...good, routerFactory: TOKEN }, cfg, 668801), ["SWAP_FACTORY is not the router's factory"]);
  assert.deepEqual(swapWiringProblems({ ...good, routerWrapped: TOKEN }, cfg, 668801), ["the router's wrapped token is not WBNB"]);
  assert.deepEqual(swapWiringProblems({ ...good, tokenDecimals: 6 }, cfg, 668801), ["tLONG must have 18 decimals"]);
  assert.equal(swapWiringProblems({ chainId: 1, routerFactory: TOKEN, routerWrapped: TOKEN, tokenDecimals: 8 }, cfg, 668801).length, 4);
});

test("constants: the chain's built-in contracts and the limits", () => {
  assert.equal(WBNB, "0x4200000000000000000000000000000000000006");
  assert.equal(MULTICALL3, "0xcA11bde05977b3631167028862bE2a173976CA11");
  assert.equal(DEADLINE_SECONDS, 1200);
  assert.deepEqual([...SLIPPAGE_CHOICES], [50, 100, 300]);
  assert.equal(HIGH_IMPACT_BPS, 500);
  // The constants are the ones recorded for the testnet.
  const readme = readFileSync(new URL("../../../chain/testnet/README.md", import.meta.url), "utf8");
  for (const address of [WBNB, ROUTER, FACTORY, TOKEN]) assert.ok(readme.includes(address), `${address} is not recorded in chain/testnet/README.md`);
  // And the mainnet's, which the network test builds with.
  const mainnet = readFileSync(new URL("../../../chain/mainnet/README.md", import.meta.url), "utf8");
  for (const address of [LAUNCHER, MAINNET.router, MAINNET.factory, MAINNET.long]) assert.ok(mainnet.includes(address), `${address} is not recorded in chain/mainnet/README.md`);
  assert.equal(LAUNCHED_SHOWN, 50);
});

test("amountOut: the pool's own formula, rounded down", () => {
  // Uniswap V2's reference case: 1 in against 5 and 10, with the 0.3% fee.
  assert.equal(amountOut(1n * E18, 5n * E18, 10n * E18), 1662497915624478906n);
  assert.equal(amountOut(1n * E18, 10n * E18, 5n * E18), 453305446940074565n);
  // By hand: 997,000 * 1000 / (1,000,000 + 997,000) = 499.2, so 499; and 99,700 * 1,000,000 / 1,000,099,700 = 99.6, so 99.
  assert.equal(amountOut(1000n, 1000n, 1000n), 499n);
  assert.equal(amountOut(100n, 1_000_000n, 1_000_000n), 99n);
  assert.equal(amountOut(1n, 1_000_000n, 1_000_000n), 0n);
  // Never the whole reserve, however much is paid in.
  assert.ok(amountOut(10n ** 40n, 5n * E18, 10n * E18) < 10n * E18);
  for (const [i, a, b] of [[0n, 5n, 10n], [-1n, 5n, 10n], [1n, 0n, 10n], [1n, 5n, 0n]] as const) assert.equal(amountOut(i, a, b), 0n);
});

test("amountOut: the pool accepts it and refuses one unit more", () => {
  // The pair's check: (reserveIn + in) * 1000 - in * 3, times (reserveOut - out) * 1000, must not fall below k.
  const holds = (amountIn: bigint, out: bigint, rIn: bigint, rOut: bigint) =>
    ((rIn + amountIn) * 1000n - amountIn * 3n) * ((rOut - out) * 1000n) >= rIn * rOut * 1_000_000n;
  const cases: [bigint, bigint, bigint][] = [
    [E18 / 1000n, 15n * E18 / 1000n, 750n * E18],
    [50n * E18, 750n * E18, 15n * E18 / 1000n],
    [1n, 3n, 7n],
    [123_456_789n, 987_654_321_000n, 55_555n],
    [2n ** 100n, 2n ** 111n, 2n ** 111n],
  ];
  for (const [amountIn, rIn, rOut] of cases) {
    const out = amountOut(amountIn, rIn, rOut);
    assert.ok(holds(amountIn, out, rIn, rOut), `the pool refuses ${amountIn}`);
    assert.ok(!holds(amountIn, out + 1n, rIn, rOut), `the quote for ${amountIn} is not the most the pool pays`);
  }
});

test("quote: the pool's ratio, rounded down", () => {
  assert.equal(quote(1n * E18, 15n * E18 / 1000n, 750n * E18), 50_000n * E18);
  assert.equal(quote(750n * E18, 750n * E18, 15n * E18 / 1000n), 15n * E18 / 1000n);
  assert.equal(quote(10n, 3n, 1n), 3n);
  assert.equal(quote(1n, 3n, 1n), 0n);
  for (const [a, ra, rb] of [[0n, 1n, 1n], [1n, 0n, 1n], [1n, 1n, 0n], [-5n, 1n, 1n]] as const) assert.equal(quote(a, ra, rb), 0n);
});

test("minimumOut: the amount less the slippage, never rounded up", () => {
  assert.equal(minimumOut(1000n, 50), 995n);
  assert.equal(minimumOut(1000n, 100), 990n);
  assert.equal(minimumOut(1000n, 300), 970n);
  assert.equal(minimumOut(999n, 50), 994n);
  assert.equal(minimumOut(1n, 50), 0n);
  assert.equal(minimumOut(1000n, 0), 1000n);
  assert.equal(minimumOut(1000n, 10_000), 0n);
  assert.equal(minimumOut(0n, 50), 0n);
  assert.equal(minimumOut(-3n, 50), 0n);
  for (const bad of [-1, 10_001, 0.5, Number.NaN]) assert.throws(() => minimumOut(1000n, bad), RangeError);
  // Every choice on the page leaves a real limit.
  for (const bps of SLIPPAGE_CHOICES) assert.ok(minimumOut(E18, bps) >= (E18 * 97n) / 100n);
});

test("impactBps: how far a trade moves its own price; the fee is not impact", () => {
  const [rIn, rOut] = [1000n * E18, 1000n * E18];
  // A tiny trade against a deep pool: nothing beyond rounding.
  const small = E18 / 1000n;
  assert.ok(impactBps(small, amountOut(small, rIn, rOut), rIn, rOut) <= 1);
  // 1% of the pool moves the price about 1%, 10% about 9%.
  const one = impactBps(10n * E18, amountOut(10n * E18, rIn, rOut), rIn, rOut);
  assert.ok(one >= 98 && one <= 100, String(one));
  const ten = impactBps(100n * E18, amountOut(100n * E18, rIn, rOut), rIn, rOut);
  assert.ok(ten >= 905 && ten <= 910, String(ten));
  assert.ok(ten >= HIGH_IMPACT_BPS);
  // Rounded up, never above 100%, and zero when there is nothing to compare.
  assert.equal(impactBps(10n ** 40n, amountOut(10n ** 40n, rIn, rOut), rIn, rOut), 10_000);
  assert.equal(impactBps(0n, 0n, rIn, rOut), 0);
  assert.equal(impactBps(E18, 0n, 0n, rOut), 0);
  assert.equal(impactBps(1000n, 997n, 1000n, 1000n), 0);
  assert.equal(impactBps(1000n, 996n, 1000n, 1000n), 11);
});

test("orderReserves: by asset, whichever way the pair sorts", () => {
  assert.deepEqual(orderReserves(WBNB, TOKEN, TOKEN, 1n, 2n), { bnb: 1n, token: 2n });
  assert.deepEqual(orderReserves(TOKEN.toLowerCase(), WBNB, TOKEN, 1n, 2n), { bnb: 2n, token: 1n });
  // Any other pair is not this page's pool.
  assert.equal(orderReserves(WBNB, ROUTER, TOKEN, 1n, 2n), null);
  assert.equal(orderReserves(TOKEN, TOKEN, TOKEN, 1n, 2n), null);
  assert.equal(orderReserves(WBNB, WBNB, TOKEN, 1n, 2n), null);
});

test("shareOf and portion: what pool tokens return", () => {
  const reserves = { bnb: 15n * E18 / 1000n, token: 750n * E18 };
  assert.deepEqual(shareOf(50n, 100n, reserves), { bnb: reserves.bnb / 2n, token: reserves.token / 2n });
  assert.deepEqual(shareOf(100n, 100n, reserves), reserves);
  assert.deepEqual(shareOf(1n, 3n, { bnb: 10n, token: 20n }), { bnb: 3n, token: 6n });
  assert.deepEqual(shareOf(0n, 100n, reserves), { bnb: 0n, token: 0n });
  assert.deepEqual(shareOf(5n, 0n, reserves), { bnb: 0n, token: 0n });
  assert.equal(portion(1000n, 25), 250n);
  assert.equal(portion(999n, 50), 499n);
  assert.equal(portion(999n, 100), 999n);
  assert.equal(portion(3n, 25), 0n);
  for (const bad of [0, 101, 12.5, -25]) assert.throws(() => portion(1000n, bad), RangeError);
});

test("display: amounts are cut, never rounded up", () => {
  assert.equal(formatShort(0n), "0");
  assert.equal(formatShort(-5n), "0");
  assert.equal(formatShort(E18), "1");
  assert.equal(formatShort(1_500_000n * E18), "1500000");
  assert.equal(formatShort(1_234_567_890_123_456_789n), "1.234567");
  assert.equal(formatShort(1_999_999_999_999_999_999n), "1.999999");
  assert.equal(formatShort(15n * E18 / 1000n), "0.015");
  assert.equal(formatShort(10n ** 12n), "0.000001");
  assert.equal(formatShort(10n ** 12n - 1n), "<0.000001");
  assert.equal(formatShort(1n), "<0.000001");
  assert.equal(formatShort(1_234_567n, 2, 6), "1.23");
  // A token with fewer decimals than places shown: all of them, and nothing below one unit.
  assert.equal(formatShort(12_345n, 6, 2), "123.45");
  assert.equal(formatShort(7n, 6, 0), "7");
  assert.equal(formatShort(1n, 6, 3), "0.001");
  assert.equal(formatBps(0), "0%");
  assert.equal(formatBps(-3), "0%");
  assert.equal(formatBps(1), "0.01%");
  assert.equal(formatBps(42), "0.42%");
  assert.equal(formatBps(50), "0.5%");
  assert.equal(formatBps(100), "1%");
  assert.equal(formatBps(300), "3%");
  assert.equal(formatBps(1000), "10%");
  assert.equal(formatBps(10_000), "100%");
});

test("errors: the contracts' refusals in plain words", () => {
  const reverted = (reason: string) => {
    const cause = Object.assign(new Error(`execution reverted: ${reason}`), { name: "ContractFunctionRevertedError" });
    return Object.assign(new Error("The contract function reverted."), { shortMessage: `The contract function "x" reverted with the following reason:\n${reason}`, cause });
  };
  for (const reason of ["UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT", "UniswapV2Router: INSUFFICIENT_A_AMOUNT", "UniswapV2Router: INSUFFICIENT_B_AMOUNT"]) {
    assert.equal(swapErrorMessage(reverted(reason)), PRICE_MOVED, reason);
  }
  assert.equal(swapErrorMessage(reverted("UniswapV2Router: EXPIRED")), "That took too long. Try again.");
  for (const reason of [
    "UniswapV2: INSUFFICIENT_LIQUIDITY_MINTED",
    "UniswapV2: INSUFFICIENT_LIQUIDITY_BURNED",
    "UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT",
    "UniswapV2Library: INSUFFICIENT_AMOUNT",
    "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT",
    "ds-math-sub-underflow",
  ]) {
    assert.equal(swapErrorMessage(reverted(reason)), "Amount too small.", reason);
  }
  for (const reason of ["UniswapV2: INSUFFICIENT_LIQUIDITY", "UniswapV2Library: INSUFFICIENT_LIQUIDITY"]) {
    assert.equal(swapErrorMessage(reverted(reason)), "The pool cannot fill this amount.", reason);
  }
  for (const reason of ["TransferHelper: TRANSFER_FROM_FAILED", "TransferHelper: TRANSFER_FAILED"]) {
    assert.equal(swapErrorMessage(reverted(reason)), "The token refused the transfer.", reason);
  }
  // A reason found only deeper in the chain of causes still counts.
  assert.equal(swapErrorMessage({ message: "failed", cause: { message: "x", cause: { message: "UniswapV2Router: EXPIRED" } } }), "That took too long. Try again.");
  // A rejection in the wallet is never read as a refusal by the pool.
  assert.equal(swapErrorMessage(Object.assign(new Error("User rejected: UniswapV2Router: EXPIRED"), { code: 4001 })), CANCELLED);
  assert.equal(swapErrorMessage(new Error("User denied transaction signature")), CANCELLED);
  assert.equal(swapErrorMessage(new Error("insufficient funds for gas * price + value")), "Not enough tBNB for gas.");
  assert.equal(swapErrorMessage(new Error("Network busy. Try again.")), "Network busy. Try again.");
  assert.equal(swapErrorMessage("plain text"), "plain text");
  assert.equal(swapErrorMessage(null), "null");
});

test("ABIs: the calls the page sends are the router's", () => {
  const sender: Address = "0x1111111111111111111111111111111111111111";
  // Selectors of the Uniswap V2 router, as deployed (contracts/dex).
  const selectors = {
    swapExactETHForTokensSupportingFeeOnTransferTokens: "0xb6f9de95",
    swapExactTokensForETHSupportingFeeOnTransferTokens: "0x791ac947",
    addLiquidityETH: "0xf305d719",
    removeLiquidityETHSupportingFeeOnTransferTokens: "0xaf2979eb",
  } as const;
  const calls = {
    swapExactETHForTokensSupportingFeeOnTransferTokens: encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [1n, [WBNB, TOKEN], sender, 2n] }),
    swapExactTokensForETHSupportingFeeOnTransferTokens: encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [3n, 1n, [TOKEN, WBNB], sender, 2n] }),
    addLiquidityETH: encodeFunctionData({ abi: routerAbi, functionName: "addLiquidityETH", args: [TOKEN, 3n, 2n, 1n, sender, 2n] }),
    removeLiquidityETHSupportingFeeOnTransferTokens: encodeFunctionData({ abi: routerAbi, functionName: "removeLiquidityETHSupportingFeeOnTransferTokens", args: [TOKEN, 3n, 2n, 1n, sender, 2n] }),
  };
  for (const [name, selector] of Object.entries(selectors)) assert.equal(calls[name as keyof typeof calls].slice(0, 10), selector, name);
  assert.equal(toFunctionSelector(factoryAbi[0]), "0xe6a43905");
  assert.equal(toFunctionSelector(pairAbi.find((x) => x.type === "function" && x.name === "getReserves")!), "0x0902f1ac");
  // The deployed router's source has each of them.
  const source = readFileSync(new URL("../../../contracts/dex/src/periphery/UniswapV2Router02.sol", import.meta.url), "utf8");
  for (const name of Object.keys(selectors)) assert.match(source, new RegExp(`function ${name}\\(`), name);
  // And the launcher's calls are TokenLauncher's.
  const launcher = { launch: "0xb104b321", tokenCount: "0x9f181b5e", tokensFrom: "0x47367988", launched: "0xd03915b2", passesForLongyu: "0xf2580be2" } as const;
  const launcherSource = readFileSync(new URL("../../../contracts/src/TokenLauncher.sol", import.meta.url), "utf8");
  for (const [name, selector] of Object.entries(launcher)) {
    assert.equal(toFunctionSelector(launcherAbi.find((x) => x.type === "function" && x.name === name)!), selector, name);
    // launched is the getter of a public mapping.
    assert.match(launcherSource, new RegExp(`function ${name}\\(|public ${name};`), name);
  }
  assert.ok(launcherSource.includes("event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 supply);"));
  for (const error of ["BadName", "BadSymbol", "BadSupply", "ReservedName"]) assert.ok(launcherSource.includes(`error ${error}();`), error);
});

// ------------------------------------------------------------------ tokens

const ok = (result: unknown): Read => ({ status: "success", result });
const failed: Read = { status: "failure", error: new Error("reverted") };
const reads = (name: unknown, symbol: unknown, decimals: unknown) => ({ name: ok(name), symbol: ok(symbol), decimals: ok(decimals) });
const MOON: Address = "0x1111111111111111111111111111111111111111";

test("tokens: a token is what answers as an ERC-20, cleaned for the page", () => {
  assert.deepEqual(tokenFrom(MOON, { ...reads("Moon Coffee", "MOON", 18), totalSupply: ok(10n ** 24n) }), { ok: true, token: { address: MOON, name: "Moon Coffee", symbol: "MOON", decimals: 18 } });
  assert.deepEqual(tokenFrom(MOON, reads("Six", "SIX", 6)), { ok: true, token: { address: MOON, name: "Six", symbol: "SIX", decimals: 6 } });
  assert.deepEqual(tokenFrom(MOON, reads("Zero", "ZERO", 0)), { ok: true, token: { address: MOON, name: "Zero", symbol: "ZERO", decimals: 0 } });
  // A name that is empty once cleaned reads as the symbol.
  assert.deepEqual(tokenFrom(MOON, reads(" \u0000 ", "X", 18)), { ok: true, token: { address: MOON, name: "X", symbol: "X", decimals: 18 } });
  // Anything else is not a token here: a call that fails, a wrong answer, an NFT without decimals, no supply.
  const bad = [
    { name: failed, symbol: ok("A"), decimals: ok(18) },
    { name: ok("A"), symbol: failed, decimals: ok(18) },
    { name: ok("A"), symbol: ok("A"), decimals: failed },
    { ...reads("A", "A", 18), totalSupply: failed },
    { ...reads("A", "A", 18), totalSupply: ok("1") },
    reads(1n, "A", 18),
    reads("A", "A", 18n),
    reads("A", "A", -1),
    reads("A", "A", 1.5),
  ];
  bad.forEach((r, i) => assert.deepEqual(tokenFrom(MOON, r), { ok: false, error: NOT_A_TOKEN }, String(i)));
  assert.deepEqual(tokenFrom(MOON, reads("Big", "BIG", 24)), { ok: false, error: "This page trades tokens with up to 18 decimals." });
  assert.deepEqual(tokenFrom(MOON, reads("Blank", " ​ ", 18)), { ok: false, error: "That token has no symbol." });
  assert.deepEqual(tokenFrom(WBNB, reads("Wrapped BNB", "WBNB", 18)), { ok: false, error: "That is wrapped tBNB. Choose the token to trade against tBNB." });
  assert.equal(tokenFrom(WBNB.toLowerCase() as Address, reads("Wrapped BNB", "WBNB", 18)).ok, false);
});

test("tokens: text is shown without controls or direction marks, and cut", () => {
  assert.equal(cleanText("  Moon   Coffee \n", 40), "Moon Coffee");
  // A right-to-left override would show "GNOL" as "LONG"; it is dropped, and so are zero-width characters.
  assert.equal(cleanText("‮GNOL‬", 16), "GNOL");
  assert.equal(cleanText("L​O‍NG", 16), "LONG");
  assert.equal(cleanText("A\u0007B C", 16), "ABC");
  assert.equal(cleanText("x".repeat(41), 40), `${"x".repeat(39)}…`);
  assert.equal(cleanText("x".repeat(40), 40), "x".repeat(40));
  // Cut by characters, never inside one.
  assert.equal(cleanText("\u{1F600}".repeat(20), 16), `${"\u{1F600}".repeat(15)}…`);
});

test("tokens: the newest launched tokens, for tokensFrom", () => {
  assert.deepEqual(newestRange(0n), { start: 0n, count: 0n });
  assert.deepEqual(newestRange(-1n), { start: 0n, count: 0n });
  assert.deepEqual(newestRange(1n), { start: 0n, count: 1n });
  assert.deepEqual(newestRange(50n), { start: 0n, count: 50n });
  assert.deepEqual(newestRange(51n), { start: 1n, count: 50n });
  assert.deepEqual(newestRange(1234n), { start: 1184n, count: 50n });
  assert.deepEqual(newestRange(7n, 3), { start: 4n, count: 3n });
});

test("tokens: lists merge with each token once, the first list winning", () => {
  const a = { address: "0xAA00000000000000000000000000000000000001", from: "listed" };
  const b = { address: "0xbb00000000000000000000000000000000000002", from: "launched" };
  const aAgain = { address: a.address.toLowerCase(), from: "launched" };
  assert.deepEqual(mergeTokens([a], [aAgain, b], [b]), [a, b]);
  assert.deepEqual(mergeTokens([], [b], []), [b]);
  assert.deepEqual(mergeTokens(), []);
});

test("tokens: the search matches symbol, name or the start of the address", () => {
  const t = { address: "0xAbC0000000000000000000000000000000000001" as Address, name: "Moon Coffee", symbol: "MOON", decimals: 18 };
  for (const q of ["", "  ", "moon", "MOO", "coffee", "n co", "0xabc", "0xABC0", t.address]) assert.ok(matchesSearch(t, q), q);
  for (const q of ["sun", "0xabd", "abc"]) assert.ok(!matchesSearch(t, q), q);
});

test("tokens: a pasted address is checked before it is read", () => {
  // Words, and an address still being typed, are a search.
  for (const text of ["", "moon", "0x", "0x12", ` ${MOON.slice(0, 41)}`]) assert.equal(pastedAddress(text), null, text);
  assert.deepEqual(pastedAddress(` ${TOKEN} `), { address: TOKEN });
  assert.deepEqual(pastedAddress(TOKEN.toLowerCase()), { address: TOKEN });
  // Mixed case is a checksum, and capitals only do not match one.
  assert.deepEqual(pastedAddress(`0x${TOKEN.slice(2).toUpperCase()}`), { error: "Check the address: its capital letters do not match it." });
  assert.deepEqual(pastedAddress(TOKEN.replace("F4", "f4")), { error: "Check the address: its capital letters do not match it." });
  assert.deepEqual(pastedAddress(`${TOKEN}1`), { error: "That is not an address." });
  assert.deepEqual(pastedAddress(`0x${"g".repeat(40)}`), { error: "That is not an address." });
  assert.deepEqual(pastedAddress(`0x${"0".repeat(40)}`), { error: "That is not an address." });
});

test("tokens: a link names a token and a mode", () => {
  assert.deepEqual(linkParams(`?token=${TOKEN}&mode=add`), { token: TOKEN, badToken: false, mode: "add" });
  assert.deepEqual(linkParams(`?token=${TOKEN.toLowerCase()}`), { token: TOKEN, badToken: false, mode: null });
  assert.deepEqual(linkParams("?mode=remove"), { token: null, badToken: false, mode: "remove" });
  assert.deepEqual(linkParams(""), { token: null, badToken: false, mode: null });
  assert.deepEqual(linkParams("?token="), { token: null, badToken: false, mode: null });
  assert.deepEqual(linkParams(`?token=${TOKEN.replace("F4", "f4")}&mode=swap`), { token: null, badToken: true, mode: "swap" });
  assert.deepEqual(linkParams("?token=%3Cscript%3E&mode=constructor"), { token: null, badToken: true, mode: null });
});

// ------------------------------------------------------------------ official tokens

test("official: a name reads as the explorer reads it", () => {
  assert.equal(readsAs("tLONG"), "TLONG");
  assert.equal(readsAs("L0NG"), "LONG");
  assert.equal(readsAs("1ong"), "LONG");
  assert.equal(readsAs("|ONG"), "LONG");
  assert.equal(readsAs("Long-Yu"), "LONGYU");
  // Cyrillic and Greek capitals in place of the Latin letters, and full-width forms.
  assert.equal(readsAs("LОΝG"), "LONG");
  assert.equal(readsAs("ＬＯＮＧ"), "LONG");
  assert.equal(readsAs(null), "");
  // The same table of look-alikes as the explorer's.
  const table = (path: string) => /const LOOKALIKE: Record<string, string> = \{([\s\S]*?)\};/.exec(readFileSync(new URL(path, import.meta.url), "utf8"))![1]!.replace(/\s+/g, " ").trim();
  assert.equal(table("./swap-core.ts"), table("../../explorer/src/web/pages.ts"));
});

test("official: what passes for LONGYU's token", () => {
  const passes = [
    ["LONG", "X"], ["X", "long"], ["X", "tLONG"], ["X", "wLONG"], ["LONGYU Coin", "LYC"], ["x", "LONGYU2"],
    ["L0NGYU", "A"], ["The longyu token", "TLT"], ["A", "L-O-N-G"], ["A", "1ONG"], ["Long", "L"],
  ];
  for (const [name, symbol] of passes) assert.ok(passesForLongyu({ name: name!, symbol: symbol! }), `${name} / ${symbol}`);
  const others = [["Moon Coffee", "MOON"], ["Long Island", "LI"], ["X", "LONGER"], ["X", "XLONG"], ["Belong", "BLG"], ["X", "LONGY"], ["Wrapped BNB", "WBNB"]];
  for (const [name, symbol] of others) assert.ok(!passesForLongyu({ name: name!, symbol: symbol! }), `${name} / ${symbol}`);
  assert.ok(!passesForLongyu({ name: null, symbol: null }));
});

test("official: what the page says about each token, and whether it trades it", () => {
  const t = (address: string, name: string, symbol: string) => ({ address, name, symbol });
  // LONGYU's own token trades only where the network lets it.
  assert.deepEqual(standing(t(TOKEN.toLowerCase(), "LONGYU", "LONG"), TOKEN, false, true), { kind: "official", trade: true, note: null });
  assert.deepEqual(standing(t(TOKEN, "LONGYU", "LONG"), TOKEN, false, false), { kind: "mining", trade: false, note: MINING_PHASE });
  assert.equal(MINING_PHASE, "Official tLONG is in its mining phase and not tradable yet.");
  // Another token passing for it never trades, and the page names the real one.
  assert.deepEqual(standing(t(MOON, "LONG", "LONG"), TOKEN, false, true), { kind: "imitation", trade: false, note: `Not LONGYU's token. The only official tLONG is ${TOKEN}.` });
  assert.equal(standing(t(MOON, "Moon", "LONGYU"), TOKEN, true, true).trade, false);
  assert.deepEqual(standing(t(MOON, "Moon Coffee", "MOON"), TOKEN, true), { kind: "launched", trade: true, note: LAUNCHED_NOTE });
  assert.deepEqual(standing(t(MOON, "Moon Coffee", "MOON"), TOKEN, false), { kind: "other", trade: true, note: UNKNOWN_NOTE });
  assert.equal(LAUNCHED_NOTE, "Made with LONGYU Launch: fixed supply, no owner.");
  assert.equal(UNKNOWN_NOTE, "Anyone can create a token. Check the address before you trade.");
  // Under Node the testnet's profile is loaded: tLONG trades.
  assert.equal(standing(t(TOKEN, "x", "y"), TOKEN, false).trade, true);
});

test("display: the pool's price reads the way round that has a whole number", () => {
  assert.equal(rateText({ bnb: E18, token: 2500n * E18 }, 18, "MOON"), "1 tBNB = 2500 MOON");
  assert.equal(rateText({ bnb: 50n * E18, token: E18 }, 18, "MOON"), "1 MOON = 50 tBNB");
  assert.equal(rateText({ bnb: E18, token: E18 }, 18, "MOON"), "1 tBNB = 1 MOON");
  // In the token's own decimals.
  assert.equal(rateText({ bnb: E18, token: 2_500_000n }, 6, "SIX"), "1 tBNB = 2.5 SIX");
  assert.equal(rateText({ bnb: 3n * E18, token: 1n }, 0, "ZERO"), "1 ZERO = 3 tBNB");
  assert.equal(rateText({ bnb: 0n, token: E18 }, 18, "MOON"), null);
  assert.equal(rateText({ bnb: E18, token: 0n }, 18, "MOON"), null);
});

test("form: the fields' assets, and the flip between BNB -> token and token -> BNB", () => {
  assert.deepEqual(core.fieldAssets("swap", "bnb"), ["bnb", "token"]);
  assert.deepEqual(core.fieldAssets("swap", "token"), ["token", "bnb"]);
  // Adding and removing always take BNB first, whichever way the swap last went.
  assert.deepEqual(core.fieldAssets("add", "token"), ["bnb", "token"]);
  assert.deepEqual(core.fieldAssets("remove", "token"), ["bnb", "token"]);
  assert.equal(core.flipped("bnb"), "token");
  assert.equal(core.flipped("token"), "bnb");
  assert.equal(core.flipped(core.flipped("bnb")), "bnb");
});

test("form: the main button says what is missing, and only a complete action can be pressed", () => {
  const base = { mode: "swap" as const, hasToken: true, trades: true, loaded: true, poolLive: true, amount: "ok" as const, short: null, liquidity: null };
  const say = (change: Partial<Parameters<typeof core.actionFor>[0]>) => core.actionFor({ ...base, ...change });
  assert.deepEqual(say({}), { label: "Swap", ready: true });
  assert.deepEqual(say({ hasToken: false }), { label: "Choose a token", ready: false });
  assert.deepEqual(say({ trades: false }), { label: "Not tradable", ready: false });
  assert.deepEqual(say({ poolLive: false }), { label: "No pool yet", ready: false });
  assert.deepEqual(say({ amount: "empty" }), { label: "Enter an amount", ready: false });
  assert.deepEqual(say({ amount: "bad" }), { label: "Check the amount", ready: false });
  assert.deepEqual(say({ short: "BNB" }), { label: "Not enough BNB", ready: false });
  // Before the pool is read, a swap waits for the amount rather than saying there is no pool.
  assert.deepEqual(say({ loaded: false, poolLive: false }), { label: "Swap", ready: true });
  assert.deepEqual(say({ mode: "add", amount: "empty" }), { label: "Enter amounts", ready: false });
  assert.deepEqual(say({ mode: "add" }), { label: "Add liquidity", ready: true });
  assert.deepEqual(say({ mode: "add", poolLive: false }), { label: "Open the pool", ready: true });
  assert.deepEqual(say({ mode: "add", poolLive: false, loaded: false }), { label: "Add liquidity", ready: true });
  // Removing needs no trade: a token that stopped trading can still be taken out of its pool.
  assert.deepEqual(say({ mode: "remove", trades: false }), { label: "Remove liquidity", ready: true });
  assert.deepEqual(say({ mode: "remove", liquidity: 0n }), { label: "No liquidity", ready: false });
  assert.deepEqual(say({ mode: "remove", hasToken: false }), { label: "Choose a token", ready: false });
});

test("display: pool share, grouping and prices", () => {
  assert.equal(core.sharePercent(0n, 100n), "0%");
  assert.equal(core.sharePercent(1n, 0n), "0%");
  assert.equal(core.sharePercent(100n, 100n), "100%");
  assert.equal(core.sharePercent(25n, 100n), "25%");
  assert.equal(core.sharePercent(1n, 400n), "0.25%");
  assert.equal(core.sharePercent(1n, 1_000_000n), "<0.01%");
  assert.equal(core.sharePercent(1234n, 10_000n), "12.34%");
  assert.equal(core.grouped("1234567.25"), "1,234,567.25");
  assert.equal(core.grouped("999"), "999");
  assert.equal(core.grouped("<0.000001"), "<0.000001");
  assert.equal(core.grouped("1000"), "1,000");
  assert.equal(core.formatDisplay(1_234_567_891n * 10n ** 15n), "1,234,567.89");
  assert.equal(core.formatDisplay(12_345_678n * 10n ** 11n), "1.2345");
  assert.equal(core.formatDisplay(12_345_678n * 10n ** 9n), "0.012345");
  assert.equal(core.formatDisplay(586_072_283n * 10n ** 12n), "586.0722");
  assert.equal(core.formatDisplay(0n), "0");
  assert.equal(core.tokenPrice({ bnb: 0n, token: 1n }, 18), null);
  assert.equal(core.tokenPrice({ bnb: 10n ** 18n, token: 2500n * 10n ** 18n }, 18), 4n * 10n ** 14n);
  assert.equal(core.formatPrice(4n * 10n ** 14n), "0.0004");
  assert.equal(core.formatPrice(44_417_699_999_999n), "0.00004441");
  assert.equal(core.formatPrice(5n * 10n ** 17n), "0.5");
  assert.equal(core.formatPrice(123n), "<0.000000000001");
  assert.equal(core.formatPrice(0n), "0");
  assert.equal(core.formatPrice(2500n * 10n ** 18n), "2,500");
  assert.equal(core.groupedText("1 BNB = 22513.592927 MOON"), "1 BNB = 22,513.592927 MOON");
  assert.equal(core.groupedText("1 MOON = 0.00004441 BNB"), "1 MOON = 0.00004441 BNB");
  assert.equal(core.groupedText("1,234 and 999 and 1000000"), "1,234 and 999 and 1,000,000");
  assert.equal(core.fieldAmount(45_027_185_123_456_789_012n), 45_027_185_000_000_000_000n);
  assert.equal(core.fieldAmount(123n), 123n, "an amount the cut would make 0 stays");
  assert.equal(core.fieldAmount(1_234_567n, 6), 1_234_567n);
  assert.equal(core.fieldAmount(1_234_567_890n, 8), 1_234_567_800n);
});

test("art: a monogram is two letters of the symbol in a tint fixed by the symbol", () => {
  assert.equal(core.monogram("MOON").letters, "MO");
  assert.equal(core.monogram("x").letters, "X");
  assert.equal(core.monogram("$m00n").letters, "M0");
  assert.equal(core.monogram("").letters, "?");
  assert.equal(core.monogram("  ").letters, "?");
  // The same symbol always draws the same; case does not change it.
  assert.equal(core.monogram("MOON").tint, core.monogram("moon").tint);
  const tints = new Set(["MOON", "CAKE", "PEPE", "DOGE", "SUN", "ABC", "XYZ", "TEA", "COFFEE", "BREAD", "RICE", "JADE"].map((s) => core.monogram(s).tint));
  assert.ok(tints.size >= 4, "symbols spread over the tints");
  for (const t of tints) assert.ok(t >= 0 && t < core.MONOGRAM_TINTS.length);
  for (const [bg, fg] of core.MONOGRAM_TINTS) assert.match(bg + fg, /^#[0-9A-F]{6}#[0-9A-F]{6}$/);
});

test("art: logos come from LONGYU's API, when it is set", () => {
  assert.equal(core.logoUrl("https://api.longyu.network", TOKEN), `https://api.longyu.network/v1/tokens/${TOKEN}/logo`);
  assert.equal(core.logoUrl("https://api.longyu.network/", TOKEN, 7), `https://api.longyu.network/v1/tokens/${TOKEN}/logo?v=7`);
  assert.equal(core.logoApi("https://api.longyu.network/"), "https://api.longyu.network");
  assert.equal(core.logoApi("http://localhost:8080"), "http://localhost:8080");
  for (const bad of ["", null, undefined, "http://api.longyu.network", "javascript:alert(1)"]) assert.equal(core.logoApi(bad), null, String(bad));
  const parsed = parseSwapConfig({ ...raw, apiUrl: "https://api.longyu.network" });
  assert.ok(parsed.ok && parsed.config.apiUrl === "https://api.longyu.network");
  // A bad API address only leaves the logos out; the page still trades.
  const without = parseSwapConfig({ ...raw, apiUrl: "ftp://x" });
  assert.ok(without.ok && without.config.apiUrl === null);
});
