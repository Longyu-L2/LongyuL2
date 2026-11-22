/**
 * LONGYU Scan pages, rendered on the server. Numbers and links first, no filler text. Every value
 * passes through `html`, which escapes it; links come from the validated path helpers.
 */
import { decodeCall, decodeLog, methodName, PREDEPLOYS, type BridgedToken, type DecodedArg } from "../decode.ts";
import { SYSTEM_DEPOSITOR } from "../indexer.ts";
import { COUNT_CAP, DATA_BYTES, TX_ITEMS, type BlockRow, type LogRow, type Part, type TokenRow, type TransferRow, type TxListRow, type TxRow } from "../queries.ts";
import { formatGasPrice, formatNumber, formatUnits, percent, short, timeAgo, utc } from "./format.ts";
import { addressPath, blockPath, html, isAddress, SafeHtml, tokenPath, txPath } from "./html.ts";
import { contractTab, type ContractTab } from "./verify.ts";

export interface Site {
  chainName: string;
  chainId: bigint;
  native: string;
  l1Explorer: string;
  bridgeUrl: string;
  swapUrl: string | null;
  publicRpc: string | null;
  /** LONGYU's other pages, linked from the menu and the footer when set. */
  websiteUrl?: string | null;
  mineUrl?: string | null;
  developersUrl?: string | null;
  githubUrl?: string | null;
  /** Whether the explorer is taking contract verifications. */
  verification?: boolean;
  /** Lower-case address -> label (predeploys, LONGYU contracts, token symbols). */
  labels: Map<string, string>;
  /** LONGYU's own tokens, lower-case (OFFICIAL_TOKENS). */
  official?: string[];
  /** OFFICIAL_NOTE: shown with the official mark and in imitation warnings. */
  officialNote?: string | null;
  /** Fingerprint of the static files. It is part of their addresses, so a release never meets an old cached copy. */
  build: string;
}

export const PAGE_SIZE = 25;
/** Rows in each list of the home page. */
export const HOME_ROWS = 7;
/** Days in the home page's chart. */
export const CHART_DAYS = 14;

// ------------------------------------------------------------------ layout

const ICON_SEARCH = new SafeHtml(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`);
const ICON_MENU = new SafeHtml(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`);

/** The chain this one settles on, by name. */
const l1Name = (site: Site) => (site.native === "tBNB" ? "BSC Testnet" : "BNB Smart Chain");

const searchForm = (button: boolean) => html`<form class="search" action="/search" method="get" role="search">
      <input name="q" type="search" placeholder="Address, transaction, block or token" aria-label="Search" autocomplete="off" spellcheck="false" maxlength="100">
      ${button ? html`<button type="submit" aria-label="Search">${ICON_SEARCH}</button>` : html`<kbd>/</kbd>`}
    </form>`;

type Link = [href: string, label: string];
const outside = ([href, label]: Link) => html`<a href="${href}" rel="noopener">${label}</a>`;
const inside = ([href, label]: Link) => html`<a href="${href}">${label}</a>`;

/** The menu on a phone and the footer's columns list the same links. */
function sections(site: Site): { title: string; links: SafeHtml[] }[] {
  const network = ([[site.bridgeUrl, "Bridge"], [site.swapUrl, "Swap"], [site.mineUrl, "Mining app"], [site.websiteUrl, "Website"]] as [string | null | undefined, string][])
    .filter((l): l is Link => typeof l[0] === "string");
  return [
    { title: "Explorer", links: ([["/blocks", "Blocks"], ["/txs", "Transactions"], ["/tokens", "Tokens"], ["/bridge", "Bridge activity"]] as Link[]).map(inside) },
    { title: "Network", links: network.map(outside) },
    { title: "Developers", links: [...(site.developersUrl ? [outside([site.developersUrl, "Developer guide"])] : []), ...(site.verification ? [inside(["/verify", "Verify contract"])] : []), inside(["/api-docs", "API"]), ...(site.githubUrl ? [outside([site.githubUrl, "GitHub"])] : [])] },
  ];
}

/**
 * `active` is the path of the page's entry in the menu; "/" is the home page, which opens with the search.
 * `refresh` makes the page load itself again after that many seconds.
 */
