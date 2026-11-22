/**
 * Launch page: makes a token with LONGYU Launch from the visitor's own wallet. Nothing here holds a key.
 *
 * One transaction: TokenLauncher.launch(name, symbol, wholeTokens). The form checks the name, the
 * symbol and the supply by the contract's own rules first, the contract's passesForLongyu is asked
 * too, and the call is simulated, so a launch the contract would refuse never reaches the wallet.
 * The new token's address comes from the launcher's TokenLaunched event in the receipt.
 *
 * Every token launched here gets a logo: the page does not launch without one. The logo is not on
 * chain: the token's creator signs a message naming the token, the
 * chain and the image's SHA-256 (logoMessage in launch-core.ts), and LONGYU's API keeps the image. The
 * signature is asked for only after the launch, so a refused or failed upload never touches the token;
 * the result offers it again, and a creator can set or replace the logo of an earlier token below.
 *
 * Names and symbols read from the chain are only ever set as text.
 */
import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, erc20Abi, getAddress, http, parseAbi, toHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { chainConfig, publicActionsL2 } from "viem/op-stack";
import { DECIMALS, L2_CHAIN_ID, NATIVE, isUnknownChain, l2TxUrl, longyuChainParams, parseAddress, shortHex } from "./bridge-core.ts";
import {
  RESERVED,
  checkLaunch,
  formatSupplyInput,
  formatWhole,
  hexOf,
  launchErrorMessage,
  launchedToken,
  logoErrorMessage,
  logoFileProblem,
  logoMessage,
  logoSizeProblem,
  parseLaunchConfig,
  toBase64,
  tokenLinks,
  type Field,
  type LaunchConfig,
  type RawLaunchConfig,
} from "./launch-core.ts";
import { MULTICALL3, formatDisplay, launcherAbi, logoUrl, newestRange, tokenFrom, type Read } from "./swap-core.ts";
import { appShell, drawArt, logoChanged, tokenArt } from "./app-shell.ts";
import { closedByVisitor, walletSession } from "./wallet-modal.ts";
import { PROFILE } from "./profile.ts";

declare const __LAUNCH_CONFIG__: RawLaunchConfig;
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
const FIELDS: Field[] = ["name", "symbol", "supply"];
const RECENT_SHOWN = 10;
/** What a launched token answers about who made it (contracts/src/TokenLauncher.sol, LaunchedToken). */
const creatorAbi = parseAbi(["function creator() view returns (address)"]);

const MISMATCH = "Launch contract does not match LONGYU.";
const parsed = parseLaunchConfig(typeof __LAUNCH_CONFIG__ === "undefined" ? null : __LAUNCH_CONFIG__);
if (parsed.ok) start(parsed.config);
else closeLaunch(parsed.problems);

/** Without a complete, valid configuration the page shows one line and no action works. */
/** The launch button's word when no logo is chosen yet. */
const LOGO_REQUIRED = "Add a logo first: PNG, JPEG or WebP, up to 256 KB.";

function closeLaunch(problems: string[]): void {
  appShell();
  $("closed").textContent = "Launch is unavailable on this address.";
  show("closed", true);
  show("recent", false);
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#launch button, #launch input").forEach((node) => (node.disabled = true));
  console.info(`Launch closed: ${problems.join("; ")}.`);
}

/** A logo chosen on the page, checked as the API checks it. */
interface Logo {
  bytes: Uint8Array<ArrayBuffer>;
  /** The file shown from the visitor's own disk, before anything is sent. */
  url: string;
  name: string;
}

