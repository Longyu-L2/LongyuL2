/**
 * Swap page: trades BNB and any token on LONGYU Swap and adds or removes pool liquidity, with the
 * visitor's own wallet. Nothing here holds a key.
 *
 * LONGYU Swap is the Uniswap V2 contracts; the router's "ETH" functions take the native asset, BNB.
 * - BNB -> token: swapExactETHForTokensSupportingFeeOnTransferTokens(minimum, [WBNB, token], sender,
 *   deadline), the amount as value.
 * - token -> BNB: approve exactly the amount to the router, then
 *   swapExactTokensForETHSupportingFeeOnTransferTokens(amount, minimum, [token, WBNB], sender, deadline).
 * - Add: approve exactly the token amount, then addLiquidityETH(token, amount, minimums, sender,
 *   deadline) with the BNB as value. The router takes the two amounts at the pool's ratio and
 *   returns any BNB left over; the first deposit creates the pool and sets its price.
 * - Remove: approve exactly the pool tokens, then removeLiquidityETHSupportingFeeOnTransferTokens(token,
 *   liquidity, minimums, sender, deadline).
 * Why the SupportingFeeOnTransferTokens forms: see routerAbi in swap-core.ts.
 *
 * The token is the network's own (listed), one made with LONGYU Launch, or any address pasted in;
 * swap.html?token=0x… opens the page with one chosen. The page says which it is, and never trades
 * LONGYU's token before the network lets it, nor another token that passes for it.
 *
 * Every minimum is the amount the page shows less the chosen slippage, and the deadline is 20
 * minutes after LONGYU's newest block, so a trade that waits in a wallet cannot fill at a stale
 * price. Each transaction is simulated first: one the router would refuse never reaches the wallet.
 *
 * Names and symbols come from the tokens' own contracts and are only ever set as text.
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
import { DECIMALS, L2_CHAIN_ID, NATIVE, formatAmount, gasReserve, isUnknownChain, l2TxUrl, longyuChainParams, parseAmount, shareAmount, shortHex } from "./bridge-core.ts";
import {
  DEADLINE_SECONDS,
  HIGH_IMPACT_BPS,
  MULTICALL3,
  PRICE_MOVED,
  SLIPPAGE_CHOICES,
  WBNB,
  actionFor,
  amountOut,
  factoryAbi,
  fieldAssets,
  flipped,
  fieldAmount,
  formatBps,
  formatDisplay,
  groupedText,
  formatPrice,
  formatShort,
  impactBps,
  launcherAbi,
  linkParams,
  matchesSearch,
  mergeTokens,
  minimumOut,
  multicallAbi,
  newestRange,
  orderReserves,
  pairAbi,
  parseSwapConfig,
  pastedAddress,
  portion,
  quote,
  rateText,
  routerAbi,
  shareOf,
  sharePercent,
  standing,
  swapErrorMessage,
  swapWiringProblems,
  tokenFrom,
  tokenPrice,
  type Asset,
  type Mode,
  type RawSwapConfig,
  type Read,
  type Reserves,
  type Standing,
  type SwapConfig,
  type TokenInfo,
} from "./swap-core.ts";
import { appShell, drawArt, tokenArt } from "./app-shell.ts";
import { closedByVisitor, walletSession } from "./wallet-modal.ts";
import { PROFILE } from "./profile.ts";

declare const __SWAP_CONFIG__: RawSwapConfig;
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => ($(id).hidden = !on);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** The token being traded, and what the page says about it. */
interface Chosen extends TokenInfo {
  standing: Standing;
}
interface Pool {
  pair: Address;
  /** True when the pair's token0 is WBNB. */
  bnbFirst: boolean;
  reserves: Reserves;
  totalSupply: bigint;
}
/** What the connected account holds: BNB, the token and its pool tokens. */
interface Holdings {
  bnb: bigint;
  token: bigint;
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
const FIRST_DEPOSIT = "No pool yet. Your deposit opens it, and the two amounts set its price.";
const BUSY = "Network busy. Try again.";
const RECENT_SHOWN = 10;
const parsed = parseSwapConfig(typeof __SWAP_CONFIG__ === "undefined" ? null : __SWAP_CONFIG__);
if (parsed.ok) start(parsed.config);
else closeSwap(parsed.problems);

/** Without a complete, valid configuration the page shows one line and no action works. */
function closeSwap(problems: string[]): void {
  appShell();
  $("closed").textContent = "Swap is unavailable on this address.";
  show("closed", true);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#swap button, #swap input, #watch").forEach((node) => (node.disabled = true));
  console.info(`Swap closed: ${problems.join("; ")}.`);
}

function start(cfg: SwapConfig): void {
  const longyu = defineChain({
    ...chainConfig,
    id: L2_CHAIN_ID,
    name: PROFILE.l2.name,
    nativeCurrency: { name: "BNB", symbol: NATIVE, decimals: DECIMALS },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    ...(cfg.explorerUrl ? { blockExplorers: { default: { name: "LONGYU Explorer", url: cfg.explorerUrl } } } : {}),
    blockTime: 250,
    contracts: { ...chainConfig.contracts, multicall3: { address: MULTICALL3 } },
    ...PROFILE.l2.chain,
  });
  // Reads go to the configured RPC, never through the wallet, so they do not depend on its network.
  const l2 = createPublicClient({ chain: longyu, transport: http(cfg.rpcUrl) }).extend(publicActionsL2());

  const a = $("a") as HTMLInputElement;
  const b = $("b") as HTMLInputElement;
  const find = $("find") as HTMLInputElement;
  const picker = $("picker") as HTMLDialogElement;
  const session = walletSession();
  const shell = appShell({ session, connect: () => void run(async () => void (await connect())), explorerUrl: cfg.explorerUrl, chainId: L2_CHAIN_ID, switchChain: () => ensureChain() });

  let mode: Mode = "swap";
  /** The asset paid in a swap. */
  let pay: Asset = "bnb";
  let slippage: number = SLIPPAGE_CHOICES[0];
  let percent = 100;
  /** The amount the visitor typed last when adding liquidity; the other one follows the pool's ratio. */
  let edited: "a" | "b" = "a";
  let account: Address | null = null;
  let busy = false;
  let wired = false;
  let loaded = false;
  let token: Chosen | null = null;
  let pairAddress: Address | null = null;
  let pool: Pool | null = null;
  let held: Holdings | null = null;
  /** The last gas price read, for what a share of BNB leaves behind. */
  let gasPrice = 0n;
  /** The assets of the two amount fields, first field first. */
  const sides = (): [Asset, Asset] => fieldAssets(mode, pay);
  const symbolOf = (asset: Asset) => (asset === "bnb" ? NATIVE : (token?.symbol ?? "–"));
  const decimalsOf = (asset: Asset) => (asset === "bnb" ? DECIMALS : (token?.decimals ?? DECIMALS));
  /** Swapping and adding need a token the page trades; removing only needs a token. */
  const blocked = () => token === null || (!token.standing.trade && mode !== "remove");
  const isOfficial = (address: string) => same(address, cfg.token);
  const art = (t: { address: string; symbol: string }, size?: number) =>
    tokenArt(t, { size, official: isOfficial(t.address), native: t.address.toLowerCase() === WBNB.toLowerCase(), apiUrl: cfg.apiUrl });
  const scan = (path: string) => (cfg.explorerUrl ? `${cfg.explorerUrl}/${path}` : null);

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
      throw new Error(isContractError(e) ? MISMATCH : BUSY);
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

  // ---------------------------------------------------------------- tokens

  const metaCalls = (address: Address) =>
    [
      { address, abi: erc20Abi, functionName: "name" },
      { address, abi: erc20Abi, functionName: "symbol" },
      { address, abi: erc20Abi, functionName: "decimals" },
    ] as const;

  /** One token read from its own contract, with whether LONGYU Launch made it. Throws only when the network fails. */
  async function readToken(address: Address): Promise<{ ok: true; token: TokenInfo; launched: boolean } | { ok: false; error: string }> {
    const launcher = cfg.launcher;
    const [reads, launched] = await Promise.all([
      l2.multicall({ allowFailure: true, contracts: [...metaCalls(address), { address, abi: erc20Abi, functionName: "totalSupply" }] }),
      // A launcher that cannot be read only leaves the token unmarked.
      launcher ? l2.readContract({ address: launcher, abi: launcherAbi, functionName: "launched", args: [address] }).catch(() => false) : false,
    ]);
    const [name, symbol, decimals, totalSupply] = reads as Read[] as [Read, Read, Read, Read];
    const found = tokenFrom(address, { name, symbol, decimals, totalSupply });
    if (!found.ok) return found;
    return { ok: true, token: found.token, launched };
  }

  /** The network's own token, as the list shows it: read from the chain, or the profile's names. */
  let listed: TokenInfo = { address: cfg.token, name: PROFILE.token.name, symbol: PROFILE.token.symbol, decimals: DECIMALS };
  /** The newest tokens made with LONGYU Launch, newest first; null until read. */
  let launchedList: TokenInfo[] | null = null;
  let launchedRun: Promise<void> | null = null;
  let launchedFailed = false;

  async function readListed(): Promise<void> {
    const found = await readToken(cfg.token).catch(() => null);
    if (found?.ok) listed = found.token;
  }

  /** Reads the newest launched tokens once; a failed read is tried again the next time the list opens. */
  function loadLaunched(): Promise<void> {
    launchedRun ??= (async () => {
      if (!cfg.launcher) {
        launchedList = [];
        return;
      }
      const launcher = cfg.launcher;
      const total = await l2.readContract({ address: launcher, abi: launcherAbi, functionName: "tokenCount" });
      const { start: first, count } = newestRange(total);
      const addresses = count === 0n ? [] : await l2.readContract({ address: launcher, abi: launcherAbi, functionName: "tokensFrom", args: [first, count] });
      const reads = addresses.length ? ((await l2.multicall({ allowFailure: true, contracts: addresses.flatMap(metaCalls) })) as Read[]) : [];
      const tokens: TokenInfo[] = [];
      addresses.forEach((address, i) => {
        const found = tokenFrom(getAddress(address), { name: reads[i * 3]!, symbol: reads[i * 3 + 1]!, decimals: reads[i * 3 + 2]! });
        if (found.ok) tokens.push(found.token);
      });
      launchedList = tokens.reverse();
      launchedFailed = false;
    })().catch((e: unknown) => {
      console.warn("Launched tokens:", e);
      launchedRun = null;
      launchedFailed = true;
    });
    return launchedRun;
  }

  /** Makes `t` the token traded: the pool and balances are read again for it. A token chosen goes into the address, so the link opens it again. */
  function useToken(t: TokenInfo, launched: boolean, chosen = true): void {
    token = { ...t, standing: standing(t, cfg.token, launched) };
    pairAddress = null;
    pool = null;
    held = null;
    loaded = false;
    a.value = b.value = "";
    stateRun++; // a read for the token before is dropped
    if (chosen) {
      const url = new URL(location.href);
      url.searchParams.set("token", t.address);
      history.replaceState(null, "", url);
    }
    clear();
    render();
    void refresh();
  }

  /** Reads a token by its address and chooses it, or says why it cannot be chosen. */
  let lookupRun = 0;
  async function lookUp(address: Address, then: "choose" | "offer"): Promise<void> {
    const run = ++lookupRun;
    setFindNote("Reading the token…");
    let found: Awaited<ReturnType<typeof readToken>>;
    try {
      found = await readToken(address);
    } catch (e) {
      console.warn("Token read:", e);
      if (run === lookupRun) setFindNote(BUSY);
      return;
    }
    if (run !== lookupRun) return;
    if (!found.ok) return setFindNote(found.error, true);
    setFindNote("");
    if (then === "choose") {
      closePicker();
      useToken(found.token, found.launched);
    } else {
      pasted = { ...found.token, launched: found.launched };
      renderList();
    }
  }

  // ---------------------------------------------------------------- picker

  /** A token read from a pasted address, offered at the top of the list. */
  let pasted: (TokenInfo & { launched: boolean }) | null = null;

  function setFindNote(text: string, bad = false): void {
    $("find-note").textContent = text;
    $("find-note").classList.toggle("bad", bad);
  }

  function openPicker(): void {
    if (busy || picker.open) return;
    find.value = "";
    pasted = null;
    setFindNote("");
    renderList();
    picker.showModal();
    $("picker-body").scrollTop = 0;
    find.focus();
    if (launchedList === null) void loadLaunched().then(renderAll);
  }
  function closePicker(): void {
    lookupRun++;
    if (!picker.open) return;
    picker.close();
  }
  // However it closes (a choice, Esc, the close button, the backdrop), focus goes back to the token chip.
  picker.addEventListener("close", () => {
    lookupRun++;
    pickButton.focus();
  });
  picker.addEventListener("click", (e) => {
    if (e.target === picker) closePicker();
  });
  // Up and down move through the list; down from the search goes to the first row.
  picker.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(picker.querySelectorAll<HTMLButtonElement>(".row-btn:not(:disabled)"));
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at < 0 ? 0 : Math.min(at + 1, rows.length - 1)) : at <= 0 ? -1 : at - 1;
    e.preventDefault();
    if (next < 0) find.focus();
    else rows[next]!.focus();
  });

  /** One row of the list: a button that chooses the token, with a line saying why when it cannot be chosen. */
  function row(t: TokenInfo, launched: boolean, s: Standing, why: string | null): HTMLElement {
    const item = el("button", "row-btn");
    item.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-sym", t.symbol), el("span", "row-name", t.name));
    const address = el("span", "row-addr mono", shortHex(t.address));
    address.title = t.address;
    item.append(art(t, 36), text, address);
    if (why) {
      const tone = s.kind === "imitation" ? " bad" : s.kind === "other" ? "" : " plain";
      item.append(el("span", `row-why${tone}`, why));
    }
    if (!s.trade) item.disabled = true;
    item.onclick = () => {
      closePicker();
      useToken(t, launched);
    };
    return item;
  }

  function renderList(): void {
    const query = find.value;
    // A pasted token first, then the network's own, then LONGYU Launch's newest; each token once.
    type Entry = TokenInfo & { launched: boolean; group: "pasted" | "listed" | "launched" };
    const entries = mergeTokens<Entry>(
      pasted ? [{ ...pasted, group: "pasted" }] : [],
      [{ ...listed, launched: false, group: "listed" }],
      (launchedList ?? []).map((t) => ({ ...t, launched: true, group: "launched" as const })),
    ).filter((t) => t.group === "pasted" || matchesSearch(t, query));
    const rowOf = (t: Entry) => {
      const s = standing(t, cfg.token, t.launched);
      // A pasted token always says what it is; a listed one only when it cannot be traded.
      return row(t, t.launched, s, t.group === "pasted" || !s.trade ? s.note : null);
    };
    $("pasted").replaceChildren(...entries.filter((t) => t.group === "pasted").map(rowOf));
    const own = entries.filter((t) => t.group === "listed");
    $("listed").replaceChildren(...own.map(rowOf));
    show("listed-head", own.length > 0);
    const launched = entries.filter((t) => t.group === "launched");
    $("launched").replaceChildren(...launched.map(rowOf));
    show("launched-head", cfg.launcher !== null && (launched.length > 0 || !query.trim()));
    $("launched-note").textContent = !cfg.launcher
      ? own.length || pasted
        ? ""
        : "No match."
      : launchedList === null
        ? launchedFailed
          ? "Could not read the list. Open it again to retry."
          : "Loading…"
        : launched.length === 0
          ? query.trim()
            ? pasted || own.length
              ? ""
              : "No match."
            : "None yet."
          : "";
  }

  function searched(): void {
    pasted = null;
    const found = pastedAddress(find.value);
    if (found === null) {
      lookupRun++;
      setFindNote("");
    } else if ("error" in found) {
      lookupRun++;
      setFindNote(found.error, true);
    } else void lookUp(found.address, "offer");
    renderList();
  }

  /** The newest launched tokens as a table beside the card; a row chooses its token. */
  function renderRecent(): void {
    show("recent", cfg.launcher !== null);
    if (!cfg.launcher) return;
    const rows = (launchedList ?? []).slice(0, RECENT_SHOWN).map((t) => {
      const tr = el("tr");
      const who = el("a", "who");
      who.href = `?token=${t.address}`;
      const text = el("span", "who-text");
      text.append(el("span", "", t.symbol), el("span", "who-name", t.name));
      who.append(art(t, 28), text);
      who.onclick = (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || busy) return;
        e.preventDefault();
        useToken(t, true);
        window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      };
      const first = el("td");
      first.append(who);
      const name = el("td", "name hide-sm", t.name);
      const last = el("td", "r");
      const href = scan(`token/${t.address}`);
      const address = el(href ? "a" : "span", "mono", shortHex(t.address));
      address.title = t.address;
      if (address instanceof HTMLAnchorElement && href) Object.assign(address, { href, target: "_blank", rel: "noopener noreferrer" });
      last.append(address);
      tr.append(first, name, last);
      return tr;
    });
    $("recent-rows").replaceChildren(...rows);
    $("recent-note").textContent = launchedList === null ? (launchedFailed ? "Could not read the list." : "Loading…") : rows.length ? "" : "None yet.";
  }

  function renderAll(): void {
    if (picker.open) renderList();
    renderRecent();
  }

  // ---------------------------------------------------------------- pool and balances

  /** One round trip: the pool's reserves and supply, and what `who` holds. */
  async function fetchState(t: Address, who: Address | null): Promise<State> {
    const owner = who ?? zeroAddress;
    const bnbOf = { address: MULTICALL3, abi: multicallAbi, functionName: "getEthBalance", args: [owner] } as const;
    const tokenOf = { address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner] } as const;
    let pair = pairAddress;
    if (!pair) {
      const [found, bnb, balance] = await l2.multicall({
        allowFailure: false,
        contracts: [{ address: cfg.factory, abi: factoryAbi, functionName: "getPair", args: [t, WBNB] }, bnbOf, tokenOf],
      });
      if (found === zeroAddress) return { pool: null, held: who ? { bnb, token: balance, liquidity: 0n } : null };
      pair = found;
    }
    const [token0, token1, [reserve0, reserve1], totalSupply, liquidity, bnb, balance] = await l2.multicall({
      allowFailure: false,
      contracts: [
        { address: pair, abi: pairAbi, functionName: "token0" },
        { address: pair, abi: pairAbi, functionName: "token1" },
        { address: pair, abi: pairAbi, functionName: "getReserves" },
        { address: pair, abi: pairAbi, functionName: "totalSupply" },
        { address: pair, abi: pairAbi, functionName: "balanceOf", args: [owner] },
        bnbOf,
        tokenOf,
      ],
    });
    const reserves = orderReserves(token0, token1, t, reserve0, reserve1);
    if (!reserves) throw new Error(MISMATCH);
    return { pool: { pair, bnbFirst: same(token0, WBNB), reserves, totalSupply }, held: who ? { bnb, token: balance, liquidity } : null };
  }

  let stateRun = 0;
  function apply(state: State, t: Address): void {
    stateRun++; // an older read still on its way is dropped
    pairAddress = state.pool?.pair ?? null;
    pool = state.pool;
    held = state.held;
    loaded = token !== null && same(token.address, t);
    render();
  }
  /** Re-reads the pool and the balances for the page; a newer read, another token or a changed account wins. */
  async function refresh(): Promise<void> {
    if (!wired || !token) return;
    const run = ++stateRun;
    const who = account;
    const t = token.address;
    void l2.getGasPrice().then(
      (price) => (gasPrice = price),
      () => undefined,
    );
    try {
      const state = await fetchState(t, who);
      if (run === stateRun && who === account && token && same(token.address, t)) apply(state, t);
    } catch (e) {
      console.warn("Swap state:", e);
    }
  }
  /** A fresh read for a transaction: it fails loudly, and what it returns is what the page then shows. */
  async function reload(t: Chosen, who: Address): Promise<{ pool: Pool | null; held: Holdings }> {
    const state = await fetchState(t.address, who).catch((e: unknown) => {
      console.warn("Swap state:", e);
      return Promise.reject(new Error(e instanceof Error && e.message === MISMATCH ? MISMATCH : BUSY));
    });
    apply(state, t.address);
    return { pool: state.pool, held: state.held! };
  }

  const live = (p: Pool | null): p is Pool => p !== null && p.reserves.bnb > 0n && p.reserves.token > 0n;

  /** The swap the page shows for the amount typed: what it pays out and the least the sender accepts. */
  function swapQuote(): Quote | null {
    const amountIn = parseAmount(a.value, decimalsOf(pay));
    if (!live(pool) || !amountIn) return null;
    const [reserveIn, reserveOut] = pay === "bnb" ? [pool.reserves.bnb, pool.reserves.token] : [pool.reserves.token, pool.reserves.bnb];
    const out = amountOut(amountIn, reserveIn, reserveOut);
    return { amountIn, out, min: minimumOut(out, slippage), impact: impactBps(amountIn, out, reserveIn, reserveOut) };
  }

  // ---------------------------------------------------------------- wallet

  function provider(): EIP1193Provider {
    // The wallet the visitor picked in the wallet dialog: every request and chain switch goes to it.
    const eth = session.provider();
    if (!eth) throw new Error("Connect a wallet first.");
    return eth;
  }

  async function connect(): Promise<Address> {
    setAccount(await session.connect());
    return account!;
  }
  function setAccount(next: Address | null): void {
    if (next === account) return;
    account = next;
    held = null;
    render();
    void refresh();
    void readBnb();
  }

  /** Puts the wallet on LONGYU, adding the network when the wallet lacks it. */
  async function ensureChain(): Promise<void> {
    const eth = provider();
    const current = async () => Number(await eth.request({ method: "eth_chainId" }));
    if ((await current()) === L2_CHAIN_ID) return;
    setStatus(`Switch your wallet to ${PROFILE.l2.name}`);
    const chainId = toHex(L2_CHAIN_ID);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [longyuChainParams({ l2RpcUrl: cfg.rpcUrl, explorerUrl: cfg.explorerUrl })] });
      if ((await current()) !== L2_CHAIN_ID) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
    if ((await current()) !== L2_CHAIN_ID) throw new Error(`Switch your wallet to ${PROFILE.l2.name}.`);
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
    if (native < tx.value + gas * price + dataFee) throw new Error(tx.value > 0n ? `Not enough ${NATIVE} for this amount plus gas.` : `Not enough ${NATIVE} for gas.`);
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
  async function approve(asset: Address, amount: bigint, from: Address, what: string): Promise<string> {
    const allowance = () => l2.readContract({ address: asset, abi: erc20Abi, functionName: "allowance", args: [from, cfg.router] });
    if ((await allowance()) >= amount) return "";
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.router, amount] });
    await transact(from, { to: asset, data, value: 0n }, `1/2 · Approve ${what} in your wallet`, "Approval on LONGYU");
    for (let i = 0; (await allowance()) < amount; i++) {
      if (i === 15) throw new Error("The approval is not visible yet. Try again in a minute.");
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return "2/2 · ";
  }

  const deadline = async () => (await l2.getBlock()).timestamp + BigInt(DEADLINE_SECONDS);

  // ---------------------------------------------------------------- actions

  function typed(input: HTMLInputElement, decimals: number): bigint {
    const text = input.value.trim();
    const amount = parseAmount(text, decimals);
    if (!text) throw new Error("Enter an amount.");
    if (amount === null) throw new Error(decimals === 0 ? "Use whole numbers for this token." : `Use digits and at most ${decimals} decimals.`);
    if (amount === 0n) throw new Error("Enter an amount above 0.");
    return amount;
  }
  function has(holdings: Holdings, asset: Asset, amount: bigint): void {
    const balance = asset === "bnb" ? holdings.bnb : holdings.token;
    if (balance < amount) throw new Error(`Not enough ${symbolOf(asset)}: ${formatShort(balance, 6, decimalsOf(asset))}.`);
  }
  /** The token for an action, checked again against what the page says about it. */
  function tradable(): Chosen {
    if (!token) throw new Error("Choose a token.");
    if (blocked()) throw new Error(token.standing.note ?? "This token does not trade here.");
    return token;
  }

  async function swap(from: Address): Promise<void> {
    const t = tradable();
    const [paid, got]: [Asset, Asset] = pay === "bnb" ? ["bnb", "token"] : ["token", "bnb"];
    typed(a, decimalsOf(paid));
    const shown = swapQuote();
    const fresh = await reload(t, from);
    const now = swapQuote();
    if (!live(fresh.pool) || !now) throw new Error(NO_POOL);
    // The limit comes from the quote the visitor saw; a pool that has moved past it is not traded against.
    const quoted = shown ?? now;
    if (quoted.min === 0n) throw new Error("Amount too small.");
    if (now.out < quoted.min) throw new Error(PRICE_MOVED);
    const amount = quoted.amountIn;
    has(fresh.held, paid, amount);
    const label = `${formatAmount(amount, decimalsOf(paid))} ${symbolOf(paid)}`;
    let receipt: TransactionReceipt;
    if (paid === "bnb") {
      const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [quoted.min, [WBNB, t.address], from, await deadline()] });
      receipt = await transact(from, { to: cfg.router, data, value: amount }, `Confirm the swap of ${label}`, "Swap on LONGYU");
    } else {
      const step = await approve(t.address, amount, from, label);
      const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [amount, quoted.min, [t.address, WBNB], from, await deadline()] });
      receipt = await transact(from, { to: cfg.router, data, value: 0n }, `${step}Confirm the swap of ${label}`, "Swap on LONGYU");
    }
    // What arrived: BNB from the pool's own event, a token from its transfers to the sender (less any fee it takes).
    let received = 0n;
    if (got === "bnb") {
      const pair = fresh.pool.pair;
      const outFirst = fresh.pool.bnbFirst;
      const swaps = parseEventLogs({ abi: pairAbi, eventName: "Swap", logs: receipt.logs.filter((l) => same(l.address, pair)) });
      received = swaps.reduce((sum, e) => sum + (outFirst ? e.args.amount0Out : e.args.amount1Out), 0n);
    } else {
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((l) => same(l.address, t.address)) });
      received = transfers.reduce((sum, e) => sum + (same(e.args.to, from) ? e.args.value : 0n), 0n);
    }
    a.value = "";
    setStatus(received > 0n ? `Received ${formatShort(received, 6, decimalsOf(got))} ${symbolOf(got)}.` : "Swapped.");
  }

  async function add(from: Address): Promise<void> {
    const t = tradable();
    typed(a, DECIMALS);
    typed(b, t.decimals);
    // The fresh read brings the second amount to the pool's ratio of the moment; what is sent is what is then shown.
    const fresh = await reload(t, from);
    const bnb = typed(a, DECIMALS);
    const amount = typed(b, t.decimals);
    has(fresh.held, "bnb", bnb);
    has(fresh.held, "token", amount);
    const step = await approve(t.address, amount, from, `${formatAmount(amount, t.decimals)} ${t.symbol}`);
    const args = [t.address, amount, minimumOut(amount, slippage), minimumOut(bnb, slippage), from, await deadline()] as const;
    const data = encodeFunctionData({ abi: routerAbi, functionName: "addLiquidityETH", args });
    await transact(from, { to: cfg.router, data, value: bnb }, `${step}Confirm the deposit of ${formatAmount(bnb)} ${NATIVE} and ${formatAmount(amount, t.decimals)} ${t.symbol}`, "Deposit on LONGYU");
    a.value = b.value = "";
    setStatus(live(fresh.pool) ? "Liquidity added." : "Pool opened. Liquidity added.");
  }

  async function remove(from: Address): Promise<void> {
    const t = tradable();
    const fresh = await reload(t, from);
    if (!fresh.pool || fresh.held.liquidity === 0n) throw new Error("No liquidity to remove.");
    const liquidity = portion(fresh.held.liquidity, percent);
    const expected = shareOf(liquidity, fresh.pool.totalSupply, fresh.pool.reserves);
    if (liquidity === 0n || expected.bnb === 0n || expected.token === 0n) throw new Error("Amount too small.");
    const step = await approve(fresh.pool.pair, liquidity, from, "your pool share");
    const args = [t.address, liquidity, minimumOut(expected.token, slippage), minimumOut(expected.bnb, slippage), from, await deadline()] as const;
    const data = encodeFunctionData({ abi: routerAbi, functionName: "removeLiquidityETHSupportingFeeOnTransferTokens", args });
    await transact(from, { to: cfg.router, data, value: 0n }, `${step}Confirm the removal`, "Removal on LONGYU");
    setStatus("Liquidity removed.");
  }

  // ---------------------------------------------------------------- form

  const SVG = "http://www.w3.org/2000/svg";
  const chevron = () => {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "chev");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", "m4 6 4 4 4-4");
    svg.append(path);
    return svg;
  };
  /** The token's chip: it opens the picker, on whichever field holds the token. */
  const pickButton = el("button", "chip");
  pickButton.type = "button";
  pickButton.id = "pick";
  pickButton.setAttribute("aria-haspopup", "dialog");
  pickButton.onclick = openPicker;
  /** BNB's chip, which never changes. */
  const bnbChip = el("span", "chip fixed");
  bnbChip.append(tokenArt({ symbol: NATIVE }, { native: true }), el("span", "sym", NATIVE));
  let pickFor: string | null | undefined;
  function drawPick(): void {
    const key = token ? token.address : null;
    if (key === pickFor) return;
    pickFor = key;
    if (!token) {
      pickButton.className = "chip empty";
      pickButton.replaceChildren(el("span", "sym", "Select token"), chevron());
      pickButton.setAttribute("aria-label", "Select a token");
      return;
    }
    pickButton.className = "chip";
    pickButton.replaceChildren(art(token, 28), el("span", "sym", token.symbol), chevron());
    pickButton.setAttribute("aria-label", `${token.symbol}: choose another token`);
  }

  let infoFor: string | null = null;
  const both = (r: Reserves) => `${formatDisplay(r.bnb)} ${NATIVE} · ${formatDisplay(r.token, decimalsOf("token"))} ${symbolOf("token")}`;
  /** The amounts typed, as the main button reads them. */
  function amountState(): { amount: "empty" | "bad" | "ok"; short: string | null } {
    const fields: [HTMLInputElement, Asset][] = mode === "swap" ? [[a, pay]] : [[a, "bnb"], [b, "token"]];
    let state: "empty" | "bad" | "ok" = "ok";
    let short: string | null = null;
    for (const [input, asset] of fields) {
      const text = input.value.trim();
      const amount = parseAmount(text, decimalsOf(asset));
      if (!text || amount === 0n) state = state === "bad" ? "bad" : "empty";
      else if (amount === null) state = "bad";
      else if (held && amount > (asset === "bnb" ? held.bnb : held.token)) short ??= symbolOf(asset);
    }
    return { amount: state, short };
  }

  function render(): void {
    for (const m of ["swap", "add", "remove"]) $(`mode-${m}`).setAttribute("aria-pressed", String(mode === m));
    const [first, second] = sides();
    // The pool once it holds both assets; null before the first deposit.
    const open = live(pool) ? pool : null;
    const stop = blocked();
    const balance = (asset: Asset) => (held && token ? `Balance ${formatDisplay(asset === "bnb" ? held.bnb : held.token, decimalsOf(asset))}` : "");

    // The chips: the token's opens the picker; BNB's is fixed.
    drawPick();
    $("a-chip").replaceChildren(first === "bnb" ? bnbChip : pickButton);
    $("b-chip").replaceChildren(second === "bnb" ? bnbChip : pickButton);
    if (mode === "remove") $("r-chip").replaceChildren(pickButton);

    show("boxes", mode !== "remove");
    show("remove-box", mode === "remove");
    show("flip", mode === "swap");
    show("plus", mode === "add");
    const labels = mode === "swap" ? ["You pay", "You receive"] : ["Deposit", "Deposit"];
    $("a-label").textContent = labels[0]!;
    $("b-label").textContent = labels[1]!;
    a.setAttribute("aria-label", `${labels[0]} ${symbolOf(first)}`);
    b.setAttribute("aria-label", `${labels[1]} ${symbolOf(second)}`);
    $("a-balance").textContent = balance(first);
    $("b-balance").textContent = balance(second);
    show("a-quick", held !== null && !stop);
    show("b-quick", held !== null && !stop && mode === "add");
    b.readOnly = mode === "swap";
    b.tabIndex = mode === "swap" ? -1 : 0;

    // The token, and what the page says about it.
    $("token-note").textContent = token?.standing.note ?? "";
    $("token-note").className = `notice${token?.standing.kind === "imitation" ? " bad" : token?.standing.kind === "other" ? " warn" : ""}`;
    show("token-note", token?.standing.note != null);
    $("note").textContent = !token || !loaded || open || mode === "remove" || stop ? "" : mode === "swap" ? NO_POOL : FIRST_DEPOSIT;

    // Before the first deposit the two amounts typed are the price the pool opens at.
    const typedRate = mode === "add" && !open && token ? rateText({ bnb: parseAmount(a.value) ?? 0n, token: parseAmount(b.value, token.decimals) ?? 0n }, token.decimals, token.symbol) : null;
    $("rate-label").textContent = typedRate ? "Opening price" : "Rate";
    $("rate").textContent = groupedText(typedRate ?? (open && token ? rateText(open.reserves, token.decimals, token.symbol) : null) ?? "–");
    $("pool").textContent = open ? both(open.reserves) : "–";
    $("slip").textContent = formatBps(slippage);
    $("slip-tag").textContent = slippage === SLIPPAGE_CHOICES[0] ? "" : formatBps(slippage);

    let details = false;
    if (mode === "swap") {
      const q = swapQuote();
      b.value = q ? formatDisplay(q.out, decimalsOf(second)).replace(/,/g, "") : "";
      $("impact").textContent = q ? formatBps(q.impact) : "–";
      $("impact").className = q !== null && q.impact >= HIGH_IMPACT_BPS ? "bad" : "";
      $("min").textContent = q ? `${formatDisplay(q.min, decimalsOf(second))} ${symbolOf(second)}` : "–";
      details = q !== null;
    } else if (mode === "add") {
      if (open && token) {
        // The amount not being typed follows the pool's ratio.
        const [from, to, reserveFrom, reserveTo, fromDecimals, toDecimals] =
          edited === "a" ? [a, b, open.reserves.bnb, open.reserves.token, DECIMALS, token.decimals] : [b, a, open.reserves.token, open.reserves.bnb, token.decimals, DECIMALS];
        const amount = parseAmount(from.value, fromDecimals);
        to.value = amount ? formatAmount(fieldAmount(quote(amount, reserveFrom, reserveTo), toDecimals), toDecimals) : "";
      }
      details = token !== null && !stop && (open !== null || typedRate !== null);
    } else {
      const mine = held && pool && held.liquidity > 0n ? held.liquidity : null;
      $("pct").textContent = `${percent}%`;
      $("mine").textContent = !token ? "" : !held ? "–" : mine && pool ? `${formatDisplay(mine)} LP · ${sharePercent(mine, pool.totalSupply)} of the pool` : "No liquidity in this pool";
      const out = mine && pool ? shareOf(portion(mine, percent), pool.totalSupply, pool.reserves) : null;
      $("out-bnb").textContent = out ? `${formatDisplay(out.bnb)} ${NATIVE}` : "–";
      $("out-token").textContent = out ? `${formatDisplay(out.token, decimalsOf("token"))} ${symbolOf("token")}` : "–";
      document.querySelectorAll<HTMLButtonElement>("#percent button").forEach((node) => node.setAttribute("aria-pressed", String(Number(node.dataset.percent) === percent)));
      details = out !== null;
    }
    show("details", details);
    show("rate-row", mode !== "remove");
    show("impact-row", mode === "swap");
    show("min-row", mode === "swap");
    show("fee-row", mode === "swap");
    show("pool-row", mode === "add" && open !== null);
    show("out-bnb-row", mode === "remove");
    show("out-token-row", mode === "remove");
    // Long amounts get a smaller size, so they fit beside the chip.
    for (const input of [a, b]) {
      input.classList.toggle("mid", input.value.length > 7 && input.value.length <= 11);
      input.classList.toggle("long", input.value.length > 11);
    }
    document.querySelectorAll<HTMLButtonElement>("#slippage button").forEach((node) => node.setAttribute("aria-pressed", String(Number(node.dataset.bps) === slippage)));

    // The main button says what is missing until the action is complete.
    const send = $("send") as HTMLButtonElement;
    const action = actionFor({ mode, hasToken: token !== null, trades: token?.standing.trade ?? false, loaded, poolLive: open !== null, ...amountState(), liquidity: held ? held.liquidity : null });
    show("connect", account === null);
    show("send", account !== null);
    if (!busy) send.textContent = action.label;
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#swap button, #swap input, #watch").forEach((node) => (node.disabled = busy));
    send.disabled = busy || !action.ready;
    send.setAttribute("aria-busy", String(busy && account !== null));
    $("connect").setAttribute("aria-busy", String(busy && account === null));
    // A token the page does not trade leaves nothing to type or send.
    if (stop) for (const node of [a, b, send, $("flip") as HTMLButtonElement]) node.disabled = true;
    pickButton.disabled = busy;

    renderInfo(open);
  }

  /** The panel beside the card: the token's price, its pool, the account's share and the contracts. */
  function renderInfo(open: Pool | null): void {
    show("info-empty", token === null);
    show("info-body", token !== null);
    $("info").classList.toggle("is-empty", token === null);
    if (!token) return void (infoFor = null);
    if (infoFor !== token.address) {
      infoFor = token.address;
      drawArt($("info-art"), token, { size: 44, official: isOfficial(token.address), apiUrl: cfg.apiUrl });
      $("info-symbol").textContent = token.symbol;
      $("info-name").textContent = token.name;
      const link = $("info-token-link") as HTMLAnchorElement;
      const href = scan(`token/${token.address}`);
      if (href) link.href = href;
      else link.removeAttribute("href");
      link.textContent = shortHex(token.address);
      link.title = token.address;
    }
    const price = open ? tokenPrice(open.reserves, token.decimals) : null;
    $("info-price").textContent = price !== null ? formatPrice(price) : loaded ? "No pool yet" : "–";
    $("info-price").classList.toggle("none", price === null && loaded);
    $("info-unit").hidden = price === null;
    $("info-rate").textContent = open ? groupedText(rateText(open.reserves, token.decimals, token.symbol) ?? "") : "";
    // Without a pool there is nothing to count: the one line says so.
    show("info-stats", open !== null || !loaded);
    $("info-bnb").textContent = open ? formatDisplay(open.reserves.bnb) : "–";
    $("info-token").textContent = open ? formatDisplay(open.reserves.token, token.decimals) : "–";
    $("info-token-label").textContent = `${token.symbol} in pool`;
    $("info-lp").textContent = held ? formatDisplay(held.liquidity) : "–";
    $("info-share").textContent = held && pool ? sharePercent(held.liquidity, pool.totalSupply) : "–";
    show("info-pair-row", pairAddress !== null);
    if (pairAddress) {
      const pair = $("info-pair") as HTMLAnchorElement;
      const href = scan(`address/${pairAddress}`);
      if (href) pair.href = href;
      else pair.removeAttribute("href");
      pair.textContent = shortHex(pairAddress);
      pair.title = pairAddress;
    }
    show("watch", token.standing.kind !== "imitation");
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
      pay = flipped(pay);
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
      // Closing the wallet dialog is not an error.
      if (!closedByVisitor(e)) $("error").textContent = swapErrorMessage(e);
    } finally {
      busy = false;
      render();
      void refresh();
      void readBnb();
    }
  }

  /** The account's BNB on LONGYU, for the wallet button in the bar. */
  let bnbRun = 0;
  async function readBnb(): Promise<void> {
    const run = ++bnbRun;
    const who = account;
    if (!who) return;
    try {
      const value = await l2.getBalance({ address: who });
      if (run === bnbRun && who === account) shell.balance(`${formatDisplay(value)} ${NATIVE}`);
    } catch {
      // The button keeps the address alone.
    }
  }

  // Slippage: a small menu under the settings button.
  const settings = $("settings");
  const setPop = (open: boolean) => {
    show("settings-pop", open);
    settings.setAttribute("aria-expanded", String(open));
  };
  settings.onclick = () => {
    setPop($("settings-pop").hidden);
    if (!$("settings-pop").hidden) $("settings-pop").querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  };
  document.addEventListener("click", (e) => {
    if (!$("settings-pop").hidden && !(e.target as Element).closest(".pop-at")) setPop(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("settings-pop").hidden) return;
    setPop(false);
    settings.focus();
  });
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
  $("picker-close").onclick = closePicker;
  find.oninput = searched;
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
        if (!held || !token) return;
        const asset = sides()[side === "a" ? 0 : 1];
        const share = Number(node.dataset.share);
        // BNB also pays for gas, so a share of it leaves some behind.
        const amount = asset === "bnb" ? shareAmount(held.bnb, share, gasReserve(gasPrice)) : shareAmount(held.token, share, 0n, token.decimals);
        (side === "a" ? a : b).value = amount > 0n ? formatAmount(amount, decimalsOf(asset)) : "";
        edited = side;
        clear();
        if (amount === 0n) $("error").textContent = asset === "bnb" && held.bnb > 0n ? `Not enough ${NATIVE} to leave for gas.` : `No ${symbolOf(asset)} here yet.`;
        render();
      };
    });
  }
  $("connect").onclick = () => run(async () => void (await connect()));
  $("send").onclick = () =>
    run(async () => {
      const action = mode === "swap" ? swap : mode === "add" ? add : remove;
      tradable();
      const from = await connect();
      await checkWiring();
      await action(from);
    });
  $("watch").onclick = () =>
    run(async () => {
      if (!token) return;
      await provider().request({ method: "wallet_watchAsset", params: { type: "ERC20", options: { address: token.address, symbol: token.symbol, decimals: token.decimals } } });
    });

  // A wallet connected before is used again, and a change of account in it reaches the page.
  session.onChange(() => setAccount(session.account()));

  // The token a link names, else the network's own when it trades; otherwise the visitor chooses one.
  const link = linkParams(location.search);
  if (link.mode) mode = link.mode;
  render();
  renderRecent();
  if (cfg.launcher) void loadLaunched().then(renderAll);
  void readListed().then(() => {
    if (link.token) {
      void lookUp(link.token, "choose").then(() => {
        if (!token) $("error").textContent = $("find-note").textContent || "Could not read the token in this link.";
      });
    } else if (link.badToken) $("error").textContent = "The token address in this link is not valid.";
    else if (PROFILE.tradeToken) useToken(listed, false, false);
    else render();
  });
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
    void readBnb();
  }, 15_000);
}