export function layout(site: Site, title: string, body: SafeHtml, active = "", refresh?: number): string {
  const nav = [["/blocks", "Blocks"], ["/txs", "Transactions"], ["/tokens", "Tokens"], ["/bridge", "Bridge"], ["/api-docs", "API"]] as const;
  const home = active === "/";
  const groups = sections(site);
  const brand = html`<a class="brand" href="/" aria-label="LONGYU Scan home"><img class="mark" src="/static/mark.svg?v=${site.build}" alt="" width="19" height="24"><span class="word">LONGYU</span><span class="scan">Scan</span></a>`;
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · LONGYU Scan</title>
<meta name="description" content="${`Blocks, transactions, tokens and addresses on ${site.chainName}.`}">
<meta name="theme-color" content="#FFFFFF">
<meta name="color-scheme" content="only light">
${refresh ? html`<meta http-equiv="refresh" content="${Math.floor(refresh)}">` : ""}
<link rel="icon" href="/static/favicon.svg?v=${site.build}" type="image/svg+xml">
<link rel="stylesheet" href="/static/app.css?v=${site.build}">
<script src="/static/app.js?v=${site.build}" defer></script>
</head>
<body id="top" data-native="${site.native}">
<header class="top">
  <div class="wrap top-row">
    ${brand}
    <nav class="nav" aria-label="Pages">${nav.map(([href, label]) => (active === href ? html`<a href="${href}" class="on" aria-current="page">${label}</a>` : html`<a href="${href}">${label}</a>`))}</nav>
    ${home ? "" : searchForm(false)}
    <span class="pill net">${site.chainName}</span>
    <details class="menu">
      <summary aria-label="Menu">${ICON_MENU}</summary>
      <nav class="menu-panel" aria-label="Menu">
        <a href="/">Home</a>
        ${groups.map((g) => html`<h2>${g.title}</h2>${g.links}`)}
      </nav>
    </details>
  </div>
</header>
${home ? html`<section class="hero"><div class="wrap">
    <h1>${site.chainName} Explorer</h1>
    ${searchForm(true)}
</div></section>` : ""}
<main class="${home ? "wrap home" : "wrap"}">${body}</main>
<footer class="foot">
  <div class="wrap foot-top">
    <div class="foot-brand">
      ${brand}
      <p>${site.chainName} is a Layer 2 that settles on ${l1Name(site)}.</p>
      ${site.publicRpc ? html`<button class="button line" type="button" id="add-network" data-chain-id="${site.chainId}" data-chain-name="${site.chainName}" data-rpc="${site.publicRpc}" data-symbol="${site.native}">Add ${site.chainName} to wallet</button>` : ""}
    </div>
    <div class="foot-cols">
      ${groups.map((g) => html`<div><h2>${g.title}</h2>${g.links}</div>`)}
    </div>
  </div>
  <div class="wrap foot-bottom">
    <span>© ${new Date().getUTCFullYear()} LONGYU Network · Chain ID ${site.chainId}${site.publicRpc ? html` · RPC <code>${site.publicRpc}</code>` : ""}</span>
    <a href="#top">Back to top</a>
  </div>
</footer>
</body>
</html>`.value}`;
}

// ------------------------------------------------------- official tokens

/** Letters that look like those of LONG and LONGYU: digits, Cyrillic and Greek capitals, small capitals. */
const LOOKALIKE: Record<string, string> = {
  "0": "O", "О": "O", "Ο": "O", "Օ": "O", "1": "L", "|": "L", "Ӏ": "L", "Ꮮ": "L", "ʟ": "L",
  "Ν": "N", "ɴ": "N", "Ԍ": "G", "ɢ": "G", "У": "Y", "Ү": "Y", "Υ": "Y", "ʏ": "Y", "Ʋ": "U", "Џ": "U", "ᴜ": "U",
};

/** A name as it reads: compatibility forms folded, capitals, look-alikes replaced, only A to Z kept. */
export function readsAs(s: string | null): string {
  return [...(s ?? "").normalize("NFKC").toUpperCase()].map((c) => LOOKALIKE[c] ?? c).join("").replace(/[^A-Z]/g, "");
}

/** Whether a token's name or symbol passes for LONGYU's: LONG, tLONG, wLONG, or anything with LONGYU in it. */
export function passesForLongyu(t: { name: string | null; symbol: string | null }): boolean {
  return [readsAs(t.name), readsAs(t.symbol)].some((x) => ["LONG", "TLONG", "WLONG"].includes(x) || x.includes("LONGYU"));
}

/** "official" for LONGYU's own tokens, "imitation" for another that passes for one of them, otherwise null. */
export function standing(site: Site, t: { address: string; name: string | null; symbol: string | null }): "official" | "imitation" | null {
  if (!site.official?.length) return null;
  if (site.official.includes(t.address.toLowerCase())) return "official";
  return passesForLongyu(t) ? "imitation" : null;
}

/** A token's round logo (served at /logo/<token>: its creator's, LONGYU's mark, BNB's or a monogram). */
export function tokenLogo(site: Site, address: string, big = false): SafeHtml {
  const official = site.official?.includes(address.toLowerCase()) ?? false;
  return html`<img class="${`tlogo${big ? " big" : ""}${official ? " official" : ""}`}" src="${`/logo/${address.toLowerCase()}`}" alt="" width="${big ? 40 : 20}" height="${big ? 40 : 20}" loading="lazy">`;
}

/** The mark after a token's name in lists. */
function tokenMark(site: Site, t: { address: string; name: string | null; symbol: string | null }): SafeHtml | string {
  const s = standing(site, t);
  if (s === "official") return html` <span class="verified official" title="LONGYU's official token">Official</span>`;
  if (s === "imitation") return html` <span class="tag warn" title="Uses LONGYU's name; LONGYU did not create it">Not official</span>`;
  return "";
}

// --------------------------------------------------------------- pieces

const ago = (ts: bigint) => html`<time datetime="${new Date(Number(ts) * 1000).toISOString()}" data-ts="${ts}" title="${utc(ts)}">${timeAgo(ts)}</time>`;

export function addr(site: Site, a: string | null, opts: { full?: boolean; token?: boolean } = {}): SafeHtml {
  if (!a) return html`<span class="muted">–</span>`;
  const label = site.labels.get(a);
  const text = opts.full ? a : label ?? short(a, 8, 6);
  const path = opts.token ? tokenPath(a) : addressPath(a);
  return html`<a class="mono addr" href="${path}" title="${a}">${text}</a>`;
}

