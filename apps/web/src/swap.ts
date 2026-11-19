/**
 * Swap page: trades tBNB and tLONG on LONGYU Swap and adds or removes pool liquidity, with the
 * visitor's own wallet. Nothing here holds a key.
 *
 * LONGYU Swap is the Uniswap V2 contracts; the router's "ETH" functions take the native asset, BNB.
 * - tBNB -> tLONG: swapExactETHForTokens(minimum, [WBNB, tLONG], sender, deadline), the amount as value.
 * - tLONG -> tBNB: approve exactly the amount to the router, then
 *   swapExactTokensForETH(amount, minimum, [tLONG, WBNB], sender, deadline).
 * - Add: approve exactly the tLONG amount, then addLiquidityETH(tLONG, amount, minimums, sender,
 *   deadline) with the tBNB as value. The router takes the two amounts at the pool's ratio and
 *   returns any tBNB left over; the first deposit into an empty pool sets the ratio.
 * - Remove: approve exactly the pool tokens, then removeLiquidityETH(tLONG, liquidity, minimums,
 *   sender, deadline).
 *
 * Every minimum is the amount the page shows less the chosen slippage, and the deadline is 20
 * minutes after LONGYU's newest block, so a trade that waits in a wallet cannot fill at a stale
 * price. Each transaction is simulated first: one the router would refuse never reaches the wallet.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { chainConfig, publicActionsL2 } from "viem/op-stack";
import { DECIMALS, L2_CHAIN_ID, formatAmount, gasReserve, isUnknownChain, l2TxUrl, longyuChainParams, parseAmount, shareAmount, shortHex } from "./bridge-core.ts";
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
  multicallAbi,
  orderReserves,
  pairAbi,
  parseSwapConfig,
  portion,
  quote,
  routerAbi,
  shareOf,
  swapErrorMessage,
  swapWiringProblems,
  type RawSwapConfig,
  type Reserves,
  type SwapConfig,
} from "./swap-core.ts";

declare const __SWAP_CONFIG__: RawSwapConfig;
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => ($(id).hidden = !on);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Mode = "swap" | "add" | "remove";
type Asset = "tBNB" | "tLONG";
interface Pool {
  pair: Address;
  /** True when the pair's token0 is WBNB. */
  bnbFirst: boolean;
  reserves: Reserves;
  totalSupply: bigint;
}
/** What the connected account holds: both assets and its pool tokens. */
interface Holdings {
  bnb: bigint;
  long: bigint;
  liquidity: bigint;
}
interface State {
  pool: Pool | null;
  held: Holdings | null;
}
interface Quote {
  amountIn: bigint;
  out: bigint;
  min: bigint;
  impact: number;
}

const MISMATCH = "Swap contracts do not match LONGYU.";
const NO_POOL = "No pool yet. Add liquidity to open it.";
const parsed = parseSwapConfig(typeof __SWAP_CONFIG__ === "undefined" ? null : __SWAP_CONFIG__);
if (parsed.ok) start(parsed.config);
else closeSwap(parsed.problems);

/** Without a complete, valid configuration the page shows one line and no action works. */
function closeSwap(problems: string[]): void {
  show("closed", true);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#swap button, #swap input, #watch").forEach((node) => (node.disabled = true));
  console.info(`Swap closed: ${problems.join("; ")}.`);
}

