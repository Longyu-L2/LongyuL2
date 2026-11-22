// NETWORK=testnet|mainnet: the profiles, how a page is made for one, and what a mainnet build holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bsc, bscTestnet } from "viem/chains";
import { PROFILES, SHELL_PAGES, checkNetwork, imageSources, landingPage, networkPage, pagesFor, profileFor, publishedPage, shellLinks, shellPage } from "../build.mjs";
import { PROFILE } from "./profile.ts";
import { CALLS } from "./safe-core.ts";

test("profiles: BSC is viem's own definition of it on each network", () => {
  assert.deepEqual(PROFILES.testnet.l1.chain, JSON.parse(JSON.stringify(bscTestnet)));
  assert.deepEqual(PROFILES.mainnet.l1.chain, JSON.parse(JSON.stringify(bsc)));
  for (const p of Object.values(PROFILES) as (typeof PROFILE)[]) assert.equal(p.l1.chain.id, p.l1.id);
  assert.deepEqual(Object.keys(PROFILES), ["testnet", "mainnet"]);
});

test("profiles: NETWORK picks one, and empty is the testnet the live site is built for", () => {
  assert.equal(profileFor(undefined), PROFILES.testnet);
  assert.equal(profileFor(""), PROFILES.testnet);
  assert.equal(profileFor(" mainnet "), PROFILES.mainnet);
  for (const bad of ["devnet", "Mainnet", "toString"]) assert.throws(() => profileFor(bad), /NETWORK must be testnet or mainnet/, bad);
  // Under Node, with nothing built in, the pages' code sees the testnet.
  assert.deepEqual(PROFILE, PROFILES.testnet);
  assert.ok(CALLS.some((c) => c.fn.name === "drip"), "the testnet's Safe page knows the faucet");
});

test("profiles: what each network is", () => {
  const pick = (p: typeof PROFILE) => [p.l1.id, p.l1.name, p.l1.explorer, p.l1.rpc, p.l2.id, p.l2.name, p.native, p.token.symbol, p.token.name, p.bridgeToken, p.tradeToken, p.swap];
  assert.deepEqual(pick(PROFILES.testnet), [97, "BSC Testnet", "https://testnet.bscscan.com", "https://bsc-testnet-rpc.publicnode.com", 668801, "LONGYU Testnet", "tBNB", "tLONG", "LONGYU Testnet Token", true, true, true]);
  assert.deepEqual(pick(PROFILES.mainnet), [56, "BNB Smart Chain", "https://bscscan.com", "https://bsc-rpc.publicnode.com", 668800, "LONGYU", "BNB", "LONG", "LONGYU", false, false, true]);
  assert.deepEqual(PROFILES.testnet.l2.chain, { testnet: true });
  assert.deepEqual(PROFILES.mainnet.l2.chain, {});
});

test("pages: the swap page on both networks, the launch page wherever TOKEN_LAUNCHER is set", () => {
  const launcher = { TOKEN_LAUNCHER: "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF" };
  for (const profile of [PROFILES.testnet, PROFILES.mainnet]) {
    assert.deepEqual(pagesFor(profile), ["index.html", "pay.html", "bridge.html", "swap.html", "safe.html"]);
    assert.deepEqual(pagesFor(profile, { TOKEN_LAUNCHER: " " }), ["index.html", "pay.html", "bridge.html", "swap.html", "safe.html"]);
    assert.deepEqual(pagesFor(profile, launcher), ["index.html", "pay.html", "bridge.html", "swap.html", "launch.html", "safe.html"]);
  }
  for (const bad of ["0x1234", "LONGYU Launch", `${launcher.TOKEN_LAUNCHER}"><script>`]) assert.throws(() => pagesFor(PROFILES.mainnet, { TOKEN_LAUNCHER: bad }), /TOKEN_LAUNCHER must be a contract address/, bad);
  // A network whose swap page is closed builds none.
  assert.ok(!pagesFor({ ...PROFILES.mainnet, swap: false }, launcher).includes("swap.html"));
});

