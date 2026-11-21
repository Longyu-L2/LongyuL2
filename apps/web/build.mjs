// Bundles the claim page (src/main.ts), the pay page (src/pay.ts), the bridge page (src/bridge.ts), the swap
// page (src/swap.ts) and the Safe page (src/safe.ts) into dist/ with the API URL baked in. Usage: API_URL=https://api.example node build.mjs
// (node build.mjs --out <folder> writes somewhere other than dist/).
//
// NETWORK picks the network the pages are for: testnet (the default) or mainnet. Its profile in
// src/networks.json (BSC's chain, LONGYU's chain id and name, the symbols, what is open) is fixed
// into every page and script, and the other network's values appear nowhere in the build. On mainnet,
// which opens as a mining period, LONG is locked in wallets until the TGE: the bridge moves BNB only
// (L1_TOKEN and L2_TOKEN are not read), the swap page is not built and no page links to it, and the
// Safe page does not list the faucet's calls. CHAIN_ID, when set, must be the profile's LONGYU chain id.
//   NETWORK             testnet or mainnet (default testnet)
//   TOKEN_NAME, TOKEN_SYMBOL  the reward token on the claim page (default the profile's: tLONG, or LONG)
//
// The bridge page's settings are read only from these variables. Its addresses are never guessed: when one is
// missing or invalid, the page says it is unavailable and no action works.
// Use the proxy addresses from the network's l1-deployments.json (chain/testnet/), not the implementations.
//   L1_PORTAL           OptimismPortalProxy on BSC
//   L1_OUTPUT_ORACLE    L2OutputOracleProxy on BSC
//   L1_STANDARD_BRIDGE  L1StandardBridgeProxy on BSC
//   L1_TOKEN            the mined token, the BEP-20 on BSC (testnet only)
//   L2_TOKEN            the mined token on LONGYU (the OptimismMintableERC20 created by the factory predeploy)
//   L2_RPC_URL          LONGYU RPC, https
//   L1_RPC_URL          BSC RPC, https (default the profile's public node, l1.rpc in src/networks.json)
//   EXPLORER_URL        LONGYU explorer, for transaction links (optional; also used by the claim page)
//
// The claim page links to LONGYU MINE when it is given its address; without it, no link shows.
//   MINE_URL            LONGYU MINE in a browser, https (optional)
//
// The swap page reads L2_TOKEN, L2_RPC_URL and EXPLORER_URL too, and the two LONGYU Swap addresses recorded in
// chain/testnet/README.md. It closes the same way when one is missing or invalid.
//   SWAP_ROUTER         LONGYU Swap router on LONGYU
//   SWAP_FACTORY        LONGYU Swap factory on LONGYU
//
// The Safe page reads L2_RPC_URL, L1_RPC_URL and EXPLORER_URL. It holds no contract address: a signer types
// the Safe's address or opens a link that carries it.
//
// API_URL, L2_RPC_URL and L1_RPC_URL are also written into the pages' Content-Security-Policy: the pay, bridge,
// swap and Safe pages may send requests to those addresses and to no other. One that is set and is not an
// https address (http only on localhost) stops the build.
//
// The landing page (src/landing.html) and the developer page (src/developers.html), served on the names in
// the server's LANDING_HOSTS, link to everything else, so they are built only when all of these are set:
// SITE_URL, APP_URL, MINE_URL, EXPLORER_URL, L2_RPC_URL and CHAIN_ID. The landing page reads the block height
// at L2_RPC_URL and sends requests nowhere else; the developer page sends none.
//   SITE_URL            The landing page's own address, https://longyu.network
//   APP_URL             These pages' address, https://testnet.longyu.network
//   GITHUB_URL, X_URL   Links that show only when they are set (optional)
// The developer page lists L2_TOKEN, SWAP_ROUTER, SWAP_FACTORY, L1_STANDARD_BRIDGE, L1_PORTAL and L1_TOKEN,
// each only when it is set.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The networks a build can be for, read by the pages through src/profile.ts. */
export const PROFILES = JSON.parse(readFileSync(new URL("./src/networks.json", import.meta.url), "utf8"));

/** The profile NETWORK names: testnet when it is empty. */
export function profileFor(network) {
  const name = (network ?? "").trim() || "testnet";
  if (!Object.hasOwn(PROFILES, name)) throw new Error(`NETWORK must be testnet or mainnet, not "${name}"`);
  return PROFILES[name];
}

/** The pages a network's build makes: the swap page only where it is open. */
export function pagesFor(profile) {
  return ["index.html", "pay.html", "bridge.html", ...(profile.swap ? ["swap.html"] : []), "safe.html"];
}

/** The BSC testnet node the bridge and Safe pages read when L1_RPC_URL is empty: DEFAULT_L1_RPC in src/bridge-core.ts. */
export const DEFAULT_L1_RPC = PROFILES.testnet.l1.rpc;

