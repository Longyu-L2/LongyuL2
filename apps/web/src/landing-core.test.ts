import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error a plain JavaScript module without type declarations
import { landingPage, publishedPage } from "../build.mjs";
import { blockNumberOf, formatCount, nextShown, parseLandingConfig, walletChain } from "./landing-core.ts";

const config = { rpcUrl: "https://rpc-testnet.longyu.network", chainId: "668801", chainName: "LONGYU Testnet", explorerUrl: "https://scan-testnet.longyu.network", symbol: "tBNB" };

test("landing: the settings are taken only when every one is usable", () => {
  assert.deepEqual(parseLandingConfig(config), config);
  assert.deepEqual(parseLandingConfig({ ...config, rpcUrl: "http://localhost:8545", chainName: " LONGYU Testnet " }), { ...config, rpcUrl: "http://localhost:8545" });
  for (const bad of [
    null, "x", {},
    { ...config, rpcUrl: "" },
    { ...config, rpcUrl: "http://rpc-testnet.longyu.network" },
    { ...config, rpcUrl: "https://user:pass@rpc-testnet.longyu.network" },
    { ...config, rpcUrl: "javascript:alert(1)" },
    { ...config, explorerUrl: "scan-testnet.longyu.network" },
    { ...config, chainId: 668801 },
    { ...config, chainId: "0" },
    { ...config, chainId: "0x1" },
    { ...config, chainName: " " },
    { ...config, symbol: "t BNB" },
  ]) assert.equal(parseLandingConfig(bad), null, JSON.stringify(bad));
});

test("landing: the wallet is given the network as EIP-3085 has it", () => {
  assert.deepEqual(walletChain(config), {
    chainId: "0xa3481",
    chainName: "LONGYU Testnet",
    nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: ["https://rpc-testnet.longyu.network"],
    blockExplorerUrls: ["https://scan-testnet.longyu.network"],
  });
  assert.equal(Number.parseInt(walletChain(config).chainId, 16), 668801);
});

test("landing: a block height is read only from a node's answer", () => {
  assert.equal(blockNumberOf({ jsonrpc: "2.0", id: 1, result: "0x10" }), 16);
  assert.equal(blockNumberOf({ result: "0x0" }), 0);
  assert.equal(blockNumberOf({ result: "0x1A2b3C" }), 0x1a2b3c);
  for (const bad of [null, "0x10", {}, { result: 16 }, { result: "16" }, { result: "0x" }, { result: "0x010" }, { result: "0xffffffffffffffffffff" }, { error: { code: -32005 } }]) {
    assert.equal(blockNumberOf(bad), null, JSON.stringify(bad));
  }
});

test("landing: counts are grouped in threes", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1,000");
  assert.equal(formatCount(12345678), "12,345,678");
  assert.equal(formatCount(-1), "–");
  assert.equal(formatCount(1.5), "–");
});

test("landing: the counter runs up to the latest block and never past it", () => {
  assert.equal(nextShown(100, 100), 100);
  assert.equal(nextShown(100, 101), 101);
  assert.equal(nextShown(100, 104), 101);
  assert.equal(nextShown(100, 160), 110);
  // A node behind the last answer: the counter shows what the node says.
  assert.equal(nextShown(100, 90), 90);
  let shown = 0;
  let steps = 0;
  while (shown < 5000 && steps < 200) {
    const next = nextShown(shown, 5000);
    assert.ok(next > shown && next <= 5000);
    shown = next;
    steps++;
  }
  assert.equal(shown, 5000);
});

const live = {
  SITE_URL: "https://longyu.network", APP_URL: "https://testnet.longyu.network", MINE_URL: "https://mine-testnet.longyu.network",
  EXPLORER_URL: "https://scan-testnet.longyu.network", L2_RPC_URL: "https://rpc-testnet.longyu.network", CHAIN_ID: "668801",
};
const source = readFileSync(new URL("./landing.html", import.meta.url), "utf8");

