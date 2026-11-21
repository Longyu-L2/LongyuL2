/**
 * Safe page: the signers of a Safe v1.3.0 multisig on BSC testnet or LONGYU create a transaction,
 * approve it and execute it, each with their own wallet. Nothing here holds a key, and there is no
 * server: the transaction travels in the page's link and every approval is on the chain.
 *
 * - Create: the form writes the transaction (to, amount, data, nonce) into the link.
 * - Approve: a signer calls approveHash(hash) on the Safe. The hash is computed here and must equal
 *   the Safe's own getTransactionHash, so the page and the Safe agree on what is being approved.
 * - Execute: once enough signers approved, anyone calls execTransaction naming them. A signer who
 *   executes counts as an approval. The execution is simulated first; one that would fail never
 *   reaches the wallet, and a failing inner call reverts the whole execution, so a nonce is spent
 *   only by a transaction that worked.
 *
 * A call is named only from the list in safe-core.ts; anything else is shown as raw data.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseEventLogs,
  toHex,
  type Address,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { bscTestnet } from "viem/chains";
import { chainConfig, publicActionsL2 } from "viem/op-stack";
import { DECIMALS, L1_CHAIN_ID, L1_EXPLORER, L2_CHAIN_ID, formatAmount, isUnknownChain, l1TxUrl, l2TxUrl, longyuChainParams, parseAddress, parseAmount, shortHex } from "./bridge-core.ts";
import { MULTICALL3, multicallAbi } from "./swap-core.ts";
import {
  CALLS,
  CHAIN_NAMES,
  GUARD_SLOT,
  SAFE_VERSION,
  SENTINEL,
  chooseSigners,
  decodeCall,
  encodeCall,
  encodeLink,
  execArgs,
  hashArgs,
  packApprovals,
  parseData,
  parseLink,
  parseSafeConfig,
  safeAbi,
  safeErrorMessage,
  safeTxHash,
  stageOf,
  type RawSafeConfig,
  type SafeChainId,
  type SafeConfig,
  type SafeLink,
  type SafeTx,
} from "./safe-core.ts";

declare const __SAFE_CONFIG__: RawSafeConfig;
declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => ($(id).hidden = !on);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What the chain says about the Safe in the link. */
interface Info {
  owners: readonly Address[];
  threshold: number;
  nonce: bigint;
  balance: bigint;
  modules: number;
  guard: boolean;
}
/** What the chain says about the transaction in the link. */
interface View {
  hash: Hex;
  /** Lower-case addresses of the signers who approved on the chain. */
  approved: Set<string>;
  /** Whether the inner call would fail if executed now; null when not checked or unknown. */
  fails: boolean | null;
}
interface Loaded {
  info: Info;
  view: View | null;
}

const NOT_SAFE = `Not a Safe v${SAFE_VERSION} on this chain.`;
const BUSY = "Network busy. Try again.";
const parsed = parseSafeConfig(typeof __SAFE_CONFIG__ === "undefined" ? null : __SAFE_CONFIG__);
if (parsed.ok) start(parsed.config);
else closePage(parsed.problems);

/** Without a valid configuration the page shows one line and no action works. */
function closePage(problems: string[]): void {
  $("closed").textContent = "This page is unavailable on this address.";
  show("closed", true);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input, select, textarea").forEach((node) => (node.disabled = true));
  console.info(`Safe page closed: ${problems.join("; ")}.`);
}