test("pages: a line marked for a network is kept only there, and the profile's values are written in", () => {
  const html = ['<p data-network="testnet">Old {{TOKEN}}</p>', '<p data-network="mainnet">New {{TOKEN}}</p>', "<b>{{L1_NAME}} {{L1_CHAIN_ID}} {{L2_CHAIN_ID}} {{NATIVE}}</b>"].join("\n");
  assert.equal(networkPage(html, PROFILES.testnet, "x.html"), "<p>Old tLONG</p>\n<b>BSC Testnet 97 668801 tBNB</b>");
  assert.equal(networkPage(html, PROFILES.mainnet, "x.html"), "<p>New LONG</p>\n<b>BNB Smart Chain 56 668800 BNB</b>");
  assert.throws(() => networkPage("{{SITE_URL}}", PROFILES.testnet, "x.html"), /x\.html: no value for SITE_URL/);
  assert.equal(networkPage("{{SITE_URL}} {{TOKEN}}", PROFILES.testnet, "x.html", "keep"), "{{SITE_URL}} tLONG");
  assert.throws(() => networkPage('<p data-network="devnet">x</p>', PROFILES.testnet, "x.html"), /not a network/);
  // A line marked for a page is kept only when the build makes that page, and no page links to one it does not.
  const nav = '<a href="./swap.html" data-page="swap.html">Swap</a>\n<a href="./launch.html" data-page="launch.html">Launch</a>';
  assert.equal(networkPage(nav, PROFILES.mainnet, "x.html"), '<a href="./swap.html">Swap</a>');
  assert.equal(networkPage(nav, PROFILES.mainnet, "x.html", "throw", pagesFor(PROFILES.mainnet, { TOKEN_LAUNCHER: `0x${"1".repeat(40)}` })), '<a href="./swap.html">Swap</a>\n<a href="./launch.html">Launch</a>');
  assert.throws(() => networkPage('<a href="./launch.html">Launch</a>', PROFILES.mainnet, "x.html"), /x\.html: links to launch\.html, which this build does not make/);
  assert.throws(() => networkPage('<a href="./swap.html">Swap</a>', PROFILES.mainnet, "x.html", "throw", ["index.html"]), /links to swap\.html/);
  assert.equal(networkPage('<a href="./launch.html" data-network="testnet" data-page="launch.html">x</a>', PROFILES.mainnet, "x.html", "throw", ["launch.html"]), "");
  assert.equal(networkPage('<a href="./launch.html" data-network="mainnet" data-page="launch.html">x</a>', PROFILES.mainnet, "x.html", "throw", ["launch.html"]), '<a href="./launch.html">x</a>');
  assert.throws(() => networkPage('<a data-page="admin.html">x</a>', PROFILES.mainnet, "x.html"), /data-page="admin\.html" is not a page/);
});

test("pages: CHAIN_ID, when set, is the network's own LONGYU", () => {
  checkNetwork({ CHAIN_ID: "668801" }, PROFILES.testnet);
  checkNetwork({ CHAIN_ID: "668800" }, PROFILES.mainnet);
  checkNetwork({ CHAIN_ID: "" }, PROFILES.mainnet);
  assert.throws(() => checkNetwork({ CHAIN_ID: "668801" }, PROFILES.mainnet), /CHAIN_ID 668801 is not LONGYU on mainnet \(668800\)/);
  assert.throws(() => checkNetwork({ CHAIN_ID: "668800" }, PROFILES.testnet), /not LONGYU on testnet/);
});

