// Bundles the claim page (src/main.ts), the pay page (src/pay.ts), the bridge page (src/bridge.ts), the swap
// page (src/swap.ts) and the Safe page (src/safe.ts) into dist/ with the API URL baked in. Usage: API_URL=https://api.example node build.mjs
//
// The bridge page's settings are read only from these variables. Its addresses are never guessed: when one is
// missing or invalid, the page shows "The bridge opens when LONGYU testnet launches." and no action works.
// Use the proxy addresses from chain/testnet/l1-deployments.json, not the implementations.
//   L1_PORTAL           OptimismPortalProxy on BSC testnet
//   L1_OUTPUT_ORACLE    L2OutputOracleProxy on BSC testnet
//   L1_STANDARD_BRIDGE  L1StandardBridgeProxy on BSC testnet
//   L1_TOKEN            tLONG, the BEP-20 on BSC testnet
//   L2_TOKEN            tLONG on LONGYU (the OptimismMintableERC20 created by the factory predeploy)
//   L2_RPC_URL          LONGYU testnet RPC, https
//   L1_RPC_URL          BSC testnet RPC, https (default https://bsc-testnet-rpc.publicnode.com)
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
// The landing page (src/landing.html, served on the names in the server's LANDING_HOSTS) links to everything
// else, so it is built only when all of these are set: SITE_URL, APP_URL, MINE_URL, EXPLORER_URL, L2_RPC_URL
// and CHAIN_ID. It reads the block height at L2_RPC_URL and sends requests nowhere else.
//   SITE_URL            The landing page's own address, https://longyu.network
//   APP_URL             These pages' address, https://testnet.longyu.network
//   GITHUB_URL, X_URL   Links that show only when they are set (optional)
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGES = ["index.html", "pay.html", "bridge.html", "swap.html", "safe.html"];

/** The BSC testnet node the bridge and Safe pages read when L1_RPC_URL is empty: DEFAULT_L1_RPC in src/bridge-core.ts. */
export const DEFAULT_L1_RPC = "https://bsc-testnet-rpc.publicnode.com";

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
export function connectSources(page, settings) {
  if (!Object.hasOwn(CONTACTS, page)) return null;
  const sources = new Set();
  for (const name of CONTACTS[page]) {
    const value = (settings[name] ?? "").trim() || (name === "L1_RPC_URL" ? DEFAULT_L1_RPC : "");
    if (value) sources.add(connectSource(name, value));
    // With an empty API_URL the page asks the address it was served from.
    else if (name === "API_URL") sources.add("'self'");
    // A page without its RPC address stays closed and sends nothing.
  }
  return sources.size ? [...sources] : ["'none'"];
}

/** A page as it is published: its policy names the addresses it was built with in place of any https address. */
export function publishedPage(page, html, settings) {
  const sources = connectSources(page, settings);
  if (!sources) return html;
  if (html.split(ANY_ADDRESS).length !== 2) throw new Error(`${page}: its Content-Security-Policy has no connect-src to narrow`);
  return html.replace(ANY_ADDRESS, `connect-src ${sources.join(" ")};`);
}

// The addresses the landing page links to: each is a site's address with nothing after it.
const LANDING_SITES = ["SITE_URL", "APP_URL", "MINE_URL", "EXPLORER_URL"];
// Links the landing page shows only when they are set.
const LANDING_LINKS = ["GITHUB_URL", "X_URL"];

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
 * The landing page with the build's addresses written into it, or null when one it cannot do without
 * is not set. A line marked data-optional="GITHUB_URL" is left out when that link is not set. A value
 * that is set and is not what the page can use throws, and so does a name the page asks for that the
 * build does not know.
 */
