import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANNOUNCE_WAIT_MS,
  INJECTED_ID,
  MAX_ICON_LENGTH,
  MAX_WALLET_NAME,
  PENDING,
  WALLET_DOWNLOADS,
  WALLET_ICON,
  accountLinks,
  connectErrorMessage,
  looksLikePhone,
  orderWallets,
  safeIcon,
  walletAppLinks,
  walletEntry,
  walletName,
} from "./wallet-modal-core.ts";

const svg = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

test("icons: only data: images of the four kinds, and not too large", () => {
  assert.equal(safeIcon(svg), svg);
  for (const ok of ["data:image/png;base64,AAAA", "data:image/webp;base64,AAAA", "data:image/jpeg;base64,AAAA", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E", "data:image/svg+xml;charset=utf-8,%3Csvg/%3E"]) assert.equal(safeIcon(ok), ok, ok);
  for (const bad of [
    "https://wallet.example/icon.png",
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/gif;base64,R0lGOD",
    "data:image/svg+xml",
    " data:image/png;base64,AAAA",
    "<svg onload=alert(1)>",
    null,
    42,
    { toString: () => svg },
  ]) assert.equal(safeIcon(bad), null, String(bad));
  assert.equal(safeIcon(`data:image/png;base64,${"A".repeat(MAX_ICON_LENGTH)}`), null);
});

test("names: cleaned, cut, never empty", () => {
  assert.equal(walletName("  Demo   Wallet "), "Demo Wallet");
  assert.equal(walletName("Demo‮tellaW"), "DemotellaW");
  assert.equal(walletName("x".repeat(80)).length, MAX_WALLET_NAME);
  assert.ok(walletName("x".repeat(80)).endsWith("…"));
  assert.equal(walletName(7), "");
});

test("announcements: an entry needs an rdns and a name; the icon is optional", () => {
  assert.deepEqual(walletEntry({ uuid: "1", name: "Demo Wallet", icon: svg, rdns: "network.longyu.Demo" }), { id: "network.longyu.demo", name: "Demo Wallet", icon: svg });
  assert.deepEqual(walletEntry({ name: "Demo", icon: "https://x/icon.png", rdns: "io.demo" }), { id: "io.demo", name: "Demo", icon: null });
  for (const bad of [null, "x", {}, { name: "Demo" }, { rdns: "io.demo" }, { name: " ", rdns: "io.demo" }, { name: "Demo", rdns: "demo" }, { name: "Demo", rdns: "io.demo/../x" }, { name: "Demo", rdns: `io.${"a".repeat(120)}` }]) {
    assert.equal(walletEntry(bad), null, JSON.stringify(bad));
  }
});

test("order: each wallet once, the first announcement winning, the last used first", () => {
  const a = { id: "io.a", n: 1 }, b = { id: "io.b", n: 2 }, c = { id: "io.c", n: 3 }, b2 = { id: "io.b", n: 4 };
  assert.deepEqual(orderWallets([a, b, b2, c], null), [a, b, c]);
  assert.deepEqual(orderWallets([a, b, c], "io.c"), [c, a, b]);
  assert.deepEqual(orderWallets([a, b, c], "io.a"), [a, b, c]);
  assert.deepEqual(orderWallets([a, b, c], "io.gone"), [a, b, c]);
  assert.deepEqual(orderWallets([], "io.a"), []);
  assert.equal(INJECTED_ID, "injected");
  assert.ok(ANNOUNCE_WAIT_MS >= 200 && ANNOUNCE_WAIT_MS <= 500);
});

test("phones: links that open the page in a wallet app, made from its address", () => {
  const links = walletAppLinks("https://dex.longyu.network/launch?token=0xAbC&mode=add#top");
  assert.deepEqual(links.map((l) => l.name), ["MetaMask", "Trust Wallet", "Coinbase Wallet", "OKX Wallet"]);
  const full = encodeURIComponent("https://dex.longyu.network/launch?token=0xAbC&mode=add");
  assert.deepEqual(links.map((l) => l.href), [
    "https://metamask.app.link/dapp/dex.longyu.network/launch?token=0xAbC&mode=add",
    `https://link.trustwallet.com/open_url?coin_id=20000714&url=${full}`,
    `https://go.cb-w.com/dapp?cb_url=${full}`,
    `okx://wallet/dapp/url?dappUrl=${full}`,
  ]);
  assert.equal(walletAppLinks("https://app.longyu.network/")[0]!.href, "https://metamask.app.link/dapp/app.longyu.network/");
  assert.ok(looksLikePhone("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"));
  assert.ok(looksLikePhone("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"));
  assert.ok(!looksLikePhone("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120"));
  for (const d of WALLET_DOWNLOADS) assert.match(d.href, /^https:\/\//);
});

test("errors: a refusal and a request already open, in one plain line", () => {
  assert.equal(connectErrorMessage({ code: 4001, message: "User rejected the request." }), "Cancelled in your wallet.");
  assert.equal(connectErrorMessage({ code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" }), PENDING);
  assert.equal(connectErrorMessage({ message: "outer", cause: { code: -32002 } }), PENDING);
  assert.equal(connectErrorMessage(new Error("No account selected in the wallet.")), "No account selected in the wallet.");
  assert.deepEqual(accountLinks("https://scan.longyu.network/", "0xab"), { explorer: "https://scan.longyu.network/address/0xab" });
  assert.deepEqual(accountLinks(null, "0xab"), { explorer: null });
});

test("every wallet the dialog links to has its own icon, shipped with the pages", async () => {
  const { existsSync } = await import("node:fs");
  const { WALLET_ICONS } = await import("../build.mjs");
  for (const { name } of [...walletAppLinks("https://dex.longyu.network/"), ...WALLET_DOWNLOADS]) {
    const icon = WALLET_ICON[name];
    assert.match(icon, /^\/wallet-[a-z]+\.(png|svg)$/, name);
    assert.ok(WALLET_ICONS.includes(icon.slice(1)), name);
    assert.ok(existsSync(new URL(`.${icon}`, import.meta.url)), name);
  }
});
