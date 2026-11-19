import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeFunctionData, toFunctionSelector, type Address } from "viem";
import { CANCELLED } from "./bridge-core.ts";
import {
  DEADLINE_SECONDS,
  HIGH_IMPACT_BPS,
  MULTICALL3,
  PRICE_MOVED,
  SLIPPAGE_CHOICES,
  WBNB,
  amountOut,
  factoryAbi,
  formatBps,
  formatShort,
  impactBps,
  minimumOut,
  orderReserves,
  pairAbi,
  parseSwapConfig,
  portion,
  quote,
  routerAbi,
  shareOf,
  swapErrorMessage,
  swapWiringProblems,
  type SwapConfig,
} from "./swap-core.ts";

const ROUTER = "0xed3Eb7fe322424C14cc356Ab182021cAb8dCf01A";
const FACTORY = "0xfE5372cA129113bf12EC70D1EE4A7cBB14f172B0";
const TOKEN = "0xF4769160D6dc78F66f61F0eA1638E65d43610163";
const RPC = "https://rpc.longyu.example";
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
  assert.deepEqual(config(), { router: ROUTER, factory: FACTORY, token: TOKEN, rpcUrl: RPC, explorerUrl: "https://scan.longyu.example" });
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
  assert.deepEqual(orderReserves(WBNB, TOKEN, TOKEN, 1n, 2n), { bnb: 1n, long: 2n });
  assert.deepEqual(orderReserves(TOKEN.toLowerCase(), WBNB, TOKEN, 1n, 2n), { bnb: 2n, long: 1n });
  // Any other pair is not this page's pool.
  assert.equal(orderReserves(WBNB, ROUTER, TOKEN, 1n, 2n), null);
  assert.equal(orderReserves(TOKEN, TOKEN, TOKEN, 1n, 2n), null);
  assert.equal(orderReserves(WBNB, WBNB, TOKEN, 1n, 2n), null);
});

test("shareOf and portion: what pool tokens return", () => {
  const reserves = { bnb: 15n * E18 / 1000n, long: 750n * E18 };
  assert.deepEqual(shareOf(50n, 100n, reserves), { bnb: reserves.bnb / 2n, long: reserves.long / 2n });
  assert.deepEqual(shareOf(100n, 100n, reserves), reserves);
  assert.deepEqual(shareOf(1n, 3n, { bnb: 10n, long: 20n }), { bnb: 3n, long: 6n });
  assert.deepEqual(shareOf(0n, 100n, reserves), { bnb: 0n, long: 0n });
  assert.deepEqual(shareOf(5n, 0n, reserves), { bnb: 0n, long: 0n });
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
    swapExactETHForTokens: "0x7ff36ab5",
    swapExactTokensForETH: "0x18cbafe5",
    addLiquidityETH: "0xf305d719",
    removeLiquidityETH: "0x02751cec",
  } as const;
  const calls = {
    swapExactETHForTokens: encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokens", args: [1n, [WBNB, TOKEN], sender, 2n] }),
    swapExactTokensForETH: encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETH", args: [3n, 1n, [TOKEN, WBNB], sender, 2n] }),
    addLiquidityETH: encodeFunctionData({ abi: routerAbi, functionName: "addLiquidityETH", args: [TOKEN, 3n, 2n, 1n, sender, 2n] }),
    removeLiquidityETH: encodeFunctionData({ abi: routerAbi, functionName: "removeLiquidityETH", args: [TOKEN, 3n, 2n, 1n, sender, 2n] }),
  };
  for (const [name, selector] of Object.entries(selectors)) assert.equal(calls[name as keyof typeof calls].slice(0, 10), selector, name);
  assert.equal(toFunctionSelector(factoryAbi[0]), "0xe6a43905");
  assert.equal(toFunctionSelector(pairAbi.find((x) => x.type === "function" && x.name === "getReserves")!), "0x0902f1ac");
  // The deployed router's source has each of them.
  const source = readFileSync(new URL("../../../contracts/dex/src/periphery/UniswapV2Router02.sol", import.meta.url), "utf8");
  for (const name of Object.keys(selectors)) assert.match(source, new RegExp(`function ${name}\\(`), name);
});