// The settings that hold the addresses each page's script sends requests to. A wallet is reached inside
// the browser and is not one of them. The claim page (index.html) is not listed: it reads the chain at
// the RPC address in the API's answer and the reward data at an address recorded on chain, neither
// known here, so its policy stays as index.html has it.
const CONTACTS = {
  "pay.html": ["API_URL"],
  "bridge.html": ["L2_RPC_URL", "L1_RPC_URL"],
  "swap.html": ["L2_RPC_URL"],
  "safe.html": ["L2_RPC_URL", "L1_RPC_URL"],
  "landing.html": ["L2_RPC_URL"],
  // It hands the network to a wallet and copies text: nothing leaves the page.
  "developers.html": [],
};

// As a page's policy has it before the build narrows it.
const ANY_ADDRESS = "connect-src https: http://localhost:*;";

/**
 * One address as a connect-src source: its origin and nothing after it.
 * Throws for what no page accepts or what would widen the policy: no URL, not https (http only on
 * localhost), a name and password, or a host that is not a plain name.
 */
export function connectSource(name, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an https address`);
  }
  const local = url.protocol === "http:" && url.hostname === "localhost";
  if (url.protocol !== "https:" && !local) throw new Error(`${name} must be an https address (http only on localhost)`);
  if (url.username || url.password) throw new Error(`${name} must not carry a name and password`);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname)) throw new Error(`${name}: "${url.hostname}" is not a host name`);
  // On a developer's machine the API and the nodes move between ports.
  return local ? "http://localhost:*" : url.origin;
}

/** A page's connect-src sources from the build's settings, or null for a page whose policy is not narrowed. */
export function connectSources(page, settings, profile = PROFILES.testnet) {
  if (!Object.hasOwn(CONTACTS, page)) return null;
  const sources = new Set();
  for (const name of CONTACTS[page]) {
    const value = (settings[name] ?? "").trim() || (name === "L1_RPC_URL" ? profile.l1.rpc : "");
    if (value) sources.add(connectSource(name, value));
    // With an empty API_URL the page asks the address it was served from.
    else if (name === "API_URL") sources.add("'self'");
    // A page without its RPC address stays closed and sends nothing.
  }
  return sources.size ? [...sources] : ["'none'"];
}

/** A page as it is published: its policy names the addresses it was built with in place of any https address. */
export function publishedPage(page, html, settings, profile = PROFILES.testnet) {
  const sources = connectSources(page, settings, profile);
  if (!sources) return html;
  if (html.split(ANY_ADDRESS).length !== 2) throw new Error(`${page}: its Content-Security-Policy has no connect-src to narrow`);
  return html.replace(ANY_ADDRESS, `connect-src ${sources.join(" ")};`);
}

// The addresses the landing page links to: each is a site's address with nothing after it.
const LANDING_SITES = ["SITE_URL", "APP_URL", "MINE_URL", "EXPLORER_URL"];
// Links the landing page shows only when they are set.
const LANDING_LINKS = ["GITHUB_URL", "X_URL"];
// Contract addresses the developer page lists, each only when it is set.
const LANDING_ADDRESSES = ["L2_TOKEN", "SWAP_ROUTER", "SWAP_FACTORY", "L1_STANDARD_BRIDGE", "L1_PORTAL", "L1_TOKEN"];

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The profile's values a page names as {{L1_NAME}} and the like. */
function profileValues(profile) {
  return {
    L1_NAME: profile.l1.name,
    L1_SHORT: profile.l1.short,
    L1_CHAIN_ID: String(profile.l1.id),
    L1_EXPLORER: profile.l1.explorer,
    L2_NAME: profile.l2.name,
    L2_CHAIN_ID: String(profile.l2.id),
    NATIVE: profile.native,
    TOKEN: profile.token.symbol,
  };
}

/**
 * A page for the build's network. A line marked data-network="testnet" (or "mainnet") is kept only
 * on that network, without the mark; the profile's values are written in. With `rest` "throw", a
 * {{NAME}} left over stops the build; with "keep" it is left for landingPage.
 */
export function networkPage(html, profile, page, rest = "throw") {
  const values = profileValues(profile);
  const lines = [];
  for (const line of html.split("\n")) {
    const only = / data-network="([a-z]+)"/.exec(line);
    if (!only) lines.push(line);
    else if (!Object.hasOwn(PROFILES, only[1])) throw new Error(`${page}: data-network="${only[1]}" is not a network`);
    else if (only[1] === profile.network) lines.push(line.replace(only[0], ""));
  }
  const out = lines.join("\n").replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) => {
    if (Object.hasOwn(values, name)) return escapeHtml(values[name]);
    if (rest === "throw") throw new Error(`${page}: no value for ${name}`);
    return whole;
  });
  // A page never links to one this network's build does not make.
  if (!profile.swap && /swap\.html/.test(out)) throw new Error(`${page}: links to the swap page, which ${profile.network} does not build`);
  return out;
}

function httpsAddress(name, value, site) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an https address`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must be an https address`);
  if (url.username || url.password) throw new Error(`${name} must not carry a name and password`);
  if (site && url.origin !== value) throw new Error(`${name} must be an https address with no path, like https://longyu.network`);
  return value;
}

