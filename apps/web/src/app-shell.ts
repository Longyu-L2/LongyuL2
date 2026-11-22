/**
 * What the swap, launch and bridge pages share in the browser: the bar (its phone menu and its wallet
 * button) and the round token art (a logo when LONGYU's API has one, else a monogram).
 */
import { shortHex } from "./bridge-core.ts";
import { MONOGRAM_TINTS, logoUrl, monogram } from "./swap-core.ts";
import type { Session } from "./wallet-modal.ts";

const byId = (id: string) => document.getElementById(id);

export interface Shell {
  /** The account's BNB on LONGYU as text ("0.42 BNB"), or null when not known. */
  balance(text: string | null): void;
}

export interface ShellOptions {
  /** The page's wallet; without one (a page that is closed) the bar has no wallet button. */
  session?: Session;
  /** What the wallet button does before a wallet is connected: the page's own connect. */
  connect?: () => void;
  /** For the connected wallet's menu: its page on the explorer, and a switch to LONGYU when the wallet is elsewhere. */
  explorerUrl?: string | null;
  chainId?: number;
  switchChain?: () => Promise<void>;
}

/** The bar: its phone menu, and the wallet button with the connected wallet's menu. */
export function appShell(opts: ShellOptions = {}): Shell {
  const bar = byId("bar");
  const toggle = byId("menu-button") as HTMLButtonElement | null;
  const menu = byId("menu");
  if (bar && toggle && menu) {
    const setMenu = (open: boolean) => {
      bar.classList.toggle("open", open);
      document.documentElement.classList.toggle("menu-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close the menu" : "Open the menu");
    };
    toggle.hidden = false;
    toggle.addEventListener("click", () => setMenu(!bar.classList.contains("open")));
    menu.addEventListener("click", (e) => {
      if ((e.target as Element).closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !bar.classList.contains("open")) return;
      setMenu(false);
      toggle.focus();
    });
    window.matchMedia("(min-width: 720px)").addEventListener("change", (e) => e.matches && setMenu(false));
  }

  // The wallet button: "Connect wallet", then the account and its BNB, which opens a small menu.
  const button = byId("wallet") as HTMLButtonElement | null;
  const session = opts.session ?? null;
  if (button && !session) button.hidden = true;
  let bnb: string | null = null;
  const current = () => session?.account() ?? null;
  const draw = () => {
    if (!button) return;
    const who = current();
    button.classList.toggle("connected", who !== null);
    if (!who) {
      button.textContent = "Connect wallet";
      button.removeAttribute("title");
      button.removeAttribute("aria-haspopup");
      button.removeAttribute("aria-expanded");
      setWalletMenu(false);
      return;
    }
    const short = document.createElement("span");
    short.className = "mono";
    short.textContent = shortHex(who);
    const parts: HTMLElement[] = [short];
    if (bnb) {
      const held = document.createElement("span");
      held.className = "w-bal";
      held.textContent = bnb;
      parts.push(held);
    }
    button.replaceChildren(...parts);
    button.title = who;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", String(menuOpen));
  };

  // The connected wallet's menu: copy the address, see it on the explorer, switch to LONGYU, disconnect.
  let menuOpen = false;
  let walletMenu: HTMLElement | null = null;
  function setWalletMenu(open: boolean): void {
    menuOpen = open && current() !== null;
    if (menuOpen) buildMenu();
    if (walletMenu) walletMenu.hidden = !menuOpen;
    button?.setAttribute("aria-expanded", String(menuOpen));
  }
  function item(tag: "a" | "button", text: string, d: string, quiet = false): HTMLElement {
    const node = document.createElement(tag);
    node.className = `menu-item${quiet ? " quiet" : ""}`;
    node.setAttribute("role", "menuitem");
    if (node instanceof HTMLButtonElement) node.type = "button";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    node.append(svg, text);
    return node;
  }
  function buildMenu(): void {
    const who = current();
    if (!button || !session || !who) return;
    if (!walletMenu) {
      walletMenu = document.createElement("div");
      walletMenu.className = "pop wallet-menu";
      walletMenu.setAttribute("role", "menu");
      walletMenu.setAttribute("aria-label", "Wallet");
      walletMenu.hidden = true;
      button.after(walletMenu);
      document.addEventListener("click", (e) => {
        if (menuOpen && !(e.target as Element).closest(".wallet, .wallet-menu")) setWalletMenu(false);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !menuOpen) return;
        setWalletMenu(false);
        button.focus();
      });
    }
    const head = document.createElement("div");
    head.className = "wm-acct";
    const title = document.createElement("b");
    title.textContent = bnb ?? "Connected";
    const full = document.createElement("span");
    full.className = "mono";
    full.textContent = who;
    head.append(title, full);
    const copy = item("button", "Copy address", "M5.5 5.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z");
    copy.onclick = () => {
      void navigator.clipboard?.writeText(who).then(
        () => (copy.lastChild!.textContent = "Copied"),
        () => (copy.lastChild!.textContent = "Not copied"),
      );
      setTimeout(() => setWalletMenu(false), 700);
    };
    const items: HTMLElement[] = [head, copy];
    if (opts.explorerUrl) {
      const scan = item("a", "View on explorer", "M6 10 13 3M8.5 3H13v4.5M11 9.5V13H3V5h3.5") as HTMLAnchorElement;
      scan.href = `${opts.explorerUrl}/address/${who}`;
      scan.target = "_blank";
      scan.rel = "noopener noreferrer";
      items.push(scan);
    }
    const chain = session.chainId();
    if (opts.switchChain && chain !== null && chain !== opts.chainId) {
      const sw = item("button", "Switch to LONGYU", "M3 6h9.5L10 3.5M13 10H3.5L6 12.5");
      sw.onclick = () => {
        setWalletMenu(false);
        void opts.switchChain!().catch(() => undefined);
      };
      items.push(sw);
    }
    const out = item("button", "Disconnect", "M10 11.5 13 8l-3-3.5M13 8H6M7.5 13H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.5", true);
    out.onclick = () => {
      setWalletMenu(false);
      session.disconnect();
      button.focus();
    };
    items.push(out);
    walletMenu!.replaceChildren(...items);
  }

  button?.addEventListener("click", () => {
    if (current()) {
      setWalletMenu(!menuOpen);
      if (menuOpen) walletMenu?.querySelector<HTMLElement>(".menu-item")?.focus();
      return;
    }
    opts.connect?.();
  });
  let shownFor: string | null = current();
  session?.onChange(() => {
    if (current() !== shownFor) {
      shownFor = current();
      bnb = null;
    }
    draw();
    if (menuOpen) buildMenu();
  });
  const shell: Shell = {
    balance(text) {
      if (text === bnb) return;
      bnb = text;
      draw();
    },
  };
  draw();
  return shell;
}

