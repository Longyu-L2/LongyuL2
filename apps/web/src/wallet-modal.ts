/**
 * The wallet the swap, launch and bridge pages use, and the dialog that picks it. No wallet library:
 * browser wallets announce themselves (EIP-6963), the visitor picks one, and the page then sends every
 * request, chain switches included, to that wallet's provider. A wallet that announces nothing but sits
 * at window.ethereum is listed as "Browser wallet". Without any wallet, a phone gets links that open
 * the page in a wallet app's browser, and a computer gets where to install one.
 *
 * What a wallet announces is untrusted: its name is set as text, and its icon is drawn only through
 * <img> from a data: URL (safeIcon in wallet-modal-core.ts).
 */
import { getAddress, type Address, type EIP1193Provider } from "viem";
import {
  ANNOUNCE_WAIT_MS,
  DISCONNECTED_KEY,
  INJECTED_ID,
  LAST_WALLET_KEY,
  WALLET_DOWNLOADS,
  connectErrorMessage,
  looksLikePhone,
  orderWallets,
  WALLET_ICON, walletAppLinks,
  walletEntry,
  type WalletEntry,
} from "./wallet-modal-core.ts";

type Provider = EIP1193Provider;
interface Found extends WalletEntry {
  provider: Provider;
}

/** Thrown when the visitor closes the dialog without connecting: the page shows nothing for it. */
export class WalletClosed extends Error {
  constructor() {
    super("The wallet dialog was closed.");
    this.name = "WalletClosed";
  }
}
export const closedByVisitor = (e: unknown) => e instanceof WalletClosed;

export interface Session {
  /** The chosen wallet's provider, or null before one is connected. */
  provider(): Provider | null;
  account(): Address | null;
  /** The chain the chosen wallet is on, when known. */
  chainId(): number | null;
  /** The account, connecting first: the chosen wallet is asked again, or the dialog opens. */
  connect(): Promise<Address>;
  /** Forgets the wallet on this page; the next connect opens the dialog. */
  disconnect(): void;
  /** Called with every change of account or chain. */
  onChange(listener: () => void): void;
}

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // private mode or blocked storage: remembered for this visit only
    }
  },
};

// ------------------------------------------------------------------ discovery (EIP-6963)

const found: Found[] = [];
window.addEventListener("eip6963:announceProvider", ((e: CustomEvent) => {
  const detail = e.detail as { info?: unknown; provider?: unknown } | undefined;
  const entry = walletEntry(detail?.info);
  const provider = detail?.provider as Provider | undefined;
  if (!entry || !provider || typeof provider.request !== "function") return;
  if (found.some((f) => f.id === entry.id)) return;
  found.push({ ...entry, provider });
  listeners.forEach((l) => l());
}) as EventListener);
const listeners = new Set<() => void>();
window.dispatchEvent(new Event("eip6963:requestProvider"));
const announced = new Promise<void>((r) => setTimeout(r, ANNOUNCE_WAIT_MS));

/** The wallets to list: the announced ones, else window.ethereum as "Browser wallet"; the last used first. */
function wallets(): Found[] {
  const list: Found[] = [...found];
  const injected = (window as { ethereum?: Provider }).ethereum;
  if (!list.length && injected && typeof injected.request === "function") list.push({ id: INJECTED_ID, name: "Browser wallet", icon: null, provider: injected });
  return orderWallets(list, store.get(LAST_WALLET_KEY));
}

// ------------------------------------------------------------------ the session