/**
 * The landing page, or the developer page, with the build's addresses written into it, or null when
 * one it cannot do without is not set. A line marked data-optional="GITHUB_URL" is left out when that
 * link is not set. A value that is set and is not what the page can use throws, and so does a name
 * the page asks for that the build does not know.
 */
export function landingPage(html, settings, page = "landing.html", profile = PROFILES.testnet) {
  const setting = (name) => (settings[name] ?? "").trim();
  if ([...LANDING_SITES, "L2_RPC_URL", "CHAIN_ID"].some((name) => !setting(name))) return null;
  html = networkPage(html, profile, page, "keep");
  const values = { CHAIN_NAME: setting("CHAIN_NAME") || profile.l2.name, NATIVE_SYMBOL: setting("NATIVE_SYMBOL") || profile.native };
  for (const name of LANDING_SITES) values[name] = httpsAddress(name, setting(name), true);
  connectSource("L2_RPC_URL", setting("L2_RPC_URL"));
  values.L2_RPC_URL = setting("L2_RPC_URL");
  if (!/^[1-9][0-9]{0,15}$/.test(setting("CHAIN_ID"))) throw new Error("CHAIN_ID must be a whole number");
  values.CHAIN_ID = setting("CHAIN_ID");
  for (const name of LANDING_LINKS) if (setting(name)) values[name] = httpsAddress(name, setting(name), false);
  for (const name of LANDING_ADDRESSES) {
    if (!setting(name)) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(setting(name))) throw new Error(`${name} must be a contract address`);
    values[name] = setting(name);
  }
  const optionals = [...LANDING_LINKS, ...LANDING_ADDRESSES];
  const lines = [];
  for (const line of html.split("\n")) {
    const optional = / data-optional="([A-Z0-9_]+)"/.exec(line);
    if (!optional) lines.push(line);
    else if (!optionals.includes(optional[1])) throw new Error(`${page}: ${optional[1]} is not an optional value`);
    else if (Object.hasOwn(values, optional[1])) lines.push(line.replace(optional[0], ""));
  }
  return lines.join("\n").replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`${page}: no value for ${name}`);
    return escapeHtml(values[name]);
  });
}