test("bar: Swap, Launch and Bridge link the pages' own names when they are set, else the pages next to them", () => {
  assert.deepEqual(SHELL_PAGES, ["swap.html", "launch.html", "bridge.html"]);
  assert.deepEqual(shellLinks({}), { SWAP_HREF: "./swap.html", LAUNCH_HREF: "./launch.html", BRIDGE_HREF: "./bridge.html" });
  assert.deepEqual(shellLinks({ DEX_URL: "https://dex.longyu.network", BRIDGE_URL: " https://bridge.longyu.network " }), {
    SWAP_HREF: "https://dex.longyu.network/",
    LAUNCH_HREF: "https://dex.longyu.network/launch",
    BRIDGE_HREF: "https://bridge.longyu.network/",
  });
  assert.deepEqual(shellLinks({ DEX_URL: "https://dex.longyu.network" }, "https://app.longyu.network").BRIDGE_HREF, "https://app.longyu.network/bridge.html");
  for (const bad of ["http://dex.longyu.network", "https://dex.longyu.network/", "https://dex.longyu.network/swap", "dex.longyu.network", "https://user:pw@dex.longyu.network"]) {
    assert.throws(() => shellLinks({ DEX_URL: bad }), /DEX_URL must/, bad);
    assert.throws(() => shellLinks({ BRIDGE_URL: bad }), /BRIDGE_URL must/, bad);
  }

  const bar = [
    '<link rel="canonical" href="{{DEX_URL}}/launch" data-optional="DEX_URL" />',
    '<a href="{{HOME_HREF}}">home</a>',
    '<a href="{{SWAP_HREF}}">Swap</a><a href="{{LAUNCH_HREF}}" aria-current="page">Launch</a><a href="{{BRIDGE_HREF}}">Bridge</a>',
    '<a href="{{EXPLORER_URL}}/" data-optional="EXPLORER_URL">Explorer</a>',
  ].join("\n");
  assert.equal(
    shellPage(bar, { SITE_URL: "https://longyu.network", EXPLORER_URL: "https://scan.longyu.network/", DEX_URL: "https://dex.longyu.network", BRIDGE_URL: "https://bridge.longyu.network" }, "launch.html"),
    [
      '<link rel="canonical" href="https://dex.longyu.network/launch" />',
      '<a href="https://longyu.network/">home</a>',
      '<a href="https://dex.longyu.network/">Swap</a><a href="https://dex.longyu.network/launch" aria-current="page">Launch</a><a href="https://bridge.longyu.network/">Bridge</a>',
      '<a href="https://scan.longyu.network/">Explorer</a>',
    ].join("\n"),
  );
  // Unset, the links are relative, there is no canonical line and no explorer link; a bad explorer address is no link either.
  assert.equal(
    shellPage(bar, { EXPLORER_URL: "javascript:alert(1)" }, "launch.html"),
    ['<a href="./">home</a>', '<a href="./swap.html">Swap</a><a href="./launch.html" aria-current="page">Launch</a><a href="./bridge.html">Bridge</a>'].join("\n"),
  );
  assert.throws(() => shellPage('<b data-optional="L2_TOKEN">x</b>', {}, "swap.html"), /L2_TOKEN is not an optional value/);
  assert.throws(() => shellPage("{{API_URL}}", {}, "swap.html"), /swap\.html: no value for API_URL/);

  // The landing page links them too.
  const landingSettings = { SITE_URL: "https://longyu.network", APP_URL: "https://app.longyu.network", MINE_URL: "https://mine.longyu.network", EXPLORER_URL: "https://scan.longyu.network", L2_RPC_URL: "https://rpc.longyu.network", CHAIN_ID: "668800" };
  const cards = '<a href="{{SWAP_HREF}}">s</a><a href="{{LAUNCH_HREF}}" data-page="launch.html">l</a><a href="{{BRIDGE_HREF}}">b</a>';
  assert.equal(landingPage(cards, { ...landingSettings, TOKEN_LAUNCHER: `0x${"1".repeat(40)}` }, "landing.html", PROFILES.mainnet), '<a href="https://app.longyu.network/swap.html">s</a><a href="https://app.longyu.network/launch.html">l</a><a href="https://app.longyu.network/bridge.html">b</a>');
  assert.equal(
    landingPage(cards, { ...landingSettings, TOKEN_LAUNCHER: `0x${"1".repeat(40)}`, DEX_URL: "https://dex.longyu.network", BRIDGE_URL: "https://bridge.longyu.network" }, "landing.html", PROFILES.mainnet),
    '<a href="https://dex.longyu.network/">s</a><a href="https://dex.longyu.network/launch">l</a><a href="https://bridge.longyu.network/">b</a>',
  );
});