export function walletSession(): Session {
  let chosen: Found | null = null;
  let account: Address | null = null;
  let chain: number | null = null;
  const changes = new Set<() => void>();
  const changed = () => changes.forEach((l) => l());

  const onAccounts = (accounts: unknown) => {
    const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? getAddress(accounts[0]) : null;
    if (first === account) return;
    account = first;
    changed();
  };
  const onChain = (id: unknown) => {
    const next = typeof id === "string" || typeof id === "number" ? Number(id) : null;
    if (next === chain) return;
    chain = Number.isFinite(next) ? next : null;
    changed();
  };
  function use(next: Found): void {
    if (chosen && chosen.provider !== next.provider) {
      chosen.provider.removeListener?.("accountsChanged", onAccounts as never);
      chosen.provider.removeListener?.("chainChanged", onChain as never);
    }
    if (chosen?.provider !== next.provider) {
      next.provider.on?.("accountsChanged", onAccounts as never);
      next.provider.on?.("chainChanged", onChain as never);
    }
    chosen = next;
    next.provider.request({ method: "eth_chainId" }).then(onChain, () => undefined);
  }

  // A wallet connected on an earlier visit is used again without asking, unless the visitor disconnected.
  void announced.then(async () => {
    if (store.get(DISCONNECTED_KEY) === "1" || chosen) return;
    const list = wallets();
    const last = store.get(LAST_WALLET_KEY);
    const candidate = list.find((w) => w.id === last) ?? list.find((w) => w.id === INJECTED_ID) ?? (list.length === 1 ? list[0] : null);
    if (!candidate) return;
    try {
      const accounts = await candidate.provider.request({ method: "eth_accounts" });
      if (Array.isArray(accounts) && accounts.length && !chosen) {
        use(candidate);
        onAccounts(accounts);
      }
    } catch {
      // the wallet answers when asked to connect
    }
  });

  async function ask(w: Found): Promise<Address> {
    const accounts = await w.provider.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("No account selected in the wallet.");
    use(w);
    store.set(LAST_WALLET_KEY, w.id);
    store.set(DISCONNECTED_KEY, null);
    onAccounts(accounts);
    return account!;
  }

  return {
    provider: () => chosen?.provider ?? null,
    account: () => account,
    chainId: () => chain,
    async connect() {
      if (chosen && account) return ask(chosen);
      return openDialog(ask);
    },
    disconnect() {
      store.set(DISCONNECTED_KEY, "1");
      if (chosen) {
        chosen.provider.removeListener?.("accountsChanged", onAccounts as never);
        chosen.provider.removeListener?.("chainChanged", onChain as never);
      }
      chosen = null;
      account = null;
      chain = null;
      changed();
    },
    onChange(listener) {
      changes.add(listener);
    },
  };
}

// ------------------------------------------------------------------ the dialog

const SVG = "http://www.w3.org/2000/svg";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
function icon(d: string, size = 20): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
/** A wallet's tile: its own icon when it announced one the page can draw, else its initial. */
function tile(name: string, src: string | null): HTMLElement {
  const box = el("span", "wm-tile");
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.width = 32;
    img.height = 32;
    img.src = src;
    img.onerror = () => img.replaceWith(document.createTextNode([...name][0]?.toUpperCase() ?? "W"));
    box.append(img);
  } else box.textContent = [...name][0]?.toUpperCase() ?? "W";
  return box;
}

let dialog: HTMLDialogElement | null = null;
let pending: { resolve: (a: Address) => void; reject: (e: unknown) => void } | null = null;

