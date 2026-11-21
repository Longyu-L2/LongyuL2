// NETWORK=testnet|mainnet: the profiles, how a page is made for one, and what a mainnet build holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bsc, bscTestnet } from "viem/chains";
import { PROFILES, checkNetwork, networkPage, pagesFor, profileFor } from "../build.mjs";
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
  const pick = (p: typeof PROFILE) => [p.l1.id, p.l1.name, p.l1.explorer, p.l1.rpc, p.l2.id, p.l2.name, p.native, p.token.symbol, p.token.name, p.bridgeToken, p.swap];
  assert.deepEqual(pick(PROFILES.testnet), [97, "BSC Testnet", "https://testnet.bscscan.com", "https://bsc-testnet-rpc.publicnode.com", 668801, "LONGYU Testnet", "tBNB", "tLONG", "LONGYU Testnet Token", true, true]);
  assert.deepEqual(pick(PROFILES.mainnet), [56, "BNB Smart Chain", "https://bscscan.com", "https://bsc-rpc.publicnode.com", 668800, "LONGYU", "BNB", "LONG", "LONGYU", false, false]);
  assert.deepEqual(PROFILES.testnet.l2.chain, { testnet: true });
  assert.deepEqual(PROFILES.mainnet.l2.chain, {});
  assert.deepEqual(pagesFor(PROFILES.testnet), ["index.html", "pay.html", "bridge.html", "swap.html", "safe.html"]);
  assert.deepEqual(pagesFor(PROFILES.mainnet), ["index.html", "pay.html", "bridge.html", "safe.html"]);
});

test("pages: a line marked for a network is kept only there, and the profile's values are written in", () => {
  const html = ['<p data-network="testnet">Old {{TOKEN}}</p>', '<p data-network="mainnet">New {{TOKEN}}</p>', "<b>{{L1_NAME}} {{L1_CHAIN_ID}} {{L2_CHAIN_ID}} {{NATIVE}}</b>"].join("\n");
  assert.equal(networkPage(html, PROFILES.testnet, "x.html"), "<p>Old tLONG</p>\n<b>BSC Testnet 97 668801 tBNB</b>");
  assert.equal(networkPage(html, PROFILES.mainnet, "x.html"), "<p>New LONG</p>\n<b>BNB Smart Chain 56 668800 BNB</b>");
  assert.throws(() => networkPage("{{SITE_URL}}", PROFILES.testnet, "x.html"), /x\.html: no value for SITE_URL/);
  assert.equal(networkPage("{{SITE_URL}} {{TOKEN}}", PROFILES.testnet, "x.html", "keep"), "{{SITE_URL}} tLONG");
  assert.throws(() => networkPage('<p data-network="devnet">x</p>', PROFILES.testnet, "x.html"), /not a network/);
  // A mainnet page never links to the swap page, which its build does not make.
  assert.throws(() => networkPage('<a href="./swap.html">Swap</a>', PROFILES.mainnet, "x.html"), /swap page/);
  assert.equal(networkPage('<a href="./swap.html" data-network="testnet">Swap</a>', PROFILES.mainnet, "x.html"), "");
});

test("pages: CHAIN_ID, when set, is the network's own LONGYU", () => {
  checkNetwork({ CHAIN_ID: "668801" }, PROFILES.testnet);
  checkNetwork({ CHAIN_ID: "668800" }, PROFILES.mainnet);
  checkNetwork({ CHAIN_ID: "" }, PROFILES.mainnet);
  assert.throws(() => checkNetwork({ CHAIN_ID: "668801" }, PROFILES.mainnet), /CHAIN_ID 668801 is not LONGYU on mainnet \(668800\)/);
  assert.throws(() => checkNetwork({ CHAIN_ID: "668800" }, PROFILES.testnet), /not LONGYU on testnet/);
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
  for (const name of readdirSync(dir)) if (/\.(html|js|svg|txt)$/.test(name)) files.set(name, readFileSync(join(dir, name), "utf8"));
  return { dir, files };
}

const site = {
  SITE_URL: "https://longyu.network",
  GITHUB_URL: "https://github.com/Longyu-L2/LongyuL2",
};

test("build: a mainnet build holds no testnet value, no swap page and no link to one", { timeout: 120_000 }, () => {
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
  });
  try {
    assert.ok(!existsSync(join(dir, "swap.html")) && !existsSync(join(dir, "swap.js")), "no swap page");
    for (const page of ["index.html", "bridge.html", "safe.html", "pay.html", "landing.html", "developers.html", "main.js", "bridge.js", "safe.js"]) assert.ok(files.has(page), page);
    const forbidden = [/testnet/i, /tbnb/i, /tlong/i, /668801/, /0x61\b/i, /"97"/, /monetary value/i, /faucet/i, /swap\.html/];
    for (const [name, text] of files) for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name} holds ${pattern}`);
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
    for (const [name, text] of files) if (name.endsWith(".html")) assert.doesNotMatch(text, /data-network|\{\{[A-Z0-9_]+\}\}|TGE/, name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