test("policy: logos come from the API, chosen logos from the visitor's file, wallet icons as data: images", () => {
  const settings = { API_URL: "https://api.longyu.network/v1", L2_RPC_URL: "https://rpc.longyu.network" };
  assert.deepEqual(imageSources("swap.html", settings), ["https://api.longyu.network", "data:"]);
  assert.deepEqual(imageSources("launch.html", settings), ["https://api.longyu.network", "blob:", "data:"]);
  assert.deepEqual(imageSources("bridge.html", settings), ["data:"]);
  assert.equal(imageSources("pay.html", settings), null);
  assert.deepEqual(imageSources("swap.html", {}), ["data:"]);
  assert.throws(() => imageSources("swap.html", { API_URL: "http://api.longyu.network" }), /API_URL must be an https address/);
  const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src https: http://localhost:*; img-src 'self'; base-uri 'none'" />`;
  assert.equal(
    publishedPage("swap.html", html, settings, PROFILES.mainnet),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src https://rpc.longyu.network https://api.longyu.network; img-src 'self' https://api.longyu.network data:; base-uri 'none'" />`,
  );
  assert.throws(() => publishedPage("swap.html", html.replace("img-src 'self';", "img-src *;"), settings, PROFILES.mainnet), /no img-src to widen/);
});

// Every setting the build reads (the Dockerfile names them all), so none comes from the shell.
const here = fileURLToPath(new URL("..", import.meta.url));
const SETTINGS = [...readFileSync(join(here, "Dockerfile"), "utf8").matchAll(/^ARG ([A-Z0-9_]+)$/gm)].map((m) => m[1]!);

function buildWith(values: Record<string, string>): { dir: string; files: Map<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "longyu-web-"));
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of SETTINGS) delete env[name];
  const run = spawnSync(process.execPath, ["build.mjs", "--out", dir], { cwd: here, env: { ...env, ...values }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) if (/\.(html|js|svg|txt|css)$/.test(name)) files.set(name, readFileSync(join(dir, name), "utf8"));
  return { dir, files };
}

const site = {
  SITE_URL: "https://longyu.network",
  GITHUB_URL: "https://github.com/Longyu-L2/LongyuL2",
};