test("landing: the page is built only when every address it links to is set", () => {
  for (const name of Object.keys(live)) {
    assert.equal(landingPage(source, { ...live, [name]: "" }), null, name);
    assert.equal(landingPage(source, { ...live, [name]: "  " }), null, name);
  }
  const built: string = landingPage(source, live);
  assert.ok(!built.includes("{{") && !built.includes("data-optional"));
  assert.ok(built.includes('<link rel="canonical" href="https://longyu.network/" />'));
  assert.ok(built.includes('content="https://longyu.network/share.png"'));
  assert.ok(built.includes('href="https://mine-testnet.longyu.network/download/android"'));
  assert.ok(built.includes('href="https://testnet.longyu.network/bridge.html"') && built.includes('href="https://testnet.longyu.network/swap.html"'));
  assert.ok(["https://rpc-testnet.longyu.network", "668801", "tBNB", "LONGYU Testnet", "https://scan-testnet.longyu.network"].every((value) => built.includes(`<dd><span>${value}</span><button type="button" data-copy="${value}"`)));
  // Every link leaves for one of the build's addresses or stays on the page.
  const sites = [live.APP_URL, live.MINE_URL, live.EXPLORER_URL];
  for (const [, href] of built.matchAll(/<a [^>]*href="([^"]+)"/g)) assert.ok(href === "./" || href === "#build" || sites.some((s) => href!.startsWith(`${s}/`)), href);
  // Its one script is the bundled file, so the policy's script-src 'self' is all it needs.
  assert.deepEqual([...built.matchAll(/<script[^>]*>/g)].map((m) => m[0]), ['<script type="module" src="./landing.js">']);
  assert.ok(!/ on[a-z]+="/.test(built));
  // The script finds every element it writes to.
  const script = readFileSync(new URL("./landing.ts", import.meta.url), "utf8");
  for (const [, id] of script.matchAll(/\$\("([a-z-]+)"\)/g)) assert.ok(built.includes(` id="${id}"`), id);
});

test("landing: a link that is not set leaves no trace, and one that is set shows everywhere it belongs", () => {
  const without: string = landingPage(source, live);
  assert.ok(!without.includes("GitHub") && !without.includes(">X<"));
  const withLinks: string = landingPage(source, { ...live, GITHUB_URL: "https://github.com/Longyu-L2/LongyuL2", X_URL: "https://x.com/longyu" });
  assert.equal(withLinks.split('href="https://github.com/Longyu-L2/LongyuL2" rel="noopener">GitHub</a>').length - 1, 3);
  assert.equal(withLinks.split('<a href="https://x.com/longyu" rel="noopener">X</a>').length - 1, 1);
  assert.ok(!withLinks.includes("data-optional"));
  // Nothing else differs between the two.
  const lines = new Set(without.split("\n"));
  assert.equal(withLinks.split("\n").filter((line) => !lines.has(line)).length, 4);
});

test("landing: a setting the page cannot use stops the build", () => {
  assert.throws(() => landingPage(source, { ...live, SITE_URL: "https://longyu.network/" }), /SITE_URL must be an https address with no path/);
  assert.throws(() => landingPage(source, { ...live, APP_URL: "http://testnet.longyu.network" }), /APP_URL must be an https address/);
  assert.throws(() => landingPage(source, { ...live, MINE_URL: "https://mine-testnet.longyu.network/app" }), /MINE_URL must be an https address with no path/);
  assert.throws(() => landingPage(source, { ...live, EXPLORER_URL: "https://user:pass@scan-testnet.longyu.network" }), /EXPLORER_URL must not carry a name and password/);
  assert.throws(() => landingPage(source, { ...live, L2_RPC_URL: "http://rpc-testnet.longyu.network" }), /L2_RPC_URL must be an https address/);
  assert.throws(() => landingPage(source, { ...live, CHAIN_ID: "0x1" }), /CHAIN_ID must be a whole number/);
  assert.throws(() => landingPage(source, { ...live, GITHUB_URL: "javascript:alert(1)" }), /GITHUB_URL must be an https address/);
  assert.throws(() => landingPage(source, { ...live, X_URL: "x.com/longyu" }), /X_URL must be an https address/);
  assert.throws(() => landingPage("<p>{{OTHER}}</p>", live), /no value for OTHER/);
  assert.throws(() => landingPage('<a href="{{MINE_URL}}" data-optional="MINE_URL">x</a>', live), /MINE_URL is not an optional link/);
  // A value is written as text, whatever it holds.
  const named: string = landingPage(source, { ...live, CHAIN_NAME: 'A<b>"&\'' });
  assert.ok(named.includes("<dd><span>A&#60;b&#62;&#34;&#38;&#39;</span>") && !named.includes("A<b>"));
});

test("landing: the published page may send requests to the chain's RPC address and nowhere else", () => {
  const out: string = publishedPage("landing.html", landingPage(source, live), live);
  assert.ok(out.includes("default-src 'self'; connect-src https://rpc-testnet.longyu.network; style-src 'self' 'unsafe-inline';"));
  assert.ok(!out.includes("connect-src https:;") && !out.includes("localhost"));
  const local: string = publishedPage("landing.html", landingPage(source, { ...live, L2_RPC_URL: "http://localhost:8545" }), { L2_RPC_URL: "http://localhost:8545" });
  assert.ok(local.includes("connect-src http://localhost:*;"));
});

test("landing: the page's own words", () => {
  // The mining page promises no rate and no price, and neither does this one.
  assert.ok(!/1:1|guarantee|profit|\bearn\b/i.test(source));
  assert.ok(source.includes("tLONG on testnet has no monetary value."));
  assert.ok(!source.includes("\u2014"));
});