/** The settings of one network that cannot be another's: CHAIN_ID, when set, is the profile's LONGYU. */
export function checkNetwork(settings, profile) {
  const chainId = (settings.CHAIN_ID ?? "").trim();
  if (chainId && chainId !== String(profile.l2.id)) throw new Error(`CHAIN_ID ${chainId} is not LONGYU on ${profile.network} (${profile.l2.id}); set NETWORK`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = (name) => process.env[name] ?? "";
  const profile = profileFor(env("NETWORK"));
  const outAt = process.argv.indexOf("--out");
  const out = outAt > 0 && process.argv[outAt + 1] ? process.argv[outAt + 1] : "dist";
  const apiUrl = process.env.API_URL ?? "http://localhost:8080";
  checkNetwork({ CHAIN_ID: env("CHAIN_ID") }, profile);
  // Before anything is bundled: a bad address stops the build here.
  const settings = { API_URL: apiUrl, L2_RPC_URL: env("L2_RPC_URL"), L1_RPC_URL: env("L1_RPC_URL") };
  const pages = pagesFor(profile).map((page) => [page, publishedPage(page, networkPage(readFileSync(`src/${page}`, "utf8"), profile, page), settings, profile)]);
  const landingSettings = {
    ...settings,
    SITE_URL: env("SITE_URL"),
    APP_URL: env("APP_URL"),
    MINE_URL: env("MINE_URL"),
    EXPLORER_URL: env("EXPLORER_URL"),
    CHAIN_ID: env("CHAIN_ID"),
    CHAIN_NAME: env("CHAIN_NAME"),
    NATIVE_SYMBOL: env("NATIVE_SYMBOL"),
    GITHUB_URL: env("GITHUB_URL"),
    X_URL: env("X_URL"),
    L2_TOKEN: env("L2_TOKEN"),
    SWAP_ROUTER: env("SWAP_ROUTER"),
    SWAP_FACTORY: env("SWAP_FACTORY"),
    L1_STANDARD_BRIDGE: env("L1_STANDARD_BRIDGE"),
    L1_PORTAL: env("L1_PORTAL"),
    L1_TOKEN: env("L1_TOKEN"),
  };
  const landing = landingPage(readFileSync("src/landing.html", "utf8"), landingSettings, "landing.html", profile);
  if (landing !== null) {
    pages.push(["landing.html", publishedPage("landing.html", landing, settings, profile)]);
    const developers = landingPage(readFileSync("src/developers.html", "utf8"), landingSettings, "developers.html", profile);
    pages.push(["developers.html", publishedPage("developers.html", developers, settings, profile)]);
  }
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: {
      main: "src/main.ts",
      pay: "src/pay.ts",
      bridge: "src/bridge.ts",
      ...(profile.swap ? { swap: "src/swap.ts" } : {}),
      safe: "src/safe.ts",
      ...(landing === null ? {} : { landing: "src/landing.ts", developers: "src/developers.ts" }),
    },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    outdir: out,
    define: {
      // The network's profile (src/profile.ts). __NETWORK__ being set leaves the testnet fallback out.
      __NETWORK__: JSON.stringify(profile.network),
      __PROFILE__: JSON.stringify(profile),
      __API_URL__: JSON.stringify(apiUrl),
      // Baked-in network details so the page still works when the API is down.
      __FALLBACK_NETWORK__: JSON.stringify(process.env.CHAIN_ID ? {
        chainId: process.env.CHAIN_ID,
        chainName: process.env.CHAIN_NAME ?? profile.l2.name,
        rpcUrl: process.env.RPC_URL,
        explorerUrl: process.env.EXPLORER_URL ?? "",
        nativeCurrency: { name: "BNB", symbol: process.env.NATIVE_SYMBOL ?? profile.native, decimals: 18 },
        rewardToken: process.env.REWARD_TOKEN
          ? { address: process.env.REWARD_TOKEN, name: process.env.TOKEN_NAME ?? profile.token.name, symbol: process.env.TOKEN_SYMBOL ?? profile.token.symbol, decimals: 18 }
          : undefined,
        distributor: process.env.DISTRIBUTOR,
      } : null),
      // Checked by mineLinks in src/chain.ts.
      __MINE_URL__: JSON.stringify(env("MINE_URL")),
      // Checked by parseConfig in src/bridge-core.ts.
      __BRIDGE_CONFIG__: JSON.stringify({
        l1Portal: env("L1_PORTAL"),
        l1OutputOracle: env("L1_OUTPUT_ORACLE"),
        l1StandardBridge: env("L1_STANDARD_BRIDGE"),
        l1Token: env("L1_TOKEN"),
        l2Token: env("L2_TOKEN"),
        l2RpcUrl: env("L2_RPC_URL"),
        l1RpcUrl: env("L1_RPC_URL"),
        explorerUrl: env("EXPLORER_URL"),
      }),
      // Checked by parseSwapConfig in src/swap-core.ts.
      __SWAP_CONFIG__: JSON.stringify(profile.swap ? {
        router: env("SWAP_ROUTER"),
        factory: env("SWAP_FACTORY"),
        token: env("L2_TOKEN"),
        rpcUrl: env("L2_RPC_URL"),
        explorerUrl: env("EXPLORER_URL"),
      } : null),
      // Checked by parseSafeConfig in src/safe-core.ts.
      __SAFE_CONFIG__: JSON.stringify({
        l1RpcUrl: env("L1_RPC_URL"),
        l2RpcUrl: env("L2_RPC_URL"),
        explorerUrl: env("EXPLORER_URL"),
      }),
      // Checked by parseLandingConfig in src/landing-core.ts.
      __LANDING_CONFIG__: JSON.stringify({
        rpcUrl: env("L2_RPC_URL"),
        chainId: env("CHAIN_ID"),
        chainName: env("CHAIN_NAME") || profile.l2.name,
        explorerUrl: env("EXPLORER_URL"),
        symbol: env("NATIVE_SYMBOL") || profile.native,
      }),
    },
  });
  for (const [page, html] of pages) writeFileSync(`${out}/${page}`, html);
  copyFileSync("src/favicon.svg", `${out}/favicon.svg`);
  copyFileSync("src/mark.svg", `${out}/mark.svg`);
  if (landing !== null) {
    copyFileSync("src/lockup.svg", `${out}/lockup.svg`);
    copyFileSync("src/share.png", `${out}/share.png`);
    // The fonts, and the licence they are published under.
    for (const name of readdirSync("src/fonts")) if (/\.woff2$|^OFL\.txt$/.test(name)) copyFileSync(`src/fonts/${name}`, `${out}/${name}`);
  }
  console.log(`built ${out}/ for ${profile.network}${landing === null ? " (without the landing and developer pages: their addresses are not all set)" : ""}`);
}