function start(cfg: SwapConfig): void {
  const longyu = defineChain({
    ...chainConfig,
    id: L2_CHAIN_ID,
    name: "LONGYU Testnet",
    nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: DECIMALS },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    ...(cfg.explorerUrl ? { blockExplorers: { default: { name: "LONGYU Explorer", url: cfg.explorerUrl } } } : {}),
    blockTime: 250,
    contracts: { ...chainConfig.contracts, multicall3: { address: MULTICALL3 } },
    testnet: true,
  });
  // Reads go to the configured RPC, never through the wallet, so they do not depend on its network.
  const l2 = createPublicClient({ chain: longyu, transport: http(cfg.rpcUrl) }).extend(publicActionsL2());

  const a = $("a") as HTMLInputElement;
  const b = $("b") as HTMLInputElement;

  let mode: Mode = "swap";
  /** The asset paid in a swap. */
  let pay: Asset = "tBNB";
  let slippage: number = SLIPPAGE_CHOICES[0];
  let percent = 100;
  /** The amount the visitor typed last when adding liquidity; the other one follows the pool's ratio. */
  let edited: "a" | "b" = "a";
  let account: Address | null = null;
  let busy = false;
  let wired = false;
  let loaded = false;
  let pairAddress: Address | null = null;
  let pool: Pool | null = null;
  let held: Holdings | null = null;
  /** The last gas price read, for what a share of tBNB leaves behind. */
  let gasPrice = 0n;
  /** The assets of the two amount fields, first field first. */
  const sides = (): [Asset, Asset] => (mode === "swap" && pay === "tLONG" ? ["tLONG", "tBNB"] : ["tBNB", "tLONG"]);

  // ---------------------------------------------------------------- wiring check

  /** Ties the configured addresses to LONGYU Swap on chain before the first quote or transaction. */
  let wiringRun: Promise<void> | null = null;
  function checkWiring(): Promise<void> {
    wiringRun ??= readWiring().catch((e: unknown) => {
      wiringRun = null;
      throw e;
    });
    return wiringRun;
  }
  async function readWiring(): Promise<void> {
    const chainId = await l2.getChainId().catch(() => Promise.reject(new Error("LONGYU RPC unreachable. Try again.")));
    let problems: string[];
    try {
      const [routerFactory, routerWrapped, tokenDecimals] = await Promise.all([
        l2.readContract({ address: cfg.router, abi: routerAbi, functionName: "factory" }),
        l2.readContract({ address: cfg.router, abi: routerAbi, functionName: "WETH" }),
        l2.readContract({ address: cfg.token, abi: erc20Abi, functionName: "decimals" }),
      ]);
      problems = swapWiringProblems({ chainId, routerFactory, routerWrapped, tokenDecimals }, cfg, L2_CHAIN_ID);
    } catch (e) {
      console.warn("Swap wiring check failed:", e);
      throw new Error(isContractError(e) ? MISMATCH : "Network busy. Try again.");
    }
    if (problems.length) {
      console.warn(`Swap wiring: ${problems.join("; ")}.`);
      throw new Error(MISMATCH);
    }
    wired = true;
  }
  /** A read that reached the chain and failed there (no code, wrong contract), as opposed to a network error. */
  function isContractError(e: unknown): boolean {
    for (let cur = e as { name?: string; cause?: unknown } | undefined, i = 0; cur && i < 8; cur = cur.cause as typeof cur, i++) {
      if (cur.name === "ContractFunctionZeroDataError" || cur.name === "ContractFunctionRevertedError") return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- pool and balances

  /** One round trip: the pool's reserves and supply, and what `who` holds. */
  async function fetchState(who: Address | null): Promise<State> {
    const owner = who ?? zeroAddress;
    const bnbOf = { address: MULTICALL3, abi: multicallAbi, functionName: "getEthBalance", args: [owner] } as const;
    const longOf = { address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] } as const;
    if (!pairAddress) {
      const [found, bnb, long] = await l2.multicall({
        allowFailure: false,
        contracts: [{ address: cfg.factory, abi: factoryAbi, functionName: "getPair", args: [cfg.token, WBNB] }, bnbOf, longOf],
      });
      if (found === zeroAddress) return { pool: null, held: who ? { bnb, long, liquidity: 0n } : null };
      pairAddress = found;
    }
    const pair = pairAddress;
    const [token0, token1, [reserve0, reserve1], totalSupply, liquidity, bnb, long] = await l2.multicall({
      allowFailure: false,
      contracts: [
        { address: pair, abi: pairAbi, functionName: "token0" },
        { address: pair, abi: pairAbi, functionName: "token1" },
        { address: pair, abi: pairAbi, functionName: "getReserves" },
        { address: pair, abi: pairAbi, functionName: "totalSupply" },
        { address: pair, abi: pairAbi, functionName: "balanceOf", args: [owner] },
        bnbOf,
        longOf,
      ],
    });
    const reserves = orderReserves(token0, token1, cfg.token, reserve0, reserve1);
    if (!reserves) throw new Error(MISMATCH);
    return { pool: { pair, bnbFirst: same(token0, WBNB), reserves, totalSupply }, held: who ? { bnb, long, liquidity } : null };
  }

  let stateRun = 0;
  function apply(state: State): void {
    stateRun++; // an older read still on its way is dropped
    pool = state.pool;
    held = state.held;
    loaded = true;
    render();
  }
  /** Re-reads the pool and the balances for the page; a newer read or a changed account wins. */
  async function refresh(): Promise<void> {
    if (!wired) return;
    const run = ++stateRun;
    const who = account;
    void l2.getGasPrice().then(
      (price) => (gasPrice = price),
      () => undefined,
    );
    try {
      const state = await fetchState(who);
      if (run === stateRun && who === account) apply(state);
    } catch (e) {
      console.warn("Swap state:", e);
    }
  }
  /** A fresh read for a transaction: it fails loudly, and what it returns is what the page then shows. */
  async function reload(who: Address): Promise<{ pool: Pool | null; held: Holdings }> {
    const state = await fetchState(who).catch((e: unknown) => {
      console.warn("Swap state:", e);
      return Promise.reject(new Error(e instanceof Error && e.message === MISMATCH ? MISMATCH : "Network busy. Try again."));
    });
    apply(state);
    return { pool: state.pool, held: state.held! };
  }

  const live = (p: Pool | null): p is Pool => p !== null && p.reserves.bnb > 0n && p.reserves.long > 0n;

  /** The swap the page shows for the amount typed: what it pays out and the least the sender accepts. */
  function swapQuote(): Quote | null {
    const amountIn = parseAmount(a.value);
    if (!live(pool) || !amountIn) return null;
    const [reserveIn, reserveOut] = pay === "tBNB" ? [pool.reserves.bnb, pool.reserves.long] : [pool.reserves.long, pool.reserves.bnb];
    const out = amountOut(amountIn, reserveIn, reserveOut);
    return { amountIn, out, min: minimumOut(out, slippage), impact: impactBps(amountIn, out, reserveIn, reserveOut) };
  }

  // ---------------------------------------------------------------- wallet

  function provider(): EIP1193Provider {
    const eth = window.ethereum;
    if (!eth) throw new Error("No wallet found. Open this page in your wallet's browser (MetaMask, Trust Wallet or Binance Wallet).");
    return eth;
  }

  async function connect(): Promise<Address> {
    const [first] = (await provider().request({ method: "eth_requestAccounts" })) as Address[];
    if (!first) throw new Error("No account selected in the wallet.");
    setAccount(getAddress(first));
    return account!;
  }
  function setAccount(next: Address | null): void {
    if (next === account) return;
    account = next;
    held = null;
    render();
    void refresh();
  }

  /** Puts the wallet on LONGYU, adding the network when the wallet lacks it. */
  async function ensureChain(): Promise<void> {
    const eth = provider();
    const current = async () => Number(await eth.request({ method: "eth_chainId" }));
    if ((await current()) === L2_CHAIN_ID) return;
    setStatus("Switch your wallet to LONGYU Testnet");
    const chainId = toHex(L2_CHAIN_ID);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [longyuChainParams({ l2RpcUrl: cfg.rpcUrl, explorerUrl: cfg.explorerUrl })] });
      if ((await current()) !== L2_CHAIN_ID) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
    if ((await current()) !== L2_CHAIN_ID) throw new Error("Switch your wallet to LONGYU Testnet.");
  }

  const l2Wallet = () => createWalletClient({ chain: longyu, transport: custom(provider()) });
  const setStatus = (s: string) => ($("status").textContent = s);
  function setLink(hash: Hex, text: string): void {
    const link = $("tx") as HTMLAnchorElement;
    const href = l2TxUrl(cfg.explorerUrl, hash);
    if (href) link.href = href;
    else link.removeAttribute("href");
    link.textContent = href ? text : `LONGYU ${shortHex(hash)}`;
    show("tx", true);
  }

  /**
   * Simulates a transaction, checks the account can pay for it (the amount, LONGYU's gas and the fee
   * for posting it to BSC), sends it through the wallet and waits for it.
   */
  async function transact(from: Address, tx: { to: Address; data: Hex; value: bigint }, confirm: string, linkText: string): Promise<TransactionReceipt> {
    const request = { account: from, ...tx };
    const [gas, price, dataFee, native] = await Promise.all([
      l2.estimateGas(request),
      l2.getGasPrice(),
      l2.estimateL1Fee({ ...request, chain: longyu }).catch(() => 0n),
      l2.getBalance({ address: from }),
    ]);
    if (native < tx.value + gas * price + dataFee) throw new Error(tx.value > 0n ? "Not enough tBNB for this amount plus gas." : "Not enough tBNB for gas.");
    await ensureChain();
    setStatus(confirm);
    const hash = await l2Wallet().sendTransaction(request);
    setLink(hash, linkText);
    setStatus("Confirming on LONGYU…");
    const receipt = await l2.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction failed on LONGYU. Only gas was spent.");
    return receipt;
  }

  /** Lets the router take exactly `amount` of a token. Returns the prefix for the step that follows. */
  async function approve(token: Address, amount: bigint, from: Address, what: string): Promise<string> {
    const allowance = () => l2.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [from, cfg.router] });
    if ((await allowance()) >= amount) return "";
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.router, amount] });
    await transact(from, { to: token, data, value: 0n }, `1/2 · Approve ${what} in your wallet`, "Approval on LONGYU");
    for (let i = 0; (await allowance()) < amount; i++) {
      if (i === 15) throw new Error("The approval is not visible yet. Try again in a minute.");
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return "2/2 · ";
  }

  const deadline = async () => (await l2.getBlock()).timestamp + BigInt(DEADLINE_SECONDS);

  // ---------------------------------------------------------------- actions

  function typed(input: HTMLInputElement): bigint {
    const text = input.value.trim();
    const amount = parseAmount(text);
    if (!text) throw new Error("Enter an amount.");
    if (amount === null) throw new Error("Use digits and at most 18 decimals.");
    if (amount === 0n) throw new Error("Enter an amount above 0.");
    return amount;
  }
  function has(holdings: Holdings, asset: Asset, amount: bigint): void {
    const balance = asset === "tBNB" ? holdings.bnb : holdings.long;
    if (balance < amount) throw new Error(`Not enough ${asset}: ${formatShort(balance)}.`);
  }

  async function swap(from: Address): Promise<void> {
    typed(a);
    const [paid, got]: [Asset, Asset] = pay === "tBNB" ? ["tBNB", "tLONG"] : ["tLONG", "tBNB"];
    const shown = swapQuote();
    const fresh = await reload(from);
    const now = swapQuote();
    if (!live(fresh.pool) || !now) throw new Error(NO_POOL);
    // The limit comes from the quote the visitor saw; a pool that has moved past it is not traded against.
    const quoted = shown ?? now;
    if (quoted.min === 0n) throw new Error("Amount too small.");
    if (now.out < quoted.min) throw new Error(PRICE_MOVED);
    const amount = quoted.amountIn;
    has(fresh.held, paid, amount);
    const label = `${formatAmount(amount)} ${paid}`;
    let receipt: TransactionReceipt;
    if (paid === "tBNB") {
      const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokens", args: [quoted.min, [WBNB, cfg.token], from, await deadline()] });
      receipt = await transact(from, { to: cfg.router, data, value: amount }, `Confirm the swap of ${label}`, "Swap on LONGYU");
    } else {
      const step = await approve(cfg.token, amount, from, label);
      const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETH", args: [amount, quoted.min, [cfg.token, WBNB], from, await deadline()] });
      receipt = await transact(from, { to: cfg.router, data, value: 0n }, `${step}Confirm the swap of ${label}`, "Swap on LONGYU");
    }
    // What the pool paid out, from its own event.
    const pair = fresh.pool.pair;
    const outFirst = (got === "tBNB") === fresh.pool.bnbFirst;
    const swaps = parseEventLogs({ abi: pairAbi, eventName: "Swap", logs: receipt.logs.filter((l) => same(l.address, pair)) });
    const received = swaps.reduce((sum, e) => sum + (outFirst ? e.args.amount0Out : e.args.amount1Out), 0n);
    a.value = "";
    setStatus(received > 0n ? `Received ${formatShort(received)} ${got}.` : "Swapped.");
  }

  async function add(from: Address): Promise<void> {
    typed(a);
    typed(b);
    // The fresh read brings the second amount to the pool's ratio of the moment; what is sent is what is then shown.
    const fresh = await reload(from);
    const bnb = typed(a);
    const long = typed(b);
    has(fresh.held, "tBNB", bnb);
    has(fresh.held, "tLONG", long);
    const step = await approve(cfg.token, long, from, `${formatAmount(long)} tLONG`);
    const args = [cfg.token, long, minimumOut(long, slippage), minimumOut(bnb, slippage), from, await deadline()] as const;
    const data = encodeFunctionData({ abi: routerAbi, functionName: "addLiquidityETH", args });
    await transact(from, { to: cfg.router, data, value: bnb }, `${step}Confirm the deposit of ${formatAmount(bnb)} tBNB and ${formatAmount(long)} tLONG`, "Deposit on LONGYU");
    a.value = b.value = "";
    setStatus("Liquidity added.");
  }

  async function remove(from: Address): Promise<void> {
    const fresh = await reload(from);
    if (!fresh.pool || fresh.held.liquidity === 0n) throw new Error("No liquidity to remove.");
    const liquidity = portion(fresh.held.liquidity, percent);
    const expected = shareOf(liquidity, fresh.pool.totalSupply, fresh.pool.reserves);
    if (liquidity === 0n || expected.bnb === 0n || expected.long === 0n) throw new Error("Amount too small.");
    const step = await approve(fresh.pool.pair, liquidity, from, "your pool share");
    const args = [cfg.token, liquidity, minimumOut(expected.long, slippage), minimumOut(expected.bnb, slippage), from, await deadline()] as const;
    const data = encodeFunctionData({ abi: routerAbi, functionName: "removeLiquidityETH", args });
    await transact(from, { to: cfg.router, data, value: 0n }, `${step}Confirm the removal`, "Removal on LONGYU");
    setStatus("Liquidity removed.");
  }

  // ---------------------------------------------------------------- form

  const pair = (r: Reserves) => `${formatShort(r.bnb)} tBNB · ${formatShort(r.long)} tLONG`;

  function render(): void {
    for (const m of ["swap", "add", "remove"]) $(`mode-${m}`).setAttribute("aria-pressed", String(mode === m));
    const [first, second] = sides();
    // The pool once it holds both assets; null before the first deposit.
    const open = live(pool) ? pool : null;
    const balance = (asset: Asset) => (held ? formatShort(asset === "tBNB" ? held.bnb : held.long) : "–");

    show("boxes", mode !== "remove");
    show("flip", mode === "swap");
    show("percent", mode === "remove");
    show("mine-row", mode === "remove");
    show("out-row", mode === "remove");
    show("impact-row", mode === "swap");
    show("min-row", mode === "swap");
    show("pool-row", mode !== "swap");
    $("a-label").textContent = mode === "swap" ? "You pay" : "Deposit";
    $("b-label").textContent = mode === "swap" ? "You receive" : "Deposit";
    $("a-token").textContent = first;
    $("b-token").textContent = second;
    $("a-balance").textContent = balance(first);
    $("b-balance").textContent = balance(second);
    show("a-quick", held !== null);
    show("b-quick", held !== null && mode === "add");
    b.readOnly = mode === "swap";

    $("rate").textContent = !open
      ? "–"
      : open.reserves.long >= open.reserves.bnb
        ? `1 tBNB = ${formatShort(quote(10n ** BigInt(DECIMALS), open.reserves.bnb, open.reserves.long))} tLONG`
        : `1 tLONG = ${formatShort(quote(10n ** BigInt(DECIMALS), open.reserves.long, open.reserves.bnb))} tBNB`;
    $("pool").textContent = open ? pair(open.reserves) : "–";
    $("note").textContent = !loaded || open || mode === "remove" ? "" : mode === "swap" ? NO_POOL : "The first deposit sets the rate.";

    if (mode === "swap") {
      const q = swapQuote();
      b.value = q ? formatShort(q.out) : "";
      $("impact").textContent = q ? formatBps(q.impact) : "–";
      $("impact").classList.toggle("bad", q !== null && q.impact >= HIGH_IMPACT_BPS);
      $("min").textContent = q ? `${formatShort(q.min)} ${second}` : "–";
    } else if (mode === "add" && open) {
      // The amount not being typed follows the pool's ratio.
      const [from, to, reserveFrom, reserveTo] = edited === "a" ? [a, b, open.reserves.bnb, open.reserves.long] : [b, a, open.reserves.long, open.reserves.bnb];
      const amount = parseAmount(from.value);
      to.value = amount ? formatAmount(quote(amount, reserveFrom, reserveTo)) : "";
    } else if (mode === "remove") {
      $("mine").textContent = !held ? "–" : pool && held.liquidity > 0n ? pair(shareOf(held.liquidity, pool.totalSupply, pool.reserves)) : "None";
      $("out").textContent = pool && held && held.liquidity > 0n ? pair(shareOf(portion(held.liquidity, percent), pool.totalSupply, pool.reserves)) : "–";
      document.querySelectorAll<HTMLButtonElement>("#percent button").forEach((node) => node.setAttribute("aria-pressed", String(Number(node.dataset.percent) === percent)));
    }
    document.querySelectorAll<HTMLButtonElement>("#slippage button").forEach((node) => node.setAttribute("aria-pressed", String(Number(node.dataset.bps) === slippage)));

    show("connect", account === null);
    show("send", account !== null);
    $("send").textContent = mode === "swap" ? "Swap" : mode === "add" ? "Add liquidity" : "Remove liquidity";
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#swap button, #swap input, #watch").forEach((node) => (node.disabled = busy));
  }

  function clear(): void {
    show("tx", false);
    setStatus("");
    $("error").textContent = "";
  }

  function choose(next: { mode?: Mode; flip?: boolean }): void {
    if (busy) return;
    if (next.mode && next.mode !== mode) {
      mode = next.mode;
      edited = "a";
      a.value = b.value = "";
    }
    if (next.flip) {
      pay = pay === "tBNB" ? "tLONG" : "tBNB";
      a.value = "";
    }
    clear();
    render();
  }

  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    clear();
    render();
    try {
      await task();
    } catch (e) {
      setStatus("");
      $("error").textContent = swapErrorMessage(e);
    } finally {
      busy = false;
      render();
      void refresh();
    }
  }

  for (const bps of SLIPPAGE_CHOICES) {
    const node = document.createElement("button");
    node.type = "button";
    node.dataset.bps = String(bps);
    node.textContent = formatBps(bps);
    node.onclick = () => {
      slippage = bps;
      render();
    };
    $("slippage").append(node);
  }
  document.querySelectorAll<HTMLButtonElement>("#percent button").forEach((node) => {
    node.onclick = () => {
      percent = Number(node.dataset.percent);
      render();
    };
  });
  $("mode-swap").onclick = () => choose({ mode: "swap" });
  $("mode-add").onclick = () => choose({ mode: "add" });
  $("mode-remove").onclick = () => choose({ mode: "remove" });
  $("flip").onclick = () => choose({ flip: true });
  a.oninput = () => {
    edited = "a";
    render();
  };
  b.oninput = () => {
    edited = "b";
    render();
  };
  for (const side of ["a", "b"] as const) {
    document.querySelectorAll<HTMLButtonElement>(`#${side}-quick button`).forEach((node) => {
      node.onclick = () => {
        if (!held) return;
        const asset = sides()[side === "a" ? 0 : 1];
        const share = Number(node.dataset.share);
        // tBNB also pays for gas, so a share of it leaves some behind.
        const amount = asset === "tBNB" ? shareAmount(held.bnb, share, gasReserve(gasPrice)) : shareAmount(held.long, share);
        (side === "a" ? a : b).value = amount > 0n ? formatAmount(amount) : "";
        edited = side;
        clear();
        if (amount === 0n) $("error").textContent = asset === "tBNB" && held.bnb > 0n ? "Not enough tBNB to leave for gas." : `No ${asset} here yet.`;
        render();
      };
    });
  }
  $("connect").onclick = () => run(async () => void (await connect()));
  $("send").onclick = () =>
    run(async () => {
      const action = mode === "swap" ? swap : mode === "add" ? add : remove;
      const from = await connect();
      await checkWiring();
      await action(from);
    });
  $("watch").onclick = () =>
    run(async () => {
      await provider().request({ method: "wallet_watchAsset", params: { type: "ERC20", options: { address: cfg.token, symbol: "tLONG", decimals: DECIMALS } } });
    });

  const eth = window.ethereum;
  if (eth) {
    eth.on?.("accountsChanged", (accounts: readonly Address[]) => setAccount(accounts[0] ? getAddress(accounts[0]) : null));
    eth
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (accounts[0] && !account) setAccount(getAddress(accounts[0]));
      })
      .catch(() => undefined);
  }

  render();
  checkWiring().then(
    () => refresh(),
    (e: unknown) => ($("error").textContent = swapErrorMessage(e)),
  );
  setInterval(() => {
    if (document.hidden || busy) return;
    // A failed first check is tried again here, so the page recovers without a reload.
    checkWiring().then(
      () => refresh(),
      () => undefined,
    );
  }, 15_000);
}