const txLink = (h: string, full = false) => html`<a class="mono" href="${txPath(h)}" title="${h}">${full ? h : short(h, 10, 8)}</a>`;
const blockLink = (n: bigint) => html`<a href="${blockPath(n)}">${formatNumber(n)}</a>`;
const copy = (value: string) => html`<button class="copy" type="button" data-copy="${value}" aria-label="Copy"></button>`;

function status(s: number | null): SafeHtml {
  if (s === 1) return html`<span class="pill ok">Success</span>`;
  if (s === 0) return html`<span class="pill bad">Failed</span>`;
  return html`<span class="pill">Pending</span>`;
}

function method(t: TxListRow): SafeHtml {
  if (t.type === 126) return html`<span class="tag dep">Deposit</span>`;
  if (t.contract_address) return html`<span class="tag">Create</span>`;
  if (!t.method_id) return html`<span class="tag">Transfer</span>`;
  const name = methodName(t.method_id);
  return html`<span class="tag" title="${t.method_id}">${name ?? t.method_id}</span>`;
}

function pager(base: string, page: number, hasNext: boolean, [back, on]: [string, string] = ["← Newer", "Older →"]): SafeHtml {
  const sep = base.includes("?") ? "&" : "?";
  return html`<nav class="pager" aria-label="Pages">
    ${page > 1 ? html`<a href="${`${base}${sep}p=${page - 1}`}">${back}</a>` : html`<span></span>`}
    <span class="muted">Page ${page}</span>
    ${hasNext ? html`<a href="${`${base}${sep}p=${page + 1}`}">${on}</a>` : html`<span></span>`}
  </nav>`;
}

/** A count that stops at COUNT_CAP (queries.ts). */
const count = (n: bigint) => (BigInt(n) >= BigInt(COUNT_CAP) ? `${formatNumber(COUNT_CAP)}+` : formatNumber(n));
/** Under the heading of a list that was cut at a limit. */
const cut = (p: Part<unknown>) => (p.total > p.rows.length ? html`<p class="muted">Showing the first ${formatNumber(p.rows.length)} of ${formatNumber(p.total)}.</p>` : "");

