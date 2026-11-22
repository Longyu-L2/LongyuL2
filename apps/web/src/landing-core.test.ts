import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error a plain JavaScript module without type declarations
import { landingPage, PROFILES, publishedPage } from "../build.mjs";
import { getAddress } from "viem";
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
const scriptOf = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

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
  for (const [, href] of built.matchAll(/<a [^>]*href="([^"]+)"/g)) assert.ok(["./", "./developers", "#build"].includes(href!) || sites.some((s) => href!.startsWith(`${s}/`)), href);
  // Its one script is the bundled file, so the policy's script-src 'self' is all it needs.
  assert.deepEqual([...built.matchAll(/<script[^>]*>/g)].map((m) => m[0]), ['<script type="module" src="./landing.js">']);
  assert.ok(!/ on[a-z]+="/.test(built));
  // The script finds every element it writes to.
  for (const [, id] of `${scriptOf("landing.ts")}${scriptOf("site.ts")}`.matchAll(/\$\("([a-z-]+)"\)/g)) assert.ok(built.includes(` id="${id}"`), id);
});

test("landing: a link that is not set leaves no trace, and one that is set shows everywhere it belongs", () => {
  const without: string = landingPage(source, live);
  assert.ok(!without.includes("GitHub") && !without.includes(">X<"));
  const withLinks: string = landingPage(source, { ...live, GITHUB_URL: "https://github.com/Longyu-L2/LongyuL2", X_URL: "https://x.com/longyu" });
  assert.equal(withLinks.split('href="https://github.com/Longyu-L2/LongyuL2" rel="noopener">GitHub</a>').length - 1, 2);
  assert.equal(withLinks.split('<a href="https://x.com/longyu" rel="noopener">X</a>').length - 1, 1);
  assert.ok(!withLinks.includes("data-optional"));
  // Nothing else differs between the two.
  const lines = new Set(without.split("\n"));
  assert.equal(withLinks.split("\n").filter((line) => !lines.has(line)).length, 3);
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
  assert.throws(() => landingPage('<a href="{{MINE_URL}}" data-optional="MINE_URL">x</a>', live), /MINE_URL is not an optional value/);
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

const developers = readFileSync(new URL("./developers.html", import.meta.url), "utf8");
const contracts = {
  L2_TOKEN: "0xF4769160D6dc78F66f61F0eA1638E65d43610163", SWAP_ROUTER: "0xed3Eb7fe322424C14cc356Ab182021cAb8dCf01A", SWAP_FACTORY: "0xfE5372cA129113bf12EC70D1EE4A7cBB14f172B0",
  TOKEN_LAUNCHER: "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF",
  L1_STANDARD_BRIDGE: "0xbd5585161c5E9797D2102e775D9C5439aB51279a", L1_PORTAL: "0xB1ba2E8af7137c607987F1c8d89c0f8b0c7D2623", L1_TOKEN: "0x88d5B1946BaB654e31Fbf0bcc3D022e995aB129C",
};

test("developers: the page is built with the landing page's addresses and links nowhere else", () => {
  for (const name of Object.keys(live)) assert.equal(landingPage(developers, { ...live, [name]: "" }, "developers.html"), null, name);
  const built: string = landingPage(developers, { ...live, ...contracts }, "developers.html");
  assert.ok(!built.includes("{{") && !built.includes("data-optional"));
  assert.ok(built.includes('<link rel="canonical" href="https://longyu.network/developers" />'));
  assert.ok(["https://rpc-testnet.longyu.network", "668801", "tBNB", "LONGYU Testnet", "https://scan-testnet.longyu.network"].every((value) => built.includes(`<dd><span>${value}</span><button type="button" data-copy="${value}"`)));
  // The commands are the ones the explorer's own tests run, with this build's addresses in them.
  assert.ok(["--chain-id 668801", "--verifier blockscout", "--verifier-url https://scan-testnet.longyu.network/api", "--watch</pre>"].every((line) => built.includes(`\n  ${line}`)));
  assert.ok(built.includes('longyu = "https://rpc-testnet.longyu.network"</pre>') && built.includes("  id: 668801,\n"));
  assert.ok(built.includes(`      url: "https://rpc-testnet.longyu.network",\n      chainId: 668801,`) && built.includes(`apiUrl: "https://scan-testnet.longyu.network/api",`) && built.includes("\n    668801: {\n"));
  // Every link goes to one of the build's addresses, stays on the site, or shows a BSC testnet contract on its explorer.
  const sites = [live.APP_URL, live.MINE_URL, live.EXPLORER_URL];
  for (const [, href] of built.matchAll(/<a [^>]*href="([^"]+)"/g)) {
    assert.ok(["./", "./developers"].includes(href!) || sites.some((s) => href!.startsWith(`${s}/`)) || /^https:\/\/testnet\.bscscan\.com\/address\/0x[0-9a-fA-F]{40}$/.test(href!), href);
  }
  assert.deepEqual([...built.matchAll(/<script[^>]*>/g)].map((m) => m[0]), ['<script type="module" src="./developers.js">']);
  assert.ok(!/ on[a-z]+="/.test(built));
  // The script finds every element it writes to, and every copy button the text it copies.
  for (const [, id] of `${scriptOf("developers.ts")}${scriptOf("site.ts")}`.matchAll(/\$\("([a-z-]+)"\)/g)) assert.ok(built.includes(` id="${id}"`), id);
  const copied = [...built.matchAll(/data-copy-from="([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(copied.length > 0 && copied.every((id) => built.includes(`<pre id="${id}"`)));
});

test("developers: every address on the page is written the way wallets check it", () => {
  const built: string = landingPage(developers, { ...live, ...contracts }, "developers.html");
  const shown = [...new Set([...built.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]))];
  assert.ok(shown.length >= 13);
  for (const address of shown) assert.equal(getAddress(address.toLowerCase()), address);
  // Each one is shown, linked and copied as the same address.
  for (const [, linked, text, copy] of built.matchAll(/\/address\/(0x[0-9a-fA-F]{40})"[^>]*>(0x[0-9a-fA-F]{40})<\/a><button type="button" data-copy="(0x[0-9a-fA-F]{40})"/g)) assert.ok(linked === text && text === copy, text);
  assert.equal([...built.matchAll(/\/address\/0x/g)].length, [...built.matchAll(/<dl class="rows">[\s\S]*?<\/dl>/g)].join("").split("<dt>").length - 1);
});

test("developers: a contract that is not set leaves no row, and one that is not an address stops the build", () => {
  const without: string = landingPage(developers, live, "developers.html");
  assert.ok(!without.includes("data-optional") && !without.includes("{{") && !without.includes("bscscan"));
  assert.ok(!without.includes("LONGYU Swap router") && without.includes("L2 Standard Bridge") && without.includes("Multicall3"));
  const full: string = landingPage(developers, { ...live, ...contracts }, "developers.html");
  const lines = new Set(without.split("\n"));
  // One row for each contract, and with TOKEN_LAUNCHER the launch page's links in the menu and the footer.
  assert.equal(full.split("\n").filter((line) => !lines.has(line)).length, Object.keys(contracts).length + 2);
  assert.ok(full.includes('<a href="https://testnet.longyu.network/launch.html">Launch</a>') && !without.includes("launch.html"));
  for (const name of Object.keys(contracts)) {
    assert.throws(() => landingPage(developers, { ...live, [name]: "0x1234" }, "developers.html"), new RegExp(`${name} must be a contract address`));
    assert.throws(() => landingPage(developers, { ...live, [name]: `${contracts.L2_TOKEN}"><script>` }, "developers.html"), /must be a contract address/);
  }
  assert.throws(() => landingPage("<p>{{OTHER}}</p>", live, "developers.html"), /developers\.html: no value for OTHER/);
});

test("developers: the published page sends no requests at all", () => {
  const out: string = publishedPage("developers.html", landingPage(developers, { ...live, ...contracts }, "developers.html"), live);
  assert.ok(out.includes("default-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline';"));
  assert.ok(!out.includes("connect-src https:") && !out.includes("localhost"));
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(`${scriptOf("developers.ts")}${scriptOf("site.ts")}`));
});

test("developers: the page's own words", () => {
  assert.ok(!/1:1|guarantee|profit|\bearn\b/i.test(developers));
  assert.ok(developers.includes("tLONG on testnet has no monetary value."));
  assert.ok(!developers.includes("\u2014"));
  // A key is never typed into a command: the deploy command signs from Foundry's keystore.
  assert.ok(!/--private-key|PRIVATE_KEY/i.test(developers) && developers.includes("--account deployer"));
});

test("landing: the official token's address is listed and named in the footer, only when it is set", () => {
  const LONG = "0xc6D2B2483EC93C15109FCe43d21Ac05919031655";
  assert.ok(!(landingPage(source, live) as string).includes("Official"));
  const testnet: string = landingPage(source, { ...live, L2_TOKEN: LONG });
  assert.ok(testnet.includes(`<dt>Official tLONG</dt><dd><span>${LONG}</span><button type="button" data-copy="${LONG}"`));
  const mainnet: string = landingPage(source, { ...live, CHAIN_ID: "668800", L2_TOKEN: LONG }, "landing.html", PROFILES.mainnet);
  assert.ok(mainnet.includes(`<dt>Official LONG</dt><dd><span>${LONG}</span>`));
  assert.ok(mainnet.includes(`<p class="fine">The only official LONG is ${LONG}. Any other token called LONG or LONGYU was not made by LONGYU.</p>`));
  assert.ok(!testnet.includes("The only official"));
  assert.throws(() => landingPage(source, { ...live, L2_TOKEN: "LONG" }), /L2_TOKEN must be a contract address/);
});

test("landing: the launch page is reached from the cards, the menu and the footer, only when TOKEN_LAUNCHER is set", () => {
  const LAUNCHER = "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF";
  const without: string = landingPage(source, live);
  assert.ok(!without.includes("launch.html"));
  // Five cards without it: the last one spans the row.
  assert.equal(without.split('<a class="card" ').length - 1, 5);
  for (const profile of [PROFILES.testnet, PROFILES.mainnet]) {
    const settings = { ...live, CHAIN_ID: String(profile.l2.id), TOKEN_LAUNCHER: LAUNCHER };
    const built: string = landingPage(source, settings, "landing.html", profile);
    assert.equal(built.split('href="https://testnet.longyu.network/launch.html"').length - 1, 3, profile.network);
    assert.equal(built.split('href="https://testnet.longyu.network/swap.html"').length - 1, 3, profile.network);
    assert.equal(built.split('<a class="card" ').length - 1, 6, profile.network);
    assert.ok(built.includes("<p>Launch a fixed-supply token for your project. Gas only.</p>"));
  }
  assert.throws(() => landingPage(source, { ...live, TOKEN_LAUNCHER: "0x1234" }), /TOKEN_LAUNCHER must be a contract address/);
});