function start(cfg: LaunchConfig): void {
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
  const input = (field: Field) => $(field) as HTMLInputElement;
  const session = walletSession();
  const shell = appShell({ session, connect: () => void run(async () => void (await connect())), explorerUrl: cfg.explorerUrl, chainId: L2_CHAIN_ID, switchChain: () => ensureChain() });
  const scan = (path: string) => (cfg.explorerUrl ? `${cfg.explorerUrl}/${path}` : null);

  let account: Address | null = null;
  let busy = false;
  /** The token launched last, for the result card. */
  let made: { token: Address; name: string; symbol: string; wholeTokens: bigint; logoSet: boolean } | null = null;
  /** The logo for the next launch, and for a token launched before. */
  let logo: Logo | null = null;
  let later: Logo | null = null;
  /** Fields the visitor has left once: their problems show as they type. */
  const touched = new Set<Field>();

  // ---------------------------------------------------------------- wiring check

  /** Ties TOKEN_LAUNCHER to LONGYU Launch on chain before the first launch. */
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
    if (chainId !== L2_CHAIN_ID) {
      console.warn(`Launch wiring: L2_RPC_URL serves chain ${chainId}, not ${L2_CHAIN_ID}.`);
      throw new Error(MISMATCH);
    }
    try {
      // LONGYU's own token passes for itself: a launcher that does not say so is not LONGYU Launch.
      const [, own] = await Promise.all([
        l2.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "tokenCount" }),
        l2.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "passesForLongyu", args: [PROFILE.token.name, PROFILE.token.symbol] }),
      ]);
      if (!own) throw new Error(MISMATCH);
    } catch (e) {
      console.warn("Launch wiring check failed:", e);
      throw new Error(e instanceof Error && e.message === MISMATCH ? MISMATCH : isContractError(e) ? MISMATCH : "Network busy. Try again.");
    }
  }
  /** A read that reached the chain and failed there (no code, wrong contract), as opposed to a network error. */
  function isContractError(e: unknown): boolean {
    for (let cur = e as { name?: string; cause?: unknown } | undefined, i = 0; cur && i < 8; cur = cur.cause as typeof cur, i++) {
      if (cur.name === "ContractFunctionZeroDataError" || cur.name === "ContractFunctionRevertedError") return true;
    }
    return false;
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
    render();
    void readBnb();
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

  const setStatus = (s: string) => ($("status").textContent = s);
  function setLink(hash: Hex): void {
    const link = $("tx") as HTMLAnchorElement;
    const href = l2TxUrl(cfg.explorerUrl, hash);
    if (href) link.href = href;
    else link.removeAttribute("href");
    link.textContent = href ? "Launch on LONGYU" : `LONGYU ${shortHex(hash)}`;
    show("tx", true);
  }

  // ---------------------------------------------------------------- logos

  /** Reads a chosen file and checks it as the API will: its kind, its size and its pixels. */
  async function readLogo(file: File): Promise<Logo> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problem = logoFileProblem(bytes);
    if (problem) throw new Error(problem);
    let size: { width: number; height: number };
    try {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: file.type || "application/octet-stream" }));
      size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
    } catch {
      throw new Error("That image cannot be read. Try another file.");
    }
    const pixels = logoSizeProblem(size.width, size.height);
    if (pixels) throw new Error(pixels);
    return { bytes, url: URL.createObjectURL(new Blob([bytes], { type: file.type })), name: file.name };
  }

  /** The creator signs the logo's message, and LONGYU's API keeps the image. */
  async function uploadLogo(token: Address, chosen: Logo, from: Address, note: (s: string) => void): Promise<void> {
    if (!cfg.apiUrl) throw new Error("Logos are not available on this address.");
    const digest = hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", chosen.bytes)));
    note("Sign the logo in your wallet");
    const signature = await createWalletClient({ chain: longyu, transport: custom(provider()) }).signMessage({ account: from, message: logoMessage(token, L2_CHAIN_ID, digest) });
    note("Uploading the logo…");
    let answer: Response;
    try {
      answer = await fetch(logoUrl(cfg.apiUrl, token), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: toBase64(chosen.bytes), signature }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("The logo service did not answer. Try again.");
    }
    if (!answer.ok) throw new Error(logoErrorMessage(answer.status, await answer.json().catch(() => null)));
    logoChanged(token);
  }

  /** A file input and its drop zone: a checked logo, or the reason there is none. */
  function logoInput(fileInput: HTMLInputElement, drop: HTMLElement | null, use: (chosen: Logo | null, error: string) => void): void {
    const take = async (file: File | undefined) => {
      if (!file) return;
      try {
        use(await readLogo(file), "");
      } catch (e) {
        use(null, e instanceof Error ? e.message : "That image cannot be used.");
      }
    };
    fileInput.onchange = () => {
      void take(fileInput.files?.[0]);
      fileInput.value = "";
    };
    if (!drop) return;
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      if (!busy) void take(e.dataTransfer?.files?.[0]);
    });
  }

  // ---------------------------------------------------------------- launch

  /** Shows each field's problem under it. */
  function showProblems(problems: Partial<Record<Field, string>>, fields: Iterable<Field> = FIELDS): void {
    for (const field of fields) {
      $(`${field}-error`).textContent = problems[field] ?? "";
      input(field).setAttribute("aria-invalid", String(problems[field] !== undefined));
      $(`${field}-box`).classList.toggle("invalid", problems[field] !== undefined);
    }
  }
  const formNow = () => ({ name: input("name").value, symbol: input("symbol").value, supply: input("supply").value });

  async function launch(): Promise<void> {
    const checked = checkLaunch(formNow());
    for (const field of FIELDS) touched.add(field);
    if (!checked.ok) {
      showProblems(checked.problems);
      input(FIELDS.find((f) => checked.problems[f])!).focus();
      return;
    }
    if (!logo) {
      $("logo-error").textContent = LOGO_REQUIRED;
      $("logo-field").scrollIntoView({ block: "center" });
      $("logo").focus();
      return;
    }
    const { name, symbol, wholeTokens } = checked.launch;
    const from = await connect();
    await checkWiring();
    // The contract's own word on the name, in case its rule and the page's ever differ.
    const reserved = await l2.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "passesForLongyu", args: [name, symbol] }).catch(() => {
      throw new Error("Network busy. Try again.");
    });
    if (reserved) throw new Error(RESERVED);

    const data = encodeFunctionData({ abi: launcherAbi, functionName: "launch", args: [name, symbol, wholeTokens] });
    const request = { account: from, to: cfg.launcher, data, value: 0n };
    const [gas, price, dataFee, native] = await Promise.all([
      l2.estimateGas(request),
      l2.getGasPrice(),
      l2.estimateL1Fee({ ...request, chain: longyu }).catch(() => 0n),
      l2.getBalance({ address: from }),
    ]);
    if (native < gas * price + dataFee) throw new Error(`Not enough ${NATIVE} for gas.`);
    await ensureChain();
    setStatus(`Confirm the launch of ${symbol} in your wallet`);
    const hash = await createWalletClient({ chain: longyu, transport: custom(provider()) }).sendTransaction(request);
    setLink(hash);
    setStatus("Confirming on LONGYU…");
    const receipt = await l2.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction failed on LONGYU. Only gas was spent.");
    const token = launchedToken(receipt.logs, cfg.launcher, from);
    if (!token) throw new Error("Launched, but the receipt does not name the token. Check the transaction link.");
    made = { token, name, symbol, wholeTokens, logoSet: false };
    setStatus("");
    showDone();
    void loadRecent();
    // The token is made; the logo comes after, and failing it changes nothing on chain.
    if (logo && cfg.apiUrl) await setMadeLogo(from);
  }

  /** Signs and uploads the logo chosen for the token just launched; on failure the result offers it again. */
  async function setMadeLogo(from: Address): Promise<void> {
    if (!made || !logo) return;
    const note = (s: string) => {
      $("logo-status").textContent = s;
      show("logo-step", true);
      show("done-logo", false);
    };
    $("done-error").textContent = "";
    try {
      await uploadLogo(made.token, logo, from, note);
      made.logoSet = true;
      note("Logo set.");
      drawPreview();
      void loadRecent();
    } catch (e) {
      $("logo-status").textContent = "No logo yet.";
      show("done-logo", true);
      $("done-error").textContent = launchErrorMessage(e);
    }
  }

  function showDone(): void {
    if (!made) return;
    const links = tokenLinks(cfg, made.token);
    $("done-summary").textContent = `${formatWhole(made.wholeTokens)} ${made.symbol} are in your wallet.`;
    $("done-address").textContent = made.token;
    const explorer = $("done-explorer") as HTMLAnchorElement;
    if (links.explorer) explorer.href = links.explorer;
    show("done-explorer", links.explorer !== null);
    const add = $("done-add") as HTMLAnchorElement;
    if (links.addLiquidity) add.href = links.addLiquidity;
    show("done-add", links.addLiquidity !== null);
    // Without a logo chosen, the result offers to add one.
    $("logo-status").textContent = "No logo yet.";
    show("logo-step", cfg.apiUrl !== null);
    show("done-logo", true);
    show("pv-spec", false);
    show("done", true);
    document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("#form input, #form button").forEach((node) => (node.disabled = true));
    $("done-title").focus();
  }

  // ---------------------------------------------------------------- the form and its preview

  function drawPreview(): void {
    const form = formNow();
    const name = form.name.trim();
    const symbol = form.symbol.trim();
    $("pv-name").textContent = made?.name ?? (name || "Token name");
    $("pv-name").classList.toggle("ph", !made && !name);
    $("pv-symbol").textContent = made?.symbol ?? (symbol || "SYMBOL");
    $("pv-symbol").classList.toggle("ph", !made && !symbol);
    const supply = checkLaunch({ name: "x", symbol: "X", supply: form.supply });
    $("pv-supply").textContent = supply.ok ? `${formatWhole(supply.launch.wholeTokens)} ${symbol || "tokens"}` : "–";
    $("supply-unit").textContent = symbol;
    const shown = made ? made.symbol : symbol;
    if (made?.logoSet) drawArt($("pv-art"), { address: made.token, symbol: shown }, { size: 64, apiUrl: cfg.apiUrl });
    else drawArt($("pv-art"), { symbol: shown }, { size: 64, src: logo?.url ?? null });
  }

  function drawLogoField(error = ""): void {
    show("logo-field", cfg.apiUrl !== null);
    const slot = $("logo-slot");
    if (logo) drawArt(slot, { symbol: input("symbol").value }, { size: 44, src: logo.url });
    else if (!slot.querySelector("svg")) {
      slot.className = "art s44 blank";
      slot.replaceChildren(uploadIcon());
    }
    $("logo-title").textContent = logo ? logo.name : "Choose an image";
    $("logo-pick").textContent = logo ? "Change" : "Browse";
    $("logo-error").textContent = error;
  }
  const uploadIcon = () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14");
    svg.append(path);
    return svg;
  };

  function render(): void {
    show("connect", account === null);
    show("send", account !== null);
    drawPreview();
    const locked = made !== null;
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("#launch button, #launch input, #done button, #relogo button, #relogo input").forEach((node) => (node.disabled = busy));
    if (locked) document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("#form input, #form button").forEach((node) => (node.disabled = true));
    for (const id of ["send", "connect", "relogo-send"]) $(id).setAttribute("aria-busy", "false");
    if (busy) $(account ? (running === "relogo" ? "relogo-send" : made ? "done-logo" : "send") : "connect").setAttribute("aria-busy", "true");
  }

  function clear(): void {
    show("tx", false);
    setStatus("");
    $("error").textContent = "";
  }

  let running: "launch" | "relogo" | null = null;
  async function run(task: () => Promise<void>, errorAt = "error", kind: "launch" | "relogo" = "launch"): Promise<void> {
    if (busy) return;
    busy = true;
    running = kind;
    if (errorAt === "error") clear();
    $(errorAt).textContent = "";
    render();
    try {
      await task();
    } catch (e) {
      if (errorAt === "error") setStatus("");
      // Closing the wallet dialog is not an error.
      if (!closedByVisitor(e)) $(errorAt).textContent = launchErrorMessage(e);
    } finally {
      busy = false;
      running = null;
      render();
      void readBnb();
    }
  }

  for (const field of FIELDS) {
    input(field).oninput = () => {
      if (field === "supply") {
        const node = input("supply");
        const next = formatSupplyInput(node.value, node.selectionStart ?? node.value.length);
        if (next.value !== node.value) {
          node.value = next.value;
          node.setSelectionRange(next.caret, next.caret);
        }
      }
      // A field left once says what is wrong as it is typed; before that only on leaving it.
      const checked = checkLaunch(formNow());
      showProblems(checked.ok ? {} : checked.problems, [field].filter((f) => touched.has(f)));
      if (!touched.has(field)) showProblems({}, [field]);
      drawPreview();
      if (logo) drawLogoField();
    };
    input(field).onblur = () => {
      if (!input(field).value.trim() && !touched.has(field)) return;
      touched.add(field);
      const checked = checkLaunch(formNow());
      showProblems(checked.ok ? {} : checked.problems, [field]);
    };
  }
  logoInput($("logo") as HTMLInputElement, $("logo-drop"), (chosen, error) => {
    if (chosen) {
      if (logo) URL.revokeObjectURL(logo.url);
      logo = chosen;
    }
    drawLogoField(error);
    drawPreview();
  });
  ($("form") as HTMLFormElement).onsubmit = (e) => {
    e.preventDefault();
    void run(launch);
  };
  $("connect").onclick = () => run(async () => void (await connect()));
  $("done-watch").onclick = () =>
    run(async () => {
      if (!made) return;
      await provider().request({ method: "wallet_watchAsset", params: { type: "ERC20", options: { address: made.token, symbol: made.symbol, decimals: DECIMALS } } });
    }, "done-error");
  // "Add logo" uses the logo chosen before the launch, or asks for one.
  $("done-logo").onclick = () => {
    if (logo) return void run(async () => setMadeLogo(await connect()), "done-error");
    ($("done-logo-file") as HTMLInputElement).click();
  };
  logoInput($("done-logo-file") as HTMLInputElement, null, (chosen, error) => {
    if (!chosen) return void ($("done-error").textContent = error);
    if (logo) URL.revokeObjectURL(logo.url);
    logo = chosen;
    void run(async () => setMadeLogo(await connect()), "done-error");
  });
  $("done-copy").onclick = () => {
    if (!made) return;
    navigator.clipboard.writeText(made.token).then(
      () => ($("done-copy").textContent = "Copied"),
      () => ($("done-copy").textContent = "Copy failed"),
    );
    setTimeout(() => ($("done-copy").textContent = "Copy"), 2_000);
  };
  $("again").onclick = () => {
    made = null;
    touched.clear();
    for (const field of FIELDS) input(field).value = "";
    if (logo) URL.revokeObjectURL(logo.url);
    logo = null;
    showProblems({});
    clear();
    $("done-error").textContent = "";
    show("done", false);
    show("pv-spec", true);
    drawLogoField();
    render();
    input("name").focus();
  };

  // ---------------------------------------------------------------- a logo for a token launched before

  logoInput($("relogo-file") as HTMLInputElement, null, (chosen, error) => {
    if (chosen) {
      if (later) URL.revokeObjectURL(later.url);
      later = chosen;
    }
    $("relogo-name").textContent = later ? later.name : "Choose an image";
    if (later) drawArt($("relogo-art"), { symbol: "" }, { size: 24, src: later.url });
    $("relogo-error").textContent = error;
  });
  ($("relogo-form") as HTMLFormElement).onsubmit = (e) => {
    e.preventDefault();
    $("relogo-status").textContent = "";
    void run(
      async () => {
        const token = parseAddress(($("relogo-token") as HTMLInputElement).value);
        if (!token) throw new Error("Enter the token's address.");
        if (!later) throw new Error("Choose an image.");
        const chosen = later;
        const from = await connect();
        const note = (s: string) => ($("relogo-status").textContent = s);
        note("Checking the token…");
        // The page asks the chain first, so the wallet is never asked to sign for a token the API would refuse.
        const [launched, creator] = await Promise.all([
          l2.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "launched", args: [token] }),
          l2.readContract({ address: token, abi: creatorAbi, functionName: "creator" }).catch(() => null),
        ]).catch(() => Promise.reject(new Error("Network busy. Try again.")));
        if (!launched) throw new Error("That token was not made with LONGYU Launch.");
        if (!creator || !same(creator, from)) throw new Error("Only the account that launched the token can set its logo.");
        await uploadLogo(token, chosen, from, note);
        note("Logo set.");
        void loadRecent();
      },
      "relogo-error",
      "relogo",
    ).then(() => {
      if ($("relogo-error").textContent) $("relogo-status").textContent = "";
    });
  };

  // ---------------------------------------------------------------- recently launched

  async function loadRecent(): Promise<void> {
    try {
      const total = await l2.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "tokenCount" });
      const { start: first, count } = newestRange(total, RECENT_SHOWN);
      const addresses = count === 0n ? [] : await l2.readContract({ address: cfg.launcher, abi: launcherAbi, functionName: "tokensFrom", args: [first, count] });
      const calls = addresses.flatMap((address) =>
        (["name", "symbol", "decimals", "totalSupply"] as const).map((functionName) => ({ address, abi: erc20Abi, functionName })),
      );
      const reads = calls.length ? ((await l2.multicall({ allowFailure: true, contracts: calls })) as Read[]) : [];
      const rows: HTMLElement[] = [];
      addresses.forEach((raw, i) => {
        const address = getAddress(raw);
        const [name, symbol, decimals, supply] = reads.slice(i * 4, i * 4 + 4) as [Read, Read, Read, Read];
        const found = tokenFrom(address, { name, symbol, decimals, totalSupply: supply });
        if (!found.ok) return;
        rows.unshift(recentRow(found.token, supply.status === "success" ? (supply.result as bigint) : null));
      });
      $("recent-rows").replaceChildren(...rows);
      $("recent-count").textContent = total > 0n ? `${formatWhole(total)} ${total === 1n ? "token" : "tokens"}` : "";
      $("recent-note").textContent = rows.length ? "" : "None yet.";
    } catch (e) {
      console.warn("Launched tokens:", e);
      if (!$("recent-rows").children.length) $("recent-note").textContent = "Could not read the list.";
    }
  }

  function recentRow(t: { address: Address; name: string; symbol: string; decimals: number }, supply: bigint | null): HTMLElement {
    const tr = el("tr");
    const trade = tokenLinks(cfg, t.address).addLiquidity?.replace("&mode=add", "") ?? null;
    const who = el(trade ? "a" : "span", "who");
    if (who instanceof HTMLAnchorElement && trade) who.href = trade;
    const text = el("span", "who-text");
    text.append(el("span", "", t.symbol), el("span", "who-name", t.name));
    who.append(tokenArt(t, { size: 28, apiUrl: cfg.apiUrl }), text);
    const first = el("td");
    first.append(who);
    const href = scan(`token/${t.address}`);
    const address = el(href ? "a" : "span", "mono", shortHex(t.address));
    address.title = t.address;
    if (address instanceof HTMLAnchorElement && href) Object.assign(address, { href, target: "_blank", rel: "noopener noreferrer" });
    const last = el("td", "r");
    last.append(address);
    tr.append(first, el("td", "name hide-sm", t.name), el("td", "r num hide-sm", supply === null ? "–" : formatDisplay(supply, t.decimals)), last);
    return tr;
  }

  // ---------------------------------------------------------------- start

  const contract = $("pv-contract") as HTMLAnchorElement;
  const launcherHref = scan(`address/${cfg.launcher}`);
  if (launcherHref) contract.href = launcherHref;
  show("relogo", cfg.apiUrl !== null);

  // A wallet connected before is used again, and a change of account in it reaches the page.
  session.onChange(() => setAccount(session.account()));

  drawLogoField();
  render();
  void loadRecent();
  checkWiring().catch((e: unknown) => ($("error").textContent = launchErrorMessage(e)));
}