test("build: a mainnet build holds no testnet value, and its swap and launch pages trade without LONG", { timeout: 120_000 }, () => {
  const { dir, files } = buildWith({
    ...site,
    NETWORK: "mainnet",
    APP_URL: "https://app.longyu.network",
    MINE_URL: "https://mine.longyu.network",
    API_URL: "https://api.longyu.network",
    EXPLORER_URL: "https://scan.longyu.network",
    L2_RPC_URL: "https://rpc.longyu.network",
    RPC_URL: "https://rpc.longyu.network",
    CHAIN_ID: "668800",
    CHAIN_NAME: "LONGYU",
    NATIVE_SYMBOL: "BNB",
    L1_PORTAL: "0x09BD641f8A55cDC49851f828cb392134c9aE35eb",
    L1_STANDARD_BRIDGE: "0xA44A484bfDBfB97951A172fC798389Dd37599a5a",
    L1_OUTPUT_ORACLE: "0x77fF9CDD8B92869D428956695dE0e2d94a75aDC8",
    L2_TOKEN: "0xc6D2B2483EC93C15109FCe43d21Ac05919031655",
    SWAP_ROUTER: "0x39232e1F40a70e1B9d6c78945a5Bc0aE769646B5",
    SWAP_FACTORY: "0xbCb5dFD7F8FBcB63eF4438E62F3b8456F08Ee693",
    TOKEN_LAUNCHER: "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF",
  });
  try {
    for (const page of ["index.html", "bridge.html", "swap.html", "launch.html", "safe.html", "pay.html", "landing.html", "developers.html", "main.js", "bridge.js", "swap.js", "launch.js", "safe.js"]) assert.ok(files.has(page), page);
    const forbidden = [/testnet/i, /tbnb/i, /tlong/i, /668801/, /0x61\b/i, /"97"/, /monetary value/i, /faucet/i];
    for (const [name, text] of files) for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name} holds ${pattern}`);
    for (const [name, text] of files) if (name.endsWith(".html")) assert.doesNotMatch(text, /data-network|data-page|data-optional|\{\{[A-Z0-9_]+\}\}/, name);
    const page = (name: string) => files.get(name)!;
    assert.match(page("bridge.html"), /<button type="button" id="asset-long" aria-pressed="false" disabled>LONG<\/button>/);
    assert.match(page("bridge.html"), /LONG moves after the TGE\./);
    assert.match(page("bridge.html"), /BNB Smart Chain → LONGYU/);
    assert.match(page("index.html"), /Mined LONG is locked in your wallet until the TGE\./);
    assert.match(page("safe.html"), /data-chain="56" aria-pressed="false">BNB Smart Chain</);
    assert.match(page("safe.html"), /data-chain="668800"/);
    assert.match(page("developers.html"), /<span>668800<\/span>/);
    assert.match(page("developers.html"), /href="https:\/\/bscscan\.com\/address\/0x09BD641f8A55cDC49851f828cb392134c9aE35eb"/);
    assert.match(page("landing.html"), /Live on mainnet/);
    assert.match(page("landing.html"), /Mined LONG is locked in wallets until the TGE\./);
    assert.match(page("bridge.html"), /connect-src https:\/\/rpc\.longyu\.network https:\/\/bsc-rpc\.publicnode\.com;/);
    // The swap, bridge and launch pages link each other; the swap and launch pages ask LONGYU's RPC and nothing else.
    for (const name of ["bridge.html", "swap.html", "launch.html"]) {
      for (const other of ["bridge.html", "swap.html", "launch.html"]) assert.match(page(name), new RegExp(`<a href="\\./${other.replace(".", "\\.")}"( aria-current="page")?>`), `${name} links ${other}`);
    }
    // The swap and launch pages ask LONGYU's RPC and the API (token logos) and nothing else, and show
    // images from the API; the launch page also shows a chosen logo from the visitor's file (blob:),
    // and all three draw the icons browser wallets announce (data:).
    assert.match(page("swap.html"), /connect-src https:\/\/rpc\.longyu\.network https:\/\/api\.longyu\.network; style-src 'self' 'unsafe-inline'; img-src 'self' https:\/\/api\.longyu\.network data:; base-uri/);
    assert.match(page("launch.html"), /connect-src https:\/\/rpc\.longyu\.network https:\/\/api\.longyu\.network; style-src 'self' 'unsafe-inline'; img-src 'self' https:\/\/api\.longyu\.network blob: data:; base-uri/);
    assert.match(page("bridge.html"), /img-src 'self' data:; base-uri/);
    // The bar's shared look and the fonts are published with the pages.
    for (const name of ["app.css", "lockup.svg"]) assert.ok(files.has(name), name);
    for (const name of ["swap", "launch", "bridge"]) {
      const html = page(`${name}.html`);
      assert.match(html, /<link rel="stylesheet" href="\.\/app\.css" \/>/, name);
      // One bundled script and no inline handler, and the script finds every element it writes to.
      assert.deepEqual([...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]), [`<script type="module" src="./${name}.js">`]);
      assert.doesNotMatch(html, / on[a-z]+="/);
      for (const [, id] of readFileSync(join(here, "src", `${name}.ts`), "utf8").matchAll(/(?:\$|show)\("([a-z-]+)"/g)) assert.ok(html.includes(` id="${id}"`), `${name}.html has #${id}`);
    }
    assert.match(page("swap.html"), /<p class="muted faint">0\.3% pool fee, paid to liquidity providers\.<\/p>/);
    assert.equal(page("swap.html").split("0.3% pool fee").length, 2);
    assert.match(page("swap.js"), /is in its mining phase and not tradable yet\./);
    assert.match(page("launch.html"), /<div><dt>Owner<\/dt><dd>None<\/dd><\/div>/);
    assert.match(page("launch.html"), /<div><dt>Cost<\/dt><dd>Gas only<\/dd><\/div>/);
    // Without DEX_URL and BRIDGE_URL the bar links the pages next to it, and no page names a canonical address of its own.
    for (const name of SHELL_PAGES) assert.doesNotMatch(page(name), /rel="canonical"/, name);
    assert.match(page("swap.html"), /<a class="bar-home" href="https:\/\/longyu\.network\/"/);
    assert.match(page("swap.html"), /<a href="https:\/\/scan\.longyu\.network\/">Explorer</);
    // The landing page's cards, menu and footer reach both, and the developer page lists their contracts.
    for (const path of ["swap.html", "launch.html"]) {
      assert.match(page("landing.html"), new RegExp(`<a class="card" href="https://app\\.longyu\\.network/${path.replace(".", "\\.")}">`), path);
      assert.equal(page("landing.html").split(`href="https://app.longyu.network/${path}"`).length - 1, 3, path);
      assert.equal(page("developers.html").split(`href="https://app.longyu.network/${path}"`).length - 1, 2, path);
    }
    assert.equal(page("landing.html").split('<a class="card" ').length - 1, 6, "six cards, three rows of two");
    assert.match(page("landing.html"), /<a class="card" href="\.\/developers">/);
    for (const [label, address] of [["LONGYU Swap router", "0x39232e1F40a70e1B9d6c78945a5Bc0aE769646B5"], ["LONGYU Swap factory", "0xbCb5dFD7F8FBcB63eF4438E62F3b8456F08Ee693"], ["LONGYU Launch", "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF"]]) {
      assert.ok(page("developers.html").includes(`<dt>${label}</dt><dd><a href="https://scan.longyu.network/address/${address}">${address}</a>`), label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build: the testnet build keeps its swap page and its notices", { timeout: 120_000 }, () => {
  const { dir, files } = buildWith({
    ...site,
    APP_URL: "https://testnet.longyu.network",
    MINE_URL: "https://mine-testnet.longyu.network",
    API_URL: "https://api-testnet.longyu.network",
    EXPLORER_URL: "https://scan-testnet.longyu.network",
    L2_RPC_URL: "https://rpc-testnet.longyu.network",
    CHAIN_ID: "668801",
  });
  try {
    assert.ok(files.has("swap.html") && files.has("swap.js"));
    assert.match(files.get("bridge.html")!, /<a href="\.\/swap\.html">Swap<\/a>/);
    assert.match(files.get("bridge.html")!, /<button type="button" id="asset-long" aria-pressed="false">tLONG<\/button>/);
    assert.match(files.get("index.html")!, /Testnet rewards have no monetary value\./);
    assert.match(files.get("landing.html")!, /Live on testnet/);
    assert.match(files.get("safe.html")!, /data-chain="97" aria-pressed="false">BSC Testnet</);
    for (const [name, text] of files) if (name.endsWith(".html")) assert.doesNotMatch(text, /data-network|data-page|\{\{[A-Z0-9_]+\}\}|TGE/, name);
    // Without TOKEN_LAUNCHER there is no launch page, and nothing links to one.
    assert.ok(!existsSync(join(dir, "launch.html")) && !existsSync(join(dir, "launch.js")), "no launch page");
    for (const [name, text] of files) assert.doesNotMatch(text, /launch\.html/, name);
    assert.equal(files.get("landing.html")!.split('<a class="card" ').length - 1, 5);
    assert.match(files.get("swap.html")!, /Testnet tokens have no monetary value\. 0\.3% pool fee, paid to liquidity providers\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