export function landingPage(html, settings) {
  const setting = (name) => (settings[name] ?? "").trim();
  if ([...LANDING_SITES, "L2_RPC_URL", "CHAIN_ID"].some((name) => !setting(name))) return null;
  const values = { CHAIN_NAME: setting("CHAIN_NAME") || "LONGYU Testnet", NATIVE_SYMBOL: setting("NATIVE_SYMBOL") || "tBNB" };
  for (const name of LANDING_SITES) values[name] = httpsAddress(name, setting(name), true);
  connectSource("L2_RPC_URL", setting("L2_RPC_URL"));
  values.L2_RPC_URL = setting("L2_RPC_URL");
  if (!/^[1-9][0-9]{0,15}$/.test(setting("CHAIN_ID"))) throw new Error("CHAIN_ID must be a whole number");
  values.CHAIN_ID = setting("CHAIN_ID");
  for (const name of LANDING_LINKS) if (setting(name)) values[name] = httpsAddress(name, setting(name), false);
  const lines = [];
  for (const line of html.split("\n")) {
    const optional = / data-optional="([A-Z0-9_]+)"/.exec(line);
    if (!optional) lines.push(line);
    else if (!LANDING_LINKS.includes(optional[1])) throw new Error(`landing.html: ${optional[1]} is not an optional link`);
    else if (Object.hasOwn(values, optional[1])) lines.push(line.replace(optional[0], ""));
  }
  return lines.join("\n").replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`landing.html: no value for ${name}`);
    return escapeHtml(values[name]);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = (name) => process.env[name] ?? "";
  const apiUrl = process.env.API_URL ?? "http://localhost:8080";
  // Before anything is bundled: a bad address stops the build here.
  const settings = { API_URL: apiUrl, L2_RPC_URL: env("L2_RPC_URL"), L1_RPC_URL: env("L1_RPC_URL") };
  const pages = PAGES.map((page) => [page, publishedPage(page, readFileSync(`src/${page}`, "utf8"), settings)]);
  const landing = landingPage(readFileSync("src/landing.html", "utf8"), {
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
  });
  if (landing !== null) pages.push(["landing.html", publishedPage("landing.html", landing, settings)]);
  mkdirSync("dist", { recursive: true });
  await build({
    entryPoints: { main: "src/main.ts", pay: "src/pay.ts", bridge: "src/bridge.ts", swap: "src/swap.ts", safe: "src/safe.ts", ...(landing === null ? {} : { landing: "src/landing.ts" }) },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    outdir: "dist",
    define: {
      __API_URL__: JSON.stringify(apiUrl),
      // Baked-in network details so the page still works when the API is down.
      __FALLBACK_NETWORK__: JSON.stringify(process.env.CHAIN_ID ? {
        chainId: process.env.CHAIN_ID,
        chainName: process.env.CHAIN_NAME ?? "LONGYU Testnet",
        rpcUrl: process.env.RPC_URL,
        explorerUrl: process.env.EXPLORER_URL ?? "",
        nativeCurrency: { name: "BNB", symbol: process.env.NATIVE_SYMBOL ?? "tBNB", decimals: 18 },
        rewardToken: process.env.REWARD_TOKEN
          ? { address: process.env.REWARD_TOKEN, name: process.env.TOKEN_NAME ?? "LONGYU Testnet Token", symbol: process.env.TOKEN_SYMBOL ?? "tLONG", decimals: 18 }
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
      __SWAP_CONFIG__: JSON.stringify({
        router: env("SWAP_ROUTER"),
        factory: env("SWAP_FACTORY"),
        token: env("L2_TOKEN"),
        rpcUrl: env("L2_RPC_URL"),
        explorerUrl: env("EXPLORER_URL"),
      }),
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
        chainName: env("CHAIN_NAME") || "LONGYU Testnet",
        explorerUrl: env("EXPLORER_URL"),
        symbol: env("NATIVE_SYMBOL") || "tBNB",
      }),
    },
  });
  for (const [page, html] of pages) writeFileSync(`dist/${page}`, html);
  copyFileSync("src/favicon.svg", "dist/favicon.svg");
  copyFileSync("src/mark.svg", "dist/mark.svg");
  if (landing !== null) {
    copyFileSync("src/lockup.svg", "dist/lockup.svg");
    copyFileSync("src/share.png", "dist/share.png");
    // The fonts, and the licence they are published under.
    for (const name of readdirSync("src/fonts")) if (/\.woff2$|^OFL\.txt$/.test(name)) copyFileSync(`src/fonts/${name}`, `dist/${name}`);
  }
  console.log(landing === null ? "built dist/ (without the landing page: its addresses are not all set)" : "built dist/");
}