function start(cfg: SafeConfig): void {
  const longyu = defineChain({
    ...chainConfig,
    id: L2_CHAIN_ID,
    name: "LONGYU Testnet",
    nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: DECIMALS },
    rpcUrls: { default: { http: [cfg.l2RpcUrl] } },
    ...(cfg.explorerUrl ? { blockExplorers: { default: { name: "LONGYU Explorer", url: cfg.explorerUrl } } } : {}),
    blockTime: 250,
    contracts: { ...chainConfig.contracts, multicall3: { address: MULTICALL3 } },
    testnet: true,
  });
  // Reads go to the configured RPCs, never through the wallet, so they do not depend on its network.
  const l1 = createPublicClient({ chain: bscTestnet, transport: http(cfg.l1RpcUrl) });
  const l2 = createPublicClient({ chain: longyu, transport: http(cfg.l2RpcUrl) }).extend(publicActionsL2());
  const reader = (chainId: SafeChainId) => (chainId === L1_CHAIN_ID ? l1 : l2);
  const bscParams = { chainId: toHex(L1_CHAIN_ID), chainName: bscTestnet.name, nativeCurrency: bscTestnet.nativeCurrency, rpcUrls: [cfg.l1RpcUrl], blockExplorerUrls: [L1_EXPLORER] };

  const safeInput = $("safe") as HTMLInputElement;
  const callSelect = $("call") as HTMLSelectElement;
  const nonceInput = $("tx-nonce") as HTMLInputElement;

  /** The chain chosen for the Open button. */
  let chosen: SafeChainId = L2_CHAIN_ID;
  let link: SafeLink | null = null;
  let info: Info | null = null;
  let view: View | null = null;
  let account: Address | null = null;
  let busy = false;
  /** The hash of a transaction executed from this page, so the page can say so. */
  let executed: Hex | null = null;

  // ---------------------------------------------------------------- reading the Safe

  function failed(e: unknown, names: string[]): boolean {
    for (let cur = e as { name?: string; cause?: unknown } | undefined, i = 0; cur && typeof cur === "object" && i < 8; cur = cur.cause as typeof cur, i++) {
      if (cur.name && names.includes(cur.name)) return true;
    }
    return false;
  }

  /** Two round trips: the Safe, then its hash for the transaction and each signer's approval. */
  async function fetchState(target: SafeLink): Promise<Loaded> {
    const client = reader(target.chainId);
    const safe = { address: target.safe, abi: safeAbi } as const;
    const tx = target.tx;
    const local = tx ? safeTxHash(target.chainId, target.safe, tx) : null;
    const first = await client.multicall({
      contracts: [
        { ...safe, functionName: "VERSION" },
        { ...safe, functionName: "getOwners" },
        { ...safe, functionName: "getThreshold" },
        { ...safe, functionName: "nonce" },
        { ...safe, functionName: "getModulesPaginated", args: [SENTINEL, 10n] },
        { ...safe, functionName: "getStorageAt", args: [BigInt(GUARD_SLOT), 1n] },
        { address: MULTICALL3, abi: multicallAbi, functionName: "getEthBalance", args: [target.safe] },
      ],
    });
    if (first.some((r) => r.status !== "success")) throw new Error(NOT_SAFE);
    const [version, owners, threshold, nonce, modules, guard, balance] = first.map((r) => r.result) as [string, readonly Address[], bigint, bigint, readonly [readonly Address[], Address], Hex, bigint];
    // A contract that answers differently is not the Safe this page knows how to drive.
    if (version !== SAFE_VERSION || owners.length === 0 || threshold < 1n || threshold > BigInt(owners.length)) throw new Error(NOT_SAFE);
    const state: Info = { owners, threshold: Number(threshold), nonce, balance, modules: modules[0].length, guard: BigInt(guard) !== 0n };
    if (!tx || !local) return { info: state, view: null };
    const [onChain, approvals] = await Promise.all([
      client.readContract({ ...safe, functionName: "getTransactionHash", args: hashArgs(tx) }),
      client.multicall({ allowFailure: false, contracts: owners.map((owner) => ({ ...safe, functionName: "approvedHashes", args: [owner, local] }) as const) }),
    ]);
    // The page approves and executes only a hash the Safe itself computes for this transaction.
    if (!same(onChain, local)) throw new Error(NOT_SAFE);
    const approved = new Set(owners.filter((_, i) => approvals[i] !== 0n).map((o) => o.toLowerCase()));
    let fails: boolean | null = null;
    if (stageOf(tx.nonce, nonce) === "ready") {
      // The inner call as the Safe would make it.
      fails = await client.call({ account: target.safe, to: tx.to, data: tx.data, value: tx.value }).then(
        () => false,
        (e: unknown) => (failed(e, ["ExecutionRevertedError", "ContractFunctionRevertedError", "InsufficientFundsError"]) ? true : null),
      );
    }
    return { info: state, view: { hash: local, approved, fails } };
  }

  let run = 0;
  function apply(state: Loaded): void {
    run++; // an older read still on its way is dropped
    info = state.info;
    view = state.view;
    render();
  }
  /** Re-reads the Safe for the page; a newer read or a changed link wins. Says why only when asked to. */
  async function refresh(loud = false): Promise<void> {
    if (!link) return;
    const mine = ++run;
    const target = link;
    try {
      const state = await fetchState(target);
      if (mine === run && target === link) apply(state);
    } catch (e) {
      console.warn("Safe state:", e);
      if (loud && mine === run && target === link) $("error").textContent = e instanceof Error && e.message === NOT_SAFE ? NOT_SAFE : BUSY;
    }
  }
  /** A fresh read for a transaction: it fails loudly, and what it returns is what the page then shows. */
  async function reload(): Promise<{ target: SafeLink & { tx: SafeTx }; info: Info; view: View }> {
    const target = link;
    if (!target?.tx) throw new Error("Open a transaction first.");
    const state = await fetchState(target).catch((e: unknown) => {
      console.warn("Safe state:", e);
      return Promise.reject(new Error(e instanceof Error && e.message === NOT_SAFE ? NOT_SAFE : BUSY));
    });
    if (target !== link || !state.view) throw new Error("The link changed. Try again.");
    apply(state);
    return { target: { ...target, tx: target.tx }, info: state.info, view: state.view };
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
    render();
  }

  /** Puts the wallet on the Safe's chain, adding the network when the wallet lacks it. */
  async function ensureChain(id: SafeChainId): Promise<void> {
    const eth = provider();
    const current = async () => Number(await eth.request({ method: "eth_chainId" }));
    if ((await current()) === id) return;
    setStatus(`Switch your wallet to ${CHAIN_NAMES[id]}`);
    const chainId = toHex(id);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await eth.request({ method: "wallet_addEthereumChain", params: [id === L1_CHAIN_ID ? bscParams : longyuChainParams(cfg)] });
      if ((await current()) !== id) await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
    if ((await current()) !== id) throw new Error(`Switch your wallet to ${CHAIN_NAMES[id]}.`);
  }

  const setStatus = (s: string) => ($("status").textContent = s);
  function setLink(chainId: SafeChainId, hash: Hex, text: string): void {
    const node = $("tx") as HTMLAnchorElement;
    const href = chainId === L1_CHAIN_ID ? l1TxUrl(hash) : l2TxUrl(cfg.explorerUrl, hash);
    if (href) node.href = href;
    else node.removeAttribute("href");
    node.textContent = href ? text : `${CHAIN_NAMES[chainId]} ${shortHex(hash)}`;
    show("tx", true);
  }

  /**
   * Simulates a call to the Safe from the signer, checks the signer can pay for it, sends it through
   * the wallet with room above the estimate (a Safe passes its gas on to the inner call) and waits.
   */
  async function transact(chainId: SafeChainId, from: Address, to: Address, data: Hex, confirm: string, linkText: string): Promise<TransactionReceipt> {
    const client = reader(chainId);
    const request = { account: from, to, data, value: 0n };
    const [estimate, price, dataFee, native] = await Promise.all([
      client.estimateGas(request),
      client.getGasPrice(),
      chainId === L2_CHAIN_ID ? l2.estimateL1Fee({ ...request, chain: longyu }).catch(() => 0n) : 0n,
      client.getBalance({ address: from }),
    ]);
    const gas = estimate + estimate / 4n + 10_000n;
    if (native < gas * price + dataFee) throw new Error("Not enough tBNB for gas.");
    await ensureChain(chainId);
    setStatus(confirm);
    const wallet = createWalletClient({ chain: chainId === L1_CHAIN_ID ? bscTestnet : longyu, transport: custom(provider()) });
    const hash = await wallet.sendTransaction({ ...request, gas });
    setLink(chainId, hash, linkText);
    setStatus(`Confirming on ${CHAIN_NAMES[chainId]}…`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction failed. Only gas was spent.");
    return receipt;
  }

  // ---------------------------------------------------------------- actions

  const isSigner = (state: Info, who: Address) => state.owners.some((o) => same(o, who));

  async function approve(): Promise<void> {
    const from = await connect();
    const { target, info: fresh, view: now } = await reload();
    if (!isSigner(fresh, from)) throw new Error("This wallet is not a signer of this Safe.");
    if (stageOf(target.tx.nonce, fresh.nonce) === "used") throw new Error(`Nonce ${target.tx.nonce} is already used.`);
    if (now.approved.has(from.toLowerCase())) throw new Error("Already approved.");
    const data = encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [now.hash] });
    await transact(target.chainId, from, target.safe, data, `Confirm the approval of ${shortHex(now.hash)}`, `Approval on ${CHAIN_NAMES[target.chainId]}`);
    setStatus("Approved.");
  }

  async function execute(): Promise<void> {
    const from = await connect();
    const { target, info: fresh, view: now } = await reload();
    const stage = stageOf(target.tx.nonce, fresh.nonce);
    if (stage === "used") throw new Error(`Nonce ${target.tx.nonce} is already used.`);
    if (stage === "queued") throw new Error(`Nonce ${fresh.nonce} must be executed first.`);
    const signers = chooseSigners(fresh.owners, now.approved, from, fresh.threshold);
    if (!signers) throw new Error("Not enough approvals.");
    const data = encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: execArgs(target.tx, packApprovals(signers)) });
    const receipt = await transact(target.chainId, from, target.safe, data, `Confirm the execution of ${shortHex(now.hash)}`, `Execution on ${CHAIN_NAMES[target.chainId]}`);
    // The Safe's own event, for this hash.
    const events = parseEventLogs({ abi: safeAbi, eventName: "ExecutionSuccess", logs: receipt.logs.filter((l) => same(l.address, target.safe)) });
    if (!events.some((e) => same(e.args.txHash, now.hash))) throw new Error("The Safe did not report this transaction as executed. Check the transaction link.");
    executed = now.hash;
    setStatus("Executed.");
  }

  /** Reads the form into a link. The link is the whole proposal. */
  function create(): void {
    if (!link || !info) throw new Error("Open a Safe first.");
    const to = parseAddress(($("to") as HTMLInputElement).value);
    if (!to) throw new Error("Enter the address the Safe should call.");
    const amount = ($("value") as HTMLInputElement).value.trim();
    const value = amount === "" ? 0n : parseAmount(amount);
    if (value === null) throw new Error("Amount: use digits and at most 18 decimals.");
    let data: Hex;
    if (callSelect.value === "") data = "0x";
    else if (callSelect.value === "raw") {
      const raw = parseData(($("raw") as HTMLTextAreaElement).value);
      if (!raw) throw new Error("Data: use hex bytes starting with 0x.");
      data = raw;
    } else {
      const call = CALLS.find((c) => c.selector === callSelect.value);
      if (!call) throw new Error("Choose a call.");
      data = encodeCall(call, Array.from(document.querySelectorAll<HTMLInputElement>("#args input"), (n) => n.value));
    }
    if (value === 0n && data === "0x") throw new Error("Enter an amount or choose a call.");
    const nonceText = nonceInput.value.trim();
    if (!/^(0|[1-9]\d{0,17})$/.test(nonceText)) throw new Error("Nonce: use a whole number.");
    const nonce = BigInt(nonceText);
    if (nonce < info.nonce) throw new Error(`Nonce ${nonce} is already used. The next is ${info.nonce}.`);
    go({ chainId: link.chainId, safe: link.safe, tx: { to, value, data, nonce } });
  }

  // ---------------------------------------------------------------- page

  function go(next: SafeLink): void {
    const fragment = encodeLink(next);
    if (location.hash === fragment) route();
    else location.hash = fragment; // route() runs on the hashchange event
  }

  /** The link decides what the page shows. */
  function route(): void {
    clear();
    const fragment = location.hash;
    const next = fragment.length > 1 ? parseLink(fragment) : null;
    if (fragment.length > 1 && !next) $("error").textContent = "This link is not valid.";
    const moved = !link || !next || link.chainId !== next.chainId || link.safe !== next.safe;
    link = next;
    view = null;
    if (moved) info = null;
    if (next) {
      chosen = next.chainId;
      safeInput.value = next.safe;
    }
    nonceInput.value = "";
    render();
    void refresh(true);
  }

  const item = (text: string, tag: string, yes = false): HTMLLIElement => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "mono";
    name.textContent = text;
    const mark = document.createElement("span");
    mark.className = yes ? "tag yes" : "tag";
    mark.textContent = tag;
    li.append(name, mark);
    return li;
  };
  const rowOf = (label: string, value: string): HTMLDivElement => {
    const row = document.createElement("div");
    row.className = "row";
    const left = document.createElement("span");
    left.className = "muted";
    left.textContent = label;
    const right = document.createElement("span");
    right.className = "mono";
    right.textContent = value;
    row.append(left, right);
    return row;
  };

  function render(): void {
    document.querySelectorAll<HTMLButtonElement>("#chain button").forEach((node) => node.setAttribute("aria-pressed", String(Number(node.dataset.chain) === chosen)));
    const tx = link?.tx ?? null;
    show("info", info !== null);
    show("new-card", info !== null && !tx);
    show("tx-card", info !== null && tx !== null);
    const me = account;

    if (info) {
      $("threshold").textContent = `${info.threshold} of ${info.owners.length}`;
      $("balance").textContent = `${formatAmount(info.balance)} tBNB`;
      $("nonce").textContent = info.nonce.toString();
      const warnings = [info.modules > 0 ? "This Safe has a module, which can move its funds without the signers." : "", info.guard ? "This Safe has a guard, which can block its transactions." : ""];
      $("warn").textContent = warnings.filter(Boolean).join(" ");
      $("owners").replaceChildren(...info.owners.map((o) => item(o, me && same(o, me) ? "You" : "")));
      if (!tx && nonceInput.value === "") nonceInput.value = info.nonce.toString();
    }

    if (info && link && tx) {
      const decoded = decodeCall(tx.data);
      $("t-to").textContent = same(tx.to, link.safe) ? `${tx.to} (this Safe)` : tx.to;
      $("t-value").textContent = `${formatAmount(tx.value)} tBNB`;
      $("t-call").textContent = tx.data === "0x" ? "None" : decoded ? decoded.call.fn.name : "Unknown";
      $("t-call").classList.toggle("bad", tx.data !== "0x" && !decoded);
      $("t-args").replaceChildren(...(decoded?.args ?? []).map((a) => rowOf(`${a.name} · ${a.type}`, a.value)));
      $("t-data").textContent = tx.data;
      show("t-data", tx.data !== "0x");
      $("t-nonce").textContent = tx.nonce.toString();
      $("t-hash").textContent = view ? view.hash : "–";
      const count = view ? info.owners.filter((o) => view!.approved.has(o.toLowerCase())).length : 0;
      $("t-count").textContent = view ? `${count} of ${info.threshold}` : "–";
      $("approvals").replaceChildren(...(view ? info.owners.map((o) => item(me && same(o, me) ? `${o} (you)` : o, view!.approved.has(o.toLowerCase()) ? "Approved" : "–", view!.approved.has(o.toLowerCase()))) : []));
      const stage = stageOf(tx.nonce, info.nonce);
      const unknown = tx.data !== "0x" && !decoded;
      const notes = stage === "used" ? [] : [unknown ? "Unknown call. Check the data before approving." : "", stage === "queued" ? `Runs after nonce ${info.nonce}.` : "", view?.fails ? "Would fail if executed now." : ""];
      const done = view && executed === view.hash ? "Executed." : `Nonce ${tx.nonce} is used: this transaction was executed or replaced.`;
      $("t-note").textContent = stage === "used" ? done : notes.filter(Boolean).join(" ");
      $("t-note").classList.toggle("bad", stage !== "used" && (unknown || view?.fails === true));
      ($("link") as HTMLInputElement).value = location.href;
      const signer = me !== null && isSigner(info, me);
      show("approve", view !== null && signer && stage !== "used" && !view.approved.has(me!.toLowerCase()));
      show("execute", view !== null && me !== null && stage === "ready" && chooseSigners(info.owners, view.approved, me, info.threshold) !== null);
    }

    show("connect", account === null);
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("button, input, select, textarea").forEach((node) => (node.disabled = busy));
  }

  function clear(): void {
    show("tx", false);
    setStatus("");
    $("error").textContent = "";
  }

  async function task(work: () => Promise<void> | void): Promise<void> {
    if (busy) return;
    busy = true;
    clear();
    render();
    try {
      await work();
    } catch (e) {
      setStatus("");
      $("error").textContent = safeErrorMessage(e);
    } finally {
      busy = false;
      render();
      void refresh();
    }
  }

  // The calls the form can build, by name.
  const option = (value: string, text: string): HTMLOptionElement => {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = text;
    return node;
  };
  callSelect.append(option("", "None, send tBNB only"), ...CALLS.filter((c) => c.simple).map((c) => option(c.selector, c.signature)), option("raw", "Raw data"));
  callSelect.onchange = () => {
    const call = CALLS.find((c) => c.selector === callSelect.value);
    show("raw-box", callSelect.value === "raw");
    $("args").replaceChildren(
      ...(call?.fn.inputs ?? []).map((input, i) => {
        const box = document.createElement("div");
        box.className = "box";
        const label = document.createElement("label");
        label.htmlFor = `arg-${i}`;
        label.textContent = `${input.name || `#${i + 1}`} · ${input.type}`;
        const field = document.createElement("input");
        field.id = `arg-${i}`;
        field.type = "text";
        field.className = "mono";
        field.autocomplete = "off";
        field.spellcheck = false;
        field.maxLength = 1_000;
        box.append(label, field);
        return box;
      }),
    );
  };

  document.querySelectorAll<HTMLButtonElement>("#chain button").forEach((node) => {
    node.onclick = () => {
      chosen = Number(node.dataset.chain) === L1_CHAIN_ID ? L1_CHAIN_ID : L2_CHAIN_ID;
      render();
    };
  });
  $("open").onclick = () =>
    task(() => {
      const safe = parseAddress(safeInput.value);
      if (!safe) throw new Error("Enter the Safe's address.");
      go({ chainId: chosen, safe, tx: null });
    });
  $("create").onclick = () => task(create);
  $("discard").onclick = () => {
    if (link && !busy) go({ chainId: link.chainId, safe: link.safe, tx: null });
  };
  $("copy").onclick = () => {
    const field = $("link") as HTMLInputElement;
    navigator.clipboard.writeText(field.value).then(
      () => setStatus("Link copied."),
      () => field.select(), // no clipboard access: the link is selected to copy by hand
    );
  };
  $("approve").onclick = () => task(approve);
  $("execute").onclick = () => task(execute);
  $("connect").onclick = () => task(async () => void (await connect()));

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

  window.addEventListener("hashchange", route);
  route();
  setInterval(() => {
    if (!document.hidden && !busy) void refresh();
  }, 15_000);
}