const kv = (rows: [string, unknown][]) =>
  html`<dl class="kv">${rows.filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;

function txTable(site: Site, rows: TxListRow[], opts: { block?: boolean } = { block: true }): SafeHtml {
  if (!rows.length) return html`<p class="empty">No transactions.</p>`;
  return html`<div class="table"><table>
    <thead><tr><th>Transaction</th><th>Method</th>${opts.block ? html`<th>Block</th>` : ""}<th>Age</th><th>From</th><th>To</th><th class="r">Value (${site.native})</th></tr></thead>
    <tbody>${rows.map((t) => html`<tr class="${t.status === 0 ? "failed" : ""}">
      <td>${txLink(t.hash)}</td><td>${method(t)}</td>${opts.block ? html`<td>${blockLink(t.block_number)}</td>` : ""}
      <td>${ago(t.timestamp)}</td><td>${addr(site, t.from_address)}</td>
      <td>${t.contract_address ? html`<span class="muted">New</span> ${addr(site, t.contract_address)}` : addr(site, t.to_address)}</td>
      <td class="r num">${formatUnits(t.value, 18)}</td></tr>`)}</tbody></table></div>`;
}

function transferTable(site: Site, rows: TransferRow[], showToken = true): SafeHtml {
  if (!rows.length) return html`<p class="empty">No token transfers.</p>`;
  return html`<div class="table"><table>
    <thead><tr><th>Transaction</th><th>Age</th><th>From</th><th>To</th><th class="r">Amount</th>${showToken ? html`<th>Token</th>` : ""}</tr></thead>
    <tbody>${rows.map((x) => html`<tr>
      <td>${txLink(x.tx_hash)}</td><td>${ago(x.timestamp)}</td><td>${addr(site, x.from_address)}</td><td>${addr(site, x.to_address)}</td>
      <td class="r num">${x.kind === "erc721" ? html`#${x.token_id}` : formatUnits(x.value, x.decimals)}</td>
      ${showToken ? html`<td><a href="${tokenPath(x.token)}">${x.symbol ?? short(x.token)}</a></td>` : ""}</tr>`)}</tbody></table></div>`;
}

export type TokenInfo = { decimals: number | null; symbol: string | null };
const AMOUNT_ARGS = new Set(["value", "amount", "wad", "_value", "_amount"]);

function argValue(site: Site, a: DecodedArg, token?: TokenInfo): SafeHtml {
  const v = a.value;
  if (token && token.decimals !== null && typeof v === "bigint" && a.type === "uint256" && AMOUNT_ARGS.has(a.name)) {
    return html`<span class="num" title="${v.toString()}">${formatUnits(v, token.decimals, 18)}</span> <span class="muted">${token.symbol ?? ""}</span>`;
  }
  if (a.type === "address" && typeof v === "string" && isAddress(v.toLowerCase())) return addr(site, v.toLowerCase(), { full: true });
  if (typeof v === "bigint") return html`<span class="num">${v.toString()}</span>`;
  if (typeof v === "string") return html`<span class="mono break">${v}</span>`;
  return html`<span class="mono break">${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))}</span>`;
}

// ---------------------------------------------------------------- pages

export interface HomeStats {
  head: { number: bigint; timestamp: bigint; base_fee: string | null } | null;
  transactions: bigint;
  tokens: bigint;
  blockTime: number | null;
  gasPrice: string | null;
  /** Transactions in the last 24 hours. */
  lastDay?: bigint | null;
  /** Transactions a day (days since 1970, UTC), for the days that had any. */
  days?: { day: number; count: number }[];
}

const dayLabel = (day: number) => new Date(day * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** A bar for each of the last CHART_DAYS days. A day without transactions is a mark on the baseline. */
function chart(days: { day: number; count: number }[], now: number): SafeHtml {
  const today = Math.floor(now / 86_400);
  const byDay = new Map(days.map((d) => [d.day, d.count]));
  const slots = Array.from({ length: CHART_DAYS }, (_, i) => {
    const day = today - (CHART_DAYS - 1) + i;
    return { day, count: byDay.get(day) ?? 0 };
  });
  const most = Math.max(0, ...slots.map((d) => d.count));
  const [W, H, STEP, BAR] = [280, 64, 20, 12];
  return html`<div class="chart">
      <div class="chart-h"><span>Transactions, ${CHART_DAYS} days</span><span>Most in a day <strong>${formatNumber(most)}</strong></span></div>
      <svg viewBox="${`0 0 ${W} ${H}`}" role="img" aria-label="${`Transactions a day over the last ${CHART_DAYS} days`}">${slots.map((d, i) => {
        const h = d.count === 0 ? 2 : Math.max(4, Math.round((d.count / most) * H));
        return html`<rect class="${d.count === 0 ? "bar zero" : "bar"}" x="${i * STEP + (STEP - BAR) / 2}" y="${H - h}" width="${BAR}" height="${h}" rx="2"><title>${dayLabel(d.day)}: ${formatNumber(d.count)}</title></rect>`;
      })}</svg>
      <div class="chart-x"><span>${dayLabel(slots[0]!.day)}</span><span>${dayLabel(slots[slots.length - 1]!.day)}</span></div>
    </div>`;
}

const blockRow = (b: BlockRow) => html`<li>
        <span class="tile bk"></span>
        <span class="id">${blockLink(b.number)}${ago(b.timestamp)}</span>
        <span class="side"><span>${formatNumber(b.tx_count)} ${Number(b.tx_count) === 1 ? "txn" : "txns"}</span><span class="muted">Gas used ${percent(BigInt(b.gas_used), BigInt(b.gas_limit))}</span></span></li>`;

const txRow = (site: Site, t: TxListRow) => html`<li>
        <span class="tile tx"></span>
        <span class="id"><a class="mono" href="${txPath(t.hash)}" title="${t.hash}">${short(t.hash, 8, 6)}</a>${ago(t.timestamp)}</span>
        <span class="who"><span><span class="muted">From</span> ${addr(site, t.from_address)}</span><span><span class="muted">${t.contract_address ? "New" : "To"}</span> ${addr(site, t.contract_address ?? t.to_address)}</span></span>
        <span class="amt num">${formatUnits(t.value, 18)} ${site.native}</span></li>`;

export function homePage(site: Site, s: HomeStats, blocks: BlockRow[], txs: TxListRow[], now: number = Date.now() / 1000): SafeHtml {
  const fact = (k: string, v: unknown, note: unknown = "") => html`<div><span>${k}</span><strong>${v}${note ? html` <small>${note}</small>` : ""}</strong></div>`;
  // Names for the addresses in the list, for the script that keeps it current.
  const labels = JSON.stringify(Object.fromEntries(site.labels));
  return html`
  <section class="overview">
    <div class="facts">
      ${fact("Latest block", html`<span id="stat-height">${s.head ? formatNumber(s.head.number) : "–"}</span>`, s.blockTime === null ? "" : `${s.blockTime.toFixed(s.blockTime < 1 ? 2 : 1)} s`)}
      ${fact("Transactions", formatNumber(s.transactions), s.lastDay === null || s.lastDay === undefined ? "" : `${formatNumber(s.lastDay)} in 24 h`)}
      ${fact("Gas price", formatGasPrice(s.gasPrice))}
      ${fact("Tokens", html`<a href="/tokens">${formatNumber(s.tokens)}</a>`)}
      ${fact("Chain ID", html`${site.chainId}${copy(String(site.chainId))}`)}
      ${fact("Settles on", html`<a href="${site.l1Explorer}" rel="noopener">${l1Name(site)}</a>`)}
    </div>
    ${chart(s.days ?? [], now)}
  </section>
  <div class="grid2">
    <section class="card list">
      <header class="card-h"><h2>Latest blocks</h2></header>
      <ul class="rows three" id="feed-blocks">${blocks.slice(0, HOME_ROWS).map(blockRow)}</ul>
      <a class="more" href="/blocks">View all blocks</a>
    </section>
    <section class="card list">
      <header class="card-h"><h2>Latest transactions</h2></header>
      <ul class="rows" id="feed-txs" data-labels="${labels}">${txs.slice(0, HOME_ROWS).map((t) => txRow(site, t))}</ul>
      <a class="more" href="/txs">View all transactions</a>
    </section>
  </div>`;
}

export function blocksPage(site: Site, rows: BlockRow[], page: number): SafeHtml {
  return html`<h1>Blocks</h1>
  <div class="table"><table><thead><tr><th>Block</th><th>Age</th><th class="r">Txns</th><th class="r">Gas used</th><th class="r">Base fee</th></tr></thead>
  <tbody>${rows.map((b) => html`<tr><td>${blockLink(b.number)}</td><td>${ago(b.timestamp)}</td><td class="r num">${b.tx_count}</td>
    <td class="r num">${formatNumber(b.gas_used)} <span class="muted">${percent(BigInt(b.gas_used), BigInt(b.gas_limit))}</span></td>
    <td class="r num">${formatGasPrice(b.base_fee)}</td></tr>`)}</tbody></table></div>
  ${pager("/blocks", page, rows.length === PAGE_SIZE)}`;
}

export function blockPage(site: Site, b: BlockRow, txs: TxListRow[], hasNext: boolean, page = 1): SafeHtml {
  return html`<div class="title-row"><h1>Block <span class="num">#${formatNumber(b.number)}</span></h1>
    <span class="nav-arrows">${b.number > 0n ? html`<a href="${blockPath(b.number - 1n)}" aria-label="Previous block">‹</a>` : ""}${hasNext ? html`<a href="${blockPath(b.number + 1n)}" aria-label="Next block">›</a>` : ""}</span></div>
  <section class="card">${kv([
    ["Hash", html`<span class="mono break">${b.hash}</span>${copy(b.hash)}`],
    ["Parent", b.number > 0n ? html`<a class="mono break" href="${blockPath(b.number - 1n)}">${b.parent_hash}</a>` : html`<span class="mono break">${b.parent_hash}</span>`],
    ["Time", html`${ago(b.timestamp)} <span class="muted">${utc(b.timestamp)}</span>`],
    ["Transactions", formatNumber(b.tx_count)],
    ["Gas used", html`${formatNumber(b.gas_used)} <span class="muted">of ${formatNumber(b.gas_limit)} (${percent(BigInt(b.gas_used), BigInt(b.gas_limit))})</span>`],
    ["Base fee", formatGasPrice(b.base_fee)],
    ["Fee recipient", addr(site, b.miner, { full: true })],
    ["Size", b.size === null ? null : `${formatNumber(b.size)} bytes`],
  ])}</section>
  <h2>Transactions</h2>${txTable(site, txs, { block: false })}
  ${b.tx_count > PAGE_SIZE ? pager(blockPath(b.number), page, page * PAGE_SIZE < b.tx_count, ["← Previous", "Next →"]) : ""}`;
}

export function txsPage(site: Site, rows: TxListRow[], page: number): SafeHtml {
  return html`<h1>Transactions</h1>${txTable(site, rows)}${pager("/txs", page, rows.length === PAGE_SIZE)}`;
}

/** `logs` and `transfers` are the first of the transaction's, with how many it has in all (queries.ts). */
export function txPage(site: Site, t: TxRow, logs: Part<LogRow>, transfers: Part<TransferRow>, head: bigint | null, tokens: Map<string, TokenInfo> = new Map()): SafeHtml {
  const fee = t.type === 126 ? 0n : BigInt(t.gas_used ?? "0") * BigInt(t.gas_price ?? "0") + BigInt(t.l1_fee ?? "0");
  const call = decodeCall(t.input);
  const confirmations = head !== null ? head - t.block_number + 1n : null;
  // The deposit each block starts with is the sequencer's own, not a bridge deposit.
  const system = t.type === 126 && t.from_address === SYSTEM_DEPOSITOR;
  return html`<div class="title-row"><h1>Transaction</h1>${status(t.status)}</div>
  <section class="card">${kv([
    ["Hash", html`<span class="mono break">${t.hash}</span>${copy(t.hash)}`],
    ["Block", html`${blockLink(t.block_number)}${confirmations !== null ? html` <span class="muted">${formatNumber(confirmations)} ${confirmations === 1n ? "confirmation" : "confirmations"}</span>` : ""}`],
    ["Time", html`${ago(t.timestamp)} <span class="muted">${utc(t.timestamp)}</span>`],
    ["Type", system ? html`<span class="tag">System</span>` : t.type === 126 ? html`<span class="tag dep">Deposit from BSC</span>` : `Type ${t.type}`],
    ["From", html`${addr(site, t.from_address, { full: true })}${copy(t.from_address)}`],
    t.contract_address ? ["Contract created", html`${addr(site, t.contract_address, { full: true })}${copy(t.contract_address)}`] : ["To", addr(site, t.to_address, { full: true })],
    ["Value", html`<span class="num">${formatUnits(t.value, 18, 18)}</span> ${site.native}`],
    t.mint && t.mint !== "0" ? ["Minted from BSC", html`<span class="num">${formatUnits(t.mint, 18, 18)}</span> ${site.native}`] : ["", null],
    ["Fee", system ? "None" : t.type === 126 ? "None (paid on BSC)" : html`<span class="num">${formatUnits(fee, 18, 18)}</span> ${site.native}${t.l1_fee ? html` <span class="muted">incl. ${formatUnits(t.l1_fee, 18, 18)} for BSC data</span>` : ""}`],
    ["Gas", html`${t.gas_used ? formatNumber(t.gas_used) : "–"} <span class="muted">of ${formatNumber(t.gas_limit)} at ${formatGasPrice(t.gas_price)}</span>`],
    ["Nonce", formatNumber(t.nonce)],
    t.source_hash ? ["Source hash", html`<span class="mono break">${t.source_hash}</span>`] : ["", null],
  ])}</section>
  ${call ? html`<h2>Call</h2><section class="card"><p class="call"><strong>${call.name}</strong></p>${kv(call.args.map((a) => [`${a.name} (${a.type})`, argValue(site, a, t.to_address ? tokens.get(t.to_address) : undefined)]))}</section>` : ""}
  ${transfers.rows.length ? html`<h2>Token transfers</h2>${cut(transfers)}${transferTable(site, transfers.rows)}` : ""}
  ${logs.rows.length ? html`<h2>Events <span class="muted">${formatNumber(logs.total)}</span></h2>${cut(logs)}${logs.rows.map((l) => {
    const d = decodeLog([l.topic0, l.topic1, l.topic2, l.topic3], l.data);
    return html`<section class="card log"><header class="card-h"><span><span class="muted">#${l.log_index}</span> ${d ? html`<strong>${d.name}</strong>` : html`<span class="muted">Unknown event</span>`}</span>${addr(site, l.address)}</header>
      ${d ? kv(d.args.map((a) => [a.name, argValue(site, a, tokens.get(l.address))])) : kv([["Topics", html`${[l.topic0, l.topic1, l.topic2, l.topic3].filter(Boolean).map((x) => html`<div class="mono break">${x}</div>`)}`], ["Data", html`<span class="mono break">${l.data}</span>${l.data_bytes > DATA_BYTES ? html`<div class="muted">The first ${formatNumber(DATA_BYTES)} of ${formatNumber(l.data_bytes)} bytes</div>` : ""}`]])}</section>`;
  })}` : ""}
  <details class="card raw"><summary>Input data <span class="muted">${formatNumber((t.input.length - 2) / 2)} bytes</span></summary><pre class="mono break">${t.input}</pre></details>`;
}

export function addressPage(
  site: Site,
  a: string,
  d: {
    balance: bigint | null;
    isContract: boolean;
    txCount: bigint;
    creation: { hash: string; from_address: string } | null;
    token: TokenRow | null;
    tab: "txs" | "transfers" | "tokens" | "contract";
    page: number;
    txs: TxListRow[];
    transfers: TransferRow[];
    holdings: { token: string; balance: string; name: string | null; symbol: string | null; decimals: number | null; kind: string }[];
    /** The Contract tab, for an address that has code. */
    contract?: ContractTab | null;
  },
): SafeHtml {
  const label = site.labels.get(a);
  const tabs: [string, string, string][] = [["txs", "Transactions", ""], ["transfers", "Token transfers", ""], ["tokens", `Tokens (${d.holdings.length})`, ""]];
  if (d.contract) tabs.push(["contract", "Contract", d.contract.verified ? "verified" : ""]);
  // LONGYU's own token is marked here too, also before its first transfer makes it a listed token.
  const official = site.official?.includes(a.toLowerCase()) ?? false;
  const imitation = !official && d.token !== null && standing(site, d.token) === "imitation";
  const real = site.official?.[0];
  return html`<div class="title-row"><h1>${d.isContract ? "Contract" : "Address"}</h1>${label ? html`<span class="pill blue">${label}</span>` : ""}${official ? html`<span class="verified official">Official LONGYU token</span>` : ""}</div>
  <p class="mono break lead">${a}${copy(a)}</p>
  ${official && site.officialNote ? html`<section class="card note">${site.officialNote}</section>` : ""}
  ${imitation && real ? html`<section class="card warning" role="alert"><strong>Not LONGYU's token.</strong> This token uses LONGYU's name, but LONGYU did not create it. The only official LONG is <a class="mono break" href="${addressPath(real)}">${real}</a>.${site.officialNote ? html` ${site.officialNote}` : ""}</section>` : ""}
  <section class="stats compact">
    <div><span>Balance</span><strong>${d.balance === null ? "–" : formatUnits(d.balance, 18)} <small>${site.native}</small></strong></div>
    <div><span>Transactions</span><strong>${count(d.txCount)}</strong></div>
    <div><span>Tokens</span><strong>${d.holdings.length}</strong></div>
  </section>
  ${d.creation || d.token ? html`<section class="card">${kv([
    d.creation ? ["Created by", html`${addr(site, d.creation.from_address)} in ${txLink(d.creation.hash)}`] : ["", null],
    d.token ? ["Token", html`<a href="${tokenPath(d.token.address)}">${d.token.name ?? "Unnamed"} (${d.token.symbol ?? "?"})</a>${tokenMark(site, d.token)}`] : ["", null],
  ])}</section>` : ""}
  <nav class="tabs">${tabs.map(([k, l, mark]) => html`<a href="${`${addressPath(a)}?tab=${k}`}" class="${d.tab === k ? "on" : ""}">${mark ? html`<span class="${mark}">${l}</span>` : l}</a>`)}</nav>
  ${d.tab === "contract" && d.contract ? contractTab(a, d.contract) : ""}
  ${d.tab === "txs" ? html`${txTable(site, d.txs)}${pager(`${addressPath(a)}?tab=txs`, d.page, d.txs.length === PAGE_SIZE)}` : ""}
  ${d.tab === "transfers" ? html`${transferTable(site, d.transfers)}${pager(`${addressPath(a)}?tab=transfers`, d.page, d.transfers.length === PAGE_SIZE)}` : ""}
  ${d.tab === "tokens" ? (d.holdings.length ? html`<div class="table"><table><thead><tr><th>Token</th><th class="r">Balance</th></tr></thead><tbody>
    ${d.holdings.map((h) => html`<tr><td>${tokenLogo(site, h.token)}<a href="${tokenPath(h.token)}">${h.name ?? short(h.token)}</a> <span class="muted">${h.symbol ?? ""}</span>${tokenMark(site, { address: h.token, name: h.name, symbol: h.symbol })}</td>
    <td class="r num">${h.kind === "erc721" ? h.balance : formatUnits(h.balance, h.decimals)}</td></tr>`)}</tbody></table></div>` : html`<p class="empty">No tokens.</p>`) : ""}`;
}

export function tokensPage(site: Site, rows: TokenRow[], page: number): SafeHtml {
  return html`<h1>Tokens</h1>
  <div class="table"><table><thead><tr><th>Token</th><th>Type</th><th class="r">Holders</th><th class="r">Transfers</th><th>Contract</th></tr></thead>
  <tbody>${rows.map((t) => html`<tr><td>${tokenLogo(site, t.address)}<a href="${tokenPath(t.address)}"><strong>${t.name ?? "Unnamed"}</strong></a> <span class="muted">${t.symbol ?? ""}</span>${tokenMark(site, t)}</td>
    <td>${t.kind === "erc721" ? "ERC-721" : "ERC-20"}</td><td class="r num">${count(t.holders)}</td><td class="r num">${count(t.transfers)}</td>
    <td>${addr(site, t.address)}</td></tr>`)}</tbody></table></div>
  ${pager("/tokens", page, rows.length === PAGE_SIZE)}`;
}

export function tokenPage(
  site: Site,
  t: TokenRow,
  d: { supply: bigint | null; launched?: boolean; tab: "transfers" | "holders"; page: number; transfers: TransferRow[]; holders: { holder: string; balance: string }[] },
): SafeHtml {
  const tabs = [["transfers", "Transfers"], ["holders", "Holders"]] as const;
  const s = standing(site, t);
  const real = site.official?.[0];
  return html`<div class="title-row">${tokenLogo(site, t.address, true)}<h1>${t.name ?? "Unnamed token"}</h1><span class="pill blue">${t.symbol ?? "?"}</span>${s === "official" ? html`<span class="verified official">Official LONGYU token</span>` : ""}</div>
  <p class="mono break lead">${t.address}${copy(t.address)}</p>
  ${s === "official" && site.officialNote ? html`<section class="card note">${site.officialNote}</section>` : ""}
  ${s === "imitation" && real ? html`<section class="card warning" role="alert"><strong>Not LONGYU's token.</strong> This token uses LONGYU's name, but LONGYU did not create it. The only official LONG is <a class="mono break" href="${tokenPath(real)}">${real}</a>.${site.officialNote ? html` ${site.officialNote}` : ""}</section>` : ""}
  ${d.launched && s !== "imitation" ? html`<section class="card note">Made with LONGYU Launch: a fixed supply minted once to its creator. It has no owner, and nobody can mint more or change it.</section>` : ""}
  <section class="stats compact">
    <div><span>Total supply</span><strong class="num">${d.supply === null ? "–" : formatUnits(d.supply, t.kind === "erc721" ? 0 : t.decimals, 2)}</strong></div>
    <div><span>Holders</span><strong>${count(t.holders)}</strong></div>
    <div><span>Transfers</span><strong>${count(t.transfers)}</strong></div>
    <div><span>Type</span><strong>${t.kind === "erc721" ? "ERC-721" : `ERC-20 · ${t.decimals ?? "?"} dp`}</strong></div>
  </section>
  <nav class="tabs">${tabs.map(([k, l]) => html`<a href="${`${tokenPath(t.address)}?tab=${k}`}" class="${d.tab === k ? "on" : ""}">${l}</a>`)}</nav>
  ${d.tab === "transfers" ? html`${transferTable(site, d.transfers, false)}${pager(`${tokenPath(t.address)}?tab=transfers`, d.page, d.transfers.length === PAGE_SIZE)}` : ""}
  ${d.tab === "holders" ? html`<div class="table"><table><thead><tr><th>#</th><th>Holder</th><th class="r">Balance</th><th class="r">Share</th></tr></thead><tbody>
    ${d.holders.map((h, i) => html`<tr><td class="muted">${(d.page - 1) * PAGE_SIZE + i + 1}</td><td>${addr(site, h.holder)}</td>
    <td class="r num">${t.kind === "erc721" ? h.balance : formatUnits(h.balance, t.decimals)}</td>
    <td class="r num">${d.supply ? percent(BigInt(h.balance), d.supply) : "–"}</td></tr>`)}</tbody></table></div>
    ${pager(`${tokenPath(t.address)}?tab=holders`, d.page, d.holders.length === PAGE_SIZE)}` : ""}`;
}

/** What crossed the bridge with a deposit or a withdrawal: the native coin, a token (decode.ts bridgedToken), both, or only a message. */
function bridged(site: Site, native: bigint, b: BridgedToken | null, tokens: Map<string, TokenInfo>): SafeHtml {
  const info = b ? tokens.get(b.token) : undefined;
  const amounts = [
    native > 0n ? html`<span class="num">${formatUnits(native, 18)} ${site.native}</span>` : null,
    b ? html`<span class="num">${formatUnits(b.amount, info?.decimals ?? null)}</span> <a href="${tokenPath(b.token)}">${info?.symbol ?? short(b.token)}</a>` : null,
  ].filter((x) => x !== null);
  return amounts.length === 2 ? html`${amounts[0]} + ${amounts[1]}` : amounts[0] ?? html`<span class="muted">Message</span>`;
}

/** `bridged` on each row is the token it carried, if any; `tokens` holds those tokens' symbols and decimals. */
export function bridgePage(
  site: Site,
  deposits: (TxListRow & { bridged: BridgedToken | null })[],
  withdrawals: (LogRow & { tx_hash: string; timestamp: bigint; bridged: BridgedToken | null })[],
  tokens: Map<string, TokenInfo> = new Map(),
): SafeHtml {
  return html`<div class="title-row"><h1>Bridge</h1><a class="button" href="${site.bridgeUrl}" rel="noopener">Open bridge</a></div>
  <div class="grid2">
    <section class="card list"><header class="card-h"><h2>Deposits from ${l1Name(site)}</h2></header>
      ${deposits.length ? html`<ul class="rows three">${deposits.map((t) => html`<li><span class="tile in"></span>
        <span class="id">${txLink(t.hash)}${ago(t.timestamp)}</span>
        <span class="side"><span>${addr(site, t.to_address)}</span><span>${bridged(site, BigInt(t.mint ?? t.value), t.bridged, tokens)}</span></span></li>`)}</ul>` : html`<p class="empty">No deposits yet.</p>`}
    </section>
    <section class="card list"><header class="card-h"><h2>Withdrawals to ${l1Name(site)}</h2></header>
      ${withdrawals.length ? html`<ul class="rows three">${withdrawals.map((w) => {
        const d = decodeLog([w.topic0, w.topic1, w.topic2, w.topic3], w.data);
        const sender = d?.args.find((a) => a.name === "sender")?.value;
        const value = d?.args.find((a) => a.name === "value")?.value;
        return html`<li><span class="tile out"></span>
          <span class="id">${txLink(w.tx_hash)}${ago(w.timestamp)}</span>
          <span class="side"><span>${typeof sender === "string" ? addr(site, sender.toLowerCase()) : ""}</span><span>${bridged(site, typeof value === "bigint" ? value : 0n, w.bridged, tokens)}</span></span></li>`;
      })}</ul>` : html`<p class="empty">No withdrawals yet.</p>`}
    </section>
  </div>`;
}

export function searchPage(q: string, tokens: { address: string; name: string | null; symbol: string | null }[], site?: Site): SafeHtml {
  return html`<h1>Search</h1>
  ${tokens.length ? html`<ul class="results">${tokens.map((t) => html`<li>${site ? tokenLogo(site, t.address) : ""}<a href="${tokenPath(t.address)}"><strong>${t.name ?? "Unnamed"}</strong> <span class="muted">${t.symbol ?? ""}</span></a>${site ? tokenMark(site, t) : ""} <span class="mono muted">${short(t.address, 8, 6)}</span></li>`)}</ul>`
    : html`<p class="empty">Nothing found for <strong>${q}</strong>.</p>`}`;
}

/** The page for a request that has no page of its own: nothing there, too many requests, or an error. */
export function notFoundPage(what: string, heading = "Not found"): SafeHtml {
  return html`<section class="notfound"><img class="mark big" src="/static/mark.svg" alt="" width="45" height="56"><h1>${heading}</h1><p class="muted">${what}</p><a class="button" href="/">Home</a></section>`;
}

export function apiDocsPage(site: Site): SafeHtml {
  const rows: [string, string][] = [
    ["GET /api/v1/stats", "Height, base fee, transaction count, token count, block time"],
    ["GET /api/v1/blocks?p=", "Latest blocks"],
    ["GET /api/v1/block/{number|hash}?p=", `A block with its transactions, ${PAGE_SIZE} a page`],
    ["GET /api/v1/txs?p=", "Latest transactions"],
    ["GET /api/v1/tx/{hash}", `Transaction, decoded call, its first ${TX_ITEMS} events and token transfers, the count of each`],
    ["GET /api/v1/address/{address}", "Balance and counts"],
    ["GET /api/v1/address/{address}/txs?p=", "Transactions"],
    ["GET /api/v1/address/{address}/transfers?p=", "Token transfers"],
    ["GET /api/v1/address/{address}/tokens", "Token balances"],
    ["GET /api/v1/tokens?p=", "Tokens"],
    ["GET /api/v1/token/{address}", "Token, supply, holders"],
    ["GET /api/v1/token/{address}/holders?p=", "Top holders"],
    ["GET /api?module=account&action=balance|txlist|tokentx|tokenbalance", "Etherscan-compatible"],
    ["GET /api?module=stats&action=tokensupply&contractaddress=", "Etherscan-compatible"],
    ["GET /api?module=contract&action=getabi|getsourcecode&address=", "Etherscan-compatible. A verified contract's ABI, or its source, compiler and settings"],
    ["POST /api module=contract action=verifysourcecode", "Etherscan-compatible, as Foundry and Hardhat send it. Answers with a guid"],
    ["GET /api?module=contract&action=checkverifystatus&guid=", "Etherscan-compatible. The state of a verification, kept for an hour"],
  ];
  return html`<h1>API</h1>
  <p class="muted">JSON over HTTPS, no key. ${site.chainName}, chain ID ${site.chainId}. Amounts are integers in the smallest unit, as strings. Lists leave out a transaction's input data, except the Etherscan-compatible txlist, which gives its first ${formatNumber(DATA_BYTES)} bytes and at most 100 transactions a page. Counts of transactions, holders and transfers stop at ${formatNumber(COUNT_CAP)}.</p>
  <div class="table"><table><tbody>${rows.map(([e, d]) => html`<tr><td class="mono">${e}</td><td>${d}</td></tr>`)}</tbody></table></div>`;
}

export { PREDEPLOYS };