// ------------------------------------------------------------------ token art

/** Logos asked for so far: whether each loaded. A token's logo is fetched once a visit, until it changes. */
const logos = new Map<string, Promise<boolean>>();
const versions = new Map<string, number>();

function loads(src: string): Promise<boolean> {
  let known = logos.get(src);
  if (!known) {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    known = new Promise<boolean>((resolve) => {
      img.onload = () => resolve(img.naturalWidth > 0);
      img.onerror = () => resolve(false);
    });
    img.src = src;
    logos.set(src, known);
  }
  return known;
}

/** After a logo is set: the next art drawn for the token asks for the new one. */
export function logoChanged(token: string): void {
  versions.set(token.toLowerCase(), Date.now());
}

export interface ArtOptions {
  /** Pixel size class: 20, 24, 28 (default), 32, 36, 40, 44 or 64. */
  size?: number;
  /** LONGYU's own token: drawn with the brand mark. */
  official?: boolean;
  /** BNB (and wrapped BNB): BNB's own logo. */
  native?: boolean;
  /** LONGYU's API, for logos; null draws the monogram only. */
  apiUrl?: string | null;
  /** A picture to show at once (a logo being chosen), in place of any other. */
  src?: string | null;
}

/**
 * A token's round slot, always the same size: the monogram at once, and the logo over it once it has
 * loaded, so nothing moves and no broken image shows.
 */
export function tokenArt(token: { address?: string | null; symbol: string }, opts: ArtOptions = {}): HTMLElement {
  const slot = document.createElement("span");
  drawArt(slot, token, opts);
  return slot;
}

/** Draws a token into an existing slot (the preview's, which changes as the visitor types). */
export function drawArt(slot: HTMLElement, token: { address?: string | null; symbol: string }, opts: ArtOptions = {}): void {
  slot.className = `art${opts.size && opts.size !== 28 ? ` s${opts.size}` : ""}`;
  slot.setAttribute("aria-hidden", "true");
  delete slot.dataset.for;
  slot.style.removeProperty("--art-bg");
  slot.style.removeProperty("--art-fg");
  slot.replaceChildren();
  const picture = (src: string) => {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = src;
    return img;
  };
  if (opts.official) {
    slot.classList.add("official");
    slot.append(picture("./mark.svg"));
    return;
  }
  if (opts.native) {
    slot.classList.add("native");
    slot.textContent = "B";
    slot.append(picture("./bnb.png"));
    return;
  }
  const { letters, tint } = monogram(token.symbol);
  const [bg, fg] = MONOGRAM_TINTS[tint]!;
  if (!token.symbol.trim() && !opts.src) slot.classList.add("blank");
  else {
    slot.style.setProperty("--art-bg", bg);
    slot.style.setProperty("--art-fg", fg);
  }
  slot.textContent = token.symbol.trim() ? letters : "";
  if (opts.src) return void slot.append(picture(opts.src));
  const address = token.address;
  if (!opts.apiUrl || !address) return;
  const src = logoUrl(opts.apiUrl, address, versions.get(address.toLowerCase()));
  void loads(src).then((ok) => {
    // Drawn again for something else meanwhile: leave it.
    if (ok && slot.dataset.for === src) slot.append(picture(src));
  });
  slot.dataset.for = src;
}
