/**
 * Pure helpers for the wallet dialog the swap, launch and bridge pages share (wallet-modal.ts; tested
 * under Node): which announced browser wallets to list and how, the links that open a page inside a
 * phone wallet's own browser, and the plain line for a refused or pending request.
 *
 * Browser wallets announce themselves with EIP-6963 events: a name, an icon, a reverse-DNS id (rdns)
 * and the provider. What they announce is untrusted: names are cleaned and cut, and an icon is kept
 * only as a data: image the page draws with <img>, never as markup.
 */
import { CANCELLED, errorMessage } from "./wallet-core.ts";

/** An icon larger than this is not drawn. */
export const MAX_ICON_LENGTH = 200_000;
export const MAX_WALLET_NAME = 32;
/** How long the dialog waits for announcements before it falls back to window.ethereum. */
export const ANNOUNCE_WAIT_MS = 300;
/** Where the last wallet used is remembered (its rdns), and that the visitor disconnected. */
export const LAST_WALLET_KEY = "longyu.wallet.last.v1";
export const DISCONNECTED_KEY = "longyu.wallet.disconnected.v1";
/** The id of the entry for a lone window.ethereum that announced nothing. */
export const INJECTED_ID = "injected";

export interface WalletEntry {
  /** The rdns, or INJECTED_ID. */
  id: string;
  name: string;
  /** A data: image URL, or null to draw a plain mark. */
  icon: string | null;
}

/** An announced icon the page may draw: a data: PNG, JPEG, WebP or SVG image of reasonable size. */
export function safeIcon(icon: unknown): string | null {
  if (typeof icon !== "string" || icon.length > MAX_ICON_LENGTH) return null;
  return /^data:image\/(svg\+xml|png|webp|jpeg)(;[a-z0-9=;+-]*)?,/i.test(icon) ? icon : null;
}

/** A wallet's name fit to show: controls and direction marks removed, spaces collapsed, cut. */
export function walletName(name: unknown): string {
  if (typeof name !== "string") return "";
  const clean = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > MAX_WALLET_NAME ? `${chars.slice(0, MAX_WALLET_NAME - 1).join("")}…` : clean;
}

/** An EIP-6963 announcement's info as an entry, or null when it is not one the page can list. */
export function walletEntry(info: unknown): WalletEntry | null {
  if (!info || typeof info !== "object") return null;
  const i = info as { rdns?: unknown; name?: unknown; icon?: unknown };
  const rdns = typeof i.rdns === "string" ? i.rdns.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(rdns) || rdns.length > 100) return null;
  const name = walletName(i.name);
  if (!name) return null;
  return { id: rdns, name, icon: safeIcon(i.icon) };
}

/** The entries to list: each wallet once (the first announcement wins), the one used last first. */
export function orderWallets<T extends { id: string }>(entries: readonly T[], last: string | null): T[] {
  const seen = new Set<string>();
  const once = entries.filter((e) => !seen.has(e.id) && seen.add(e.id));
  const at = last ? once.findIndex((e) => e.id === last) : -1;
  return at > 0 ? [once[at]!, ...once.slice(0, at), ...once.slice(at + 1)] : once;
}

/** Whether the browser reads as a phone's or a tablet's. */
export function looksLikePhone(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(userAgent);
}

/** The wallets' own icons, served with the pages (WALLET_ICONS in build.mjs and server.mjs). */
export const WALLET_ICON = {
  MetaMask: "/wallet-metamask.png",
  "Trust Wallet": "/wallet-trust.svg",
  "Coinbase Wallet": "/wallet-coinbase.png",
  "OKX Wallet": "/wallet-okx.png",
  Rabby: "/wallet-rabby.png",
} as const;

/** Links that open this page inside a phone wallet's own browser, made from the page's address. */
export function walletAppLinks(href: string): { name: keyof typeof WALLET_ICON; href: string }[] {
  const url = new URL(href);
  url.hash = "";
  const full = url.toString();
  const bare = full.replace(/^https?:\/\//, "");
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=20000714&url=${encodeURIComponent(full)}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(full)}` },
    { name: "OKX Wallet", href: `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(full)}` },
  ];
}

/** Where to get a browser wallet, for a computer that has none. */
export const WALLET_DOWNLOADS = [
  { name: "MetaMask", href: "https://metamask.io/download/" },
  { name: "Rabby", href: "https://rabby.io/" },
  { name: "Coinbase Wallet", href: "https://www.coinbase.com/wallet/downloads" },
] as const;

export const PENDING = "A request is already open in your wallet. Check it there.";

/** One plain line for a connection that did not go through. */
export function connectErrorMessage(e: unknown): string {
  let cur = e as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    if (cur.code === -32002) return PENDING;
    cur = cur.cause as typeof cur;
  }
  const message = errorMessage(e);
  return message === CANCELLED ? "Cancelled in your wallet." : message;
}

/** The short address and its explorer page, for the connected wallet's menu. */
export function accountLinks(explorerUrl: string | null, account: string): { explorer: string | null } {
  return { explorer: explorerUrl ? `${explorerUrl.replace(/\/+$/, "")}/address/${account}` : null };
}