function openDialog(ask: (w: Found) => Promise<Address>): Promise<Address> {
  if (pending) return Promise.reject(new WalletClosed());
  const opener = document.activeElement as HTMLElement | null;
  const d = (dialog ??= build());
  const list = d.querySelector<HTMLElement>(".wm-list")!;
  const wait = d.querySelector<HTMLElement>(".wm-wait")!;
  const empty = d.querySelector<HTMLElement>(".wm-empty")!;
  const error = d.querySelector<HTMLElement>(".wm-error")!;
  const foot = d.querySelector<HTMLElement>(".wm-foot")!;
  let busy = false;
  let run = 0;

  const draw = () => {
    if (busy) return;
    const all = wallets();
    const last = store.get(LAST_WALLET_KEY);
    wait.hidden = true;
    list.hidden = all.length === 0;
    empty.hidden = all.length > 0;
    foot.hidden = all.length > 0;
    list.replaceChildren(
      ...all.map((w) => {
        const row = el("button", "wm-row");
        row.type = "button";
        const note = w.id === last ? "Last used" : w.id === INJECTED_ID ? "" : "Detected";
        row.append(tile(w.name, w.icon), el("span", "wm-name", w.name), el("span", "wm-note", note));
        row.onclick = () => void pick(w);
        return row;
      }),
    );
    if (!all.length) drawEmpty(empty);
  };
  const pick = async (w: Found) => {
    const mine = ++run;
    busy = true;
    error.textContent = "";
    list.hidden = true;
    empty.hidden = true;
    wait.hidden = false;
    wait.querySelector(".wm-ring")!.replaceChildren(tile(w.name, w.icon));
    wait.querySelector(".wm-who")!.textContent = w.name;
    wait.querySelector<HTMLButtonElement>(".wm-back")!.focus();
    try {
      const address = await ask(w);
      if (mine !== run) return;
      busy = false;
      finish(() => pending?.resolve(address));
    } catch (e) {
      if (mine !== run) return;
      busy = false;
      draw();
      error.textContent = connectErrorMessage(e);
      list.querySelector<HTMLButtonElement>(".wm-row")?.focus();
    }
  };
  const back = () => {
    run++;
    busy = false;
    draw();
    list.querySelector<HTMLButtonElement>(".wm-row")?.focus();
  };
  const finish = (settle: () => void) => {
    settle();
    pending = null;
    listeners.delete(draw);
    d.classList.add("closing");
    const done = () => {
      d.classList.remove("closing");
      if (d.open) d.close();
      opener?.focus?.();
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
    else setTimeout(done, 150);
  };

  d.querySelector<HTMLButtonElement>(".wm-back")!.onclick = back;
  const close = () => {
    run++;
    busy = false;
    finish(() => pending?.reject(new WalletClosed()));
  };
  d.querySelector<HTMLButtonElement>(".wm-close")!.onclick = close;
  d.oncancel = (e) => {
    e.preventDefault();
    close();
  };
  d.onclick = (e) => {
    if (e.target === d) close();
  };

  error.textContent = "";
  listeners.add(draw);
  draw();
  d.showModal();
  (d.querySelector<HTMLButtonElement>(".wm-row, .wm-empty a") ?? d.querySelector<HTMLButtonElement>(".wm-close"))!.focus();
  // A wallet that announces late is added as it comes.
  void announced.then(draw);
  return new Promise<Address>((resolve, reject) => (pending = { resolve, reject }));
}

/** No wallet here: a phone opens the page in a wallet app; a computer installs one. */
function drawEmpty(box: HTMLElement): void {
  const phone = looksLikePhone(navigator.userAgent) || matchMedia("(pointer: coarse)").matches;
  const rows = (phone ? walletAppLinks(location.href) : WALLET_DOWNLOADS).map(({ name, href }) => {
    const a = el("a", "wm-row");
    a.href = href;
    a.rel = "noopener noreferrer";
    if (!phone) a.target = "_blank";
    a.append(tile(name, WALLET_ICON[name]), el("span", "wm-name", name), el("span", "wm-note", phone ? "Open" : "Install"));
    a.lastElementChild!.append(icon("M7 13 13 7M8 7h5v5", 14));
    return a;
  });
  box.replaceChildren(el("p", "wm-lead", phone ? "Open this page in your wallet app" : "No wallet found in this browser. Install one, then reload."), el("div", "wm-rows"));
  box.lastElementChild!.replaceChildren(...rows);
}

function build(): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "wm";
  d.setAttribute("role", "dialog");
  d.setAttribute("aria-modal", "true");
  d.setAttribute("aria-labelledby", "wm-title");

  const grab = el("div", "wm-grab");
  grab.setAttribute("aria-hidden", "true");
  const head = el("div", "wm-head");
  const mark = document.createElement("img");
  mark.src = "./mark.svg";
  mark.alt = "";
  mark.width = 19;
  mark.height = 24;
  const title = el("h2", "", "Connect a wallet");
  title.id = "wm-title";
  const close = el("button", "icon-btn wm-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.append(icon("m5 5 10 10M15 5 5 15"));
  head.append(mark, title, close);

  const body = el("div", "wm-body");
  const list = el("div", "wm-list");
  const wait = el("div", "wm-wait");
  wait.hidden = true;
  wait.setAttribute("role", "status");
  const ring = el("div", "wm-ring");
  const back = el("button", "text-btn wm-back", "Back");
  back.type = "button";
  wait.append(ring, el("p", "wm-check", "Check your wallet…"), el("p", "wm-who"), back);
  const empty = el("div", "wm-empty");
  empty.hidden = true;
  const error = el("p", "wm-error error");
  error.setAttribute("role", "alert");
  body.append(list, wait, empty, error);

  const foot = el("p", "wm-foot");
  foot.hidden = true;
  const get = el("a", "", "Get MetaMask");
  get.href = WALLET_DOWNLOADS[0].href;
  get.target = "_blank";
  get.rel = "noopener noreferrer";
  foot.append("New to wallets? ", get);

  d.append(grab, head, body, foot);
  document.body.append(d);
  return d;
}
