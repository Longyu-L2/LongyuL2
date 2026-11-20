/**
 * LONGYU Scan's web server: pages, the JSON API, an Etherscan-compatible API and static files.
 * Nothing here writes to the chain. The one thing a visitor can add to the database is a contract's
 * source, and only after the explorer has compiled it and found the contract's own bytecode (verify/).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { keccak256 } from "viem";
import type { Config } from "./config.ts";
import type { Db, Queryable } from "./db.ts";
import { bridgedToken, decodeCall, decodeLog, methodName, PREDEPLOYS } from "./decode.ts";
import { isSystemTx } from "./indexer.ts";
import * as Q from "./queries.ts";
import { hex, type Hex, type RawBlock, type RawReceipt, type RawTx, type Rpc } from "./rpc.ts";
import { cleanText, totalSupply } from "./tokens.ts";
import { isolatedCompiler, LIMITS, type Compile } from "./verify/compile.ts";
import { CompilerStore, type CompilerBuild } from "./verify/compilers.ts";
import { Verifier } from "./verify/service.ts";
import { verifyPage, verifyStatusPage, type VerifyForm } from "./web/verify.ts";
import { addressPage, apiDocsPage, blockPage, blocksPage, bridgePage, CHART_DAYS, HOME_ROWS, homePage, layout, notFoundPage, PAGE_SIZE, searchPage, tokenPage, tokensPage, txPage, txsPage, type Site } from "./web/pages.ts";
import { addressPath, blockPath, isAddress, isHash, tokenPath, txPath } from "./web/html.ts";

export interface AppDeps {
  db: Db;
  rpc: Rpc;
  config: Config;
  /** Stand-ins for the compiler and its download, for tests. */
  verify?: { compile?: Compile; loadCompiler?: (build: CompilerBuild) => Promise<Buffer> };
}

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** Static files are read once at start, so a request path can never reach the file system. */
function loadStatic(): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (TYPES[extname(entry.name)]) files.set(`${prefix}${entry.name}`, { body: readFileSync(join(dir, entry.name)), type: TYPES[extname(entry.name)]! });
    }
  };
  walk(PUBLIC, "");
  return files;
}

function fingerprint(files: Map<string, { body: Buffer }>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) hash.update(name).update(files.get(name)!.body);
  return hash.digest("hex").slice(0, 12);
}

export function siteOf(config: Config, build = ""): Site {
  const labels = new Map(Object.entries(PREDEPLOYS));
  for (const pair of config.KNOWN_ADDRESSES.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    const address = pair.slice(0, i).trim().toLowerCase();
    const label = cleanText(pair.slice(i + 1), 40);
    if (i > 0 && isAddress(address) && label) labels.set(address, label);
  }
  return {
    chainName: config.CHAIN_NAME,
    chainId: config.CHAIN_ID,
    native: config.NATIVE_SYMBOL,
    l1Explorer: config.L1_EXPLORER_URL,
    bridgeUrl: config.BRIDGE_URL,
    swapUrl: config.SWAP_URL ?? null,
    publicRpc: config.PUBLIC_RPC_URL ?? null,
    websiteUrl: config.WEBSITE_URL ?? null,
    mineUrl: config.MINE_URL ?? null,
    developersUrl: config.DEVELOPERS_URL ?? null,
    githubUrl: config.GITHUB_URL ?? null,
    verification: config.VERIFICATION,
    labels,
    build,
  };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const pageOf = (q: unknown) => {
  const n = Number((q as { p?: string }).p ?? 1);
  return Number.isInteger(n) && n >= 1 && n <= 400 ? n : 1;
};
const normAddress = (s: string) => (/^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null);
const normHash = (s: string) => (/^0x[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : null);

/** The database cancels a visitor's query that runs longer than this. */
const QUERY_TIMEOUT_MS = 5_000;
/** Most transactions in a page of the Etherscan-compatible txlist: each can carry Q.DATA_BYTES bytes of calldata. */
const TXLIST_ROWS = 100;
/** The largest verification request: a project's sources in one standard JSON input, sent as a form. */
const VERIFY_BODY_BYTES = 4 * 1024 * 1024;
/** A request body past this size is counted as an upload of source. */
const SMALL_BODY_BYTES = 2048;
/** Per visitor, each minute: uploads of source, verifications asked for, and readings of a verified source. */
const UPLOADS_A_MINUTE = 6;
const SOURCE_READS_A_MINUTE = 30;

/** Counts by key within a window; false once a key has had its share. */
function limiter(max: number, windowMs: number): (key: string) => boolean {
  const seen = new Map<string, { n: number; until: number }>();
  return (key) => {
    const now = Date.now();
    if (seen.size >= 20_000) for (const [k, v] of seen) if (v.until <= now) seen.delete(k);
    if (seen.size >= 20_000) seen.clear();
    const has = seen.get(key);
    if (!has || has.until <= now) {
      seen.set(key, { n: 1, until: now + windowMs });
      return true;
    }
    return ++has.n <= max;
  };
}

/**
 * The address a rate limit counts by: an IPv4 address as it is, an IPv6 address by its /64 network
 * (one subscriber holds a whole /64). Returns null when the text is not an address.
 */
export function clientKey(text: string): string | null {
  const ip = text.trim();
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  const bare = ip.split("%")[0]!.toLowerCase();
  // An IPv4 address written inside IPv6 (::ffff:203.0.113.5) counts as that IPv4 address.
  const mapped = /^(?:::ffff:|0{1,4}(?::0{1,4}){4}:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const [head = "", tail] = bare.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  // A dotted IPv4 ending takes the place of the last two groups.
  const groups = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const missing = tail === undefined ? 0 : 8 - groups(left) - groups(right);
  const all = [...left, ...Array<string>(Math.max(missing, 0)).fill("0"), ...right];
  return `${all.slice(0, 4).map((g) => (g.includes(".") ? "0" : g.replace(/^0+(?=.)/, ""))).join(":")}::/64`;
}

/**
 * An answer that is read once and then given to everyone who asks in the next `ms`. Those who ask
 * while it is being read wait for that same reading, so however many ask, the work is done once. A
 * reading that failed is given out for as long as one that worked.
 */
function held<K, T>(ms: number, read: (key: K) => Promise<T>): (key: K) => Promise<T> {
  const kept = new Map<K, { at: number | null; value: Promise<T> }>();
  return (key) => {
    const now = Date.now();
    const has = kept.get(key);
    if (has && (has.at === null || now - has.at < ms)) return has.value;
    for (const [k, v] of kept) if (v.at !== null && now - v.at >= ms) kept.delete(k);
    const entry = { at: null as number | null, value: read(key) };
    const done = () => {
      entry.at = Date.now();
    };
    entry.value.then(done, done);
    kept.set(key, entry);
    return entry.value;
  };
}

/** The fields the Etherscan-compatible API reads outside its contract module, and those of the verification form. */
const ETHERSCAN_FIELDS = ["module", "action", "address", "contractaddress", "page", "offset", "sort", "startblock", "endblock"] as const;
const VERIFY_FIELDS = ["contractaddress", "compilerversion", "codeformat", "contractname", "optimizationUsed", "runs", "evmversion", "viaIR", "sourceCode"] as const;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { rpc, config } = deps;
  // Everything here reads on a visitor's behalf; the indexer keeps the connections that have no limit.
  const db: Queryable = deps.db.timed?.(QUERY_TIMEOUT_MS) ?? deps.db;
  const files = loadStatic();
  const site = siteOf(config, fingerprint(files));
  const trustProxy = config.TRUST_PROXY === "false" ? false : config.TRUST_PROXY.split(",").map((s) => s.trim());
  const app = Fastify({ logger: config.NODE_ENV === "production" ? { level: "info" } : false, trustProxy, bodyLimit: 1024 });

  // Verification requests come as forms: Etherscan's API as Foundry and Hardhat speak it, and the page's own form.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, new URLSearchParams(body as string)));
  app.setReplySerializer((payload) => JSON.stringify(payload, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  // Behind Cloudflare on a host whose origin is public (Railway), only requests carrying the secret
  // Cloudflare adds are served; anything else reached the origin directly and could name any visitor.
  const originSecret = config.ORIGIN_SECRET ? Buffer.from(config.ORIGIN_SECRET) : null;
  if (originSecret) {
    app.addHook("onRequest", async (req, reply) => {
      if (req.method === "GET" && req.url === "/health") return; // the platform's health check
      const got = req.headers["x-longyu-origin"];
      const value = Buffer.from(typeof got === "string" ? got : "");
      if (value.length !== originSecret.length || !timingSafeEqual(value, originSecret)) {
        return reply.code(403).send({ error: "origin_required" });
      }
    });
  }
  const visitor = (req: FastifyRequest) => {
    const cf = req.headers["cf-connecting-ip"];
    const address = originSecret && typeof cf === "string" && cf !== "" ? cf : req.ip;
    return clientKey(address) ?? address;
  };
  await app.register(rateLimit, {
    max: config.RATE_LIMIT,
    timeWindow: "1 minute",
    keyGenerator: visitor,
    allowList: (req) => req.url.startsWith("/static/") || req.url === "/health",
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "DENY");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header("strict-transport-security", "max-age=31536000");
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/html")) reply.header("content-security-policy", CSP);
    if (req.url.startsWith("/api")) reply.header("access-control-allow-origin", "*");
    return payload;
  });

  const page = (reply: FastifyReply, title: string, body: Parameters<typeof layout>[2], active = "", status = 200) =>
    reply.code(status).header("cache-control", status === 200 ? "public, max-age=2" : "no-store").type("text/html; charset=utf-8").send(layout(site, title, body, active));
  /** A page that is one visitor's own, such as the state of their verification. */
  const fresh = (reply: FastifyReply, title: string, body: Parameters<typeof layout>[2], status = 200, refresh?: number) =>
    reply.code(status).header("cache-control", "no-store").type("text/html; charset=utf-8").send(layout(site, title, body, "", refresh));
  const notFound = (reply: FastifyReply, what: string) => page(reply, "Not found", notFoundPage(what), "", 404);
  const head = async () => (await db.query<{ number: bigint }>("SELECT number FROM blocks ORDER BY number DESC LIMIT 1")).rows[0]?.number ?? null;

  /**
   * Blocks without transactions leave the database after a while (Indexer.prune), and the deposit
   * each block starts with is never stored. Both are read from the node when someone asks for one,
   * and only at heights the indexer has passed, so a page never runs ahead of the lists.
   */
  const nodeBlock = async (id: { number: bigint } | { hash: string }): Promise<Q.BlockRow | null> => {
    const tip = await head();
    if (tip === null || ("number" in id && id.number > tip)) return null;
    const b = await ("number" in id
      ? rpc.call<RawBlock | null>("eth_getBlockByNumber", [hex(id.number), true])
      : rpc.call<RawBlock | null>("eth_getBlockByHash", [id.hash, true])).catch(() => null);
    if (!b || BigInt(b.number) > tip || !b.transactions.every(isSystemTx)) return null;
    return {
      number: BigInt(b.number), hash: b.hash.toLowerCase(), parent_hash: b.parentHash.toLowerCase(), timestamp: BigInt(b.timestamp),
      miner: b.miner.toLowerCase(), gas_used: BigInt(b.gasUsed).toString(), gas_limit: BigInt(b.gasLimit).toString(),
      base_fee: b.baseFeePerGas ? BigInt(b.baseFeePerGas).toString() : null, size: b.size ? Number(BigInt(b.size)) : null, tx_count: 0,
    };
  };
  const nodeSystemTx = async (hash: string): Promise<Q.TxRow | null> => {
    const t = await rpc.call<RawTx | null>("eth_getTransactionByHash", [hash]).catch(() => null);
    if (!t || !t.blockNumber || !isSystemTx(t)) return null;
    const tip = await head();
    if (tip === null || BigInt(t.blockNumber) > tip) return null;
    const [r, b] = await Promise.all([
      rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [hash]),
      rpc.call<Pick<RawBlock, "timestamp"> | null>("eth_getBlockByNumber", [t.blockNumber, false]),
    ]).catch(() => [null, null] as const);
    if (!r || !b) return null;
    const input = (t.input ?? "0x").toLowerCase();
    return {
      hash: t.hash.toLowerCase(), block_number: BigInt(t.blockNumber), tx_index: Number(BigInt(t.transactionIndex)), timestamp: BigInt(b.timestamp),
      from_address: t.from.toLowerCase(), to_address: t.to ? t.to.toLowerCase() : null, contract_address: null, value: BigInt(t.value).toString(),
      nonce: BigInt(t.nonce), type: Number(BigInt(t.type)), gas_limit: BigInt(t.gas).toString(), gas_used: BigInt(r.gasUsed).toString(),
      gas_price: (r.effectiveGasPrice ?? t.gasPrice) ? BigInt((r.effectiveGasPrice ?? t.gasPrice)!).toString() : null, l1_fee: null,
      status: r.status === undefined ? null : Number(BigInt(r.status)), method_id: input.length >= 10 ? input.slice(0, 10) : null, input,
      source_hash: t.sourceHash ? t.sourceHash.toLowerCase() : null, mint: t.mint ? BigInt(t.mint).toString() : null,
    };
  };
  // Block numbers are BIGINT in the database: any 18 digits fit, 19 can overflow and fail the query.
  const blockById = async (id: string): Promise<Q.BlockRow | null> => {
    const key = /^\d{1,18}$/.test(id) ? { number: BigInt(id) } : normHash(id) ? { hash: normHash(id)! } : null;
    return key ? (await Q.block(db, key)) ?? nodeBlock(key) : null;
  };
  const txByHash = async (hash: string): Promise<Q.TxRow | null> => (await Q.tx(db, hash)) ?? nodeSystemTx(hash);

  // ---------------------------------------------------------- verification
  const compilers = deps.verify?.loadCompiler ? null : new CompilerStore(config.COMPILER_CACHE_DIR);
  const compiling = new Set<() => void>();
  const verifier = config.VERIFICATION
    ? new Verifier({
        db,
        rpc,
        loadCompiler: deps.verify?.loadCompiler ?? ((build) => compilers!.load(build)),
        compile: deps.verify?.compile ?? isolatedCompiler(LIMITS, (kill) => {
          compiling.add(kill);
          return () => void compiling.delete(kill);
        }),
        dailyBytes: config.VERIFY_DAILY_BYTES,
        log: (m) => app.log.warn(m),
      })
    : null;
  app.addHook("onClose", async () => {
    verifier?.close();
    for (const kill of compiling) kill();
  });
  const OFF = "Contract verification is switched off for now";
  const uploads = limiter(UPLOADS_A_MINUTE, 60_000);
  const submits = limiter(UPLOADS_A_MINUTE, 60_000);
  const sourceReads = limiter(SOURCE_READS_A_MINUTE, 60_000);
  const tooMany = (reply: FastifyReply) => reply.code(429).header("retry-after", "60").header("cache-control", "no-store").send({ status: "0", message: "NOTOK", result: "Max rate limit reached" });
  /** Before a body is read: a visitor who keeps sending large ones is refused without reading theirs. */
  const beforeUpload = async (req: FastifyRequest, reply: FastifyReply) => {
    const length = Number(req.headers["content-length"]);
    if (Number.isFinite(length) && length <= SMALL_BODY_BYTES) return;
    if (uploads(visitor(req))) return;
    if (req.url.startsWith("/verify")) return page(reply, "Too many requests", notFoundPage("Try again in a minute.", "Too many requests"), "", 429);
    return tooMany(reply);
  };
  /** A request's named fields: the form it posted, then its query. Only text counts. */
  const fields = (req: FastifyRequest): ((name: string) => string | undefined) => {
    const query = req.query as Record<string, unknown>;
    const body = req.method === "POST" ? req.body : null;
    return (name) => {
      const sent = body instanceof URLSearchParams ? body.get(name) : body && typeof body === "object" && Object.hasOwn(body, name) ? (body as Record<string, unknown>)[name] : null;
      if (typeof sent === "string") return sent;
      return Object.hasOwn(query, name) && typeof query[name] === "string" ? (query[name] as string) : undefined;
    };
  };
  /**
   * A contract's verified source, for as long as the address holds the code it was matched against.
   * `code` is the address's code when the caller has just read it.
   */
  const verifiedSource = async (address: string, code?: Hex): Promise<Q.VerifiedRow | null> => {
    const v = await Q.verified(db, address);
    if (!v) return null;
    const now = code ?? (await rpc.call<Hex>("eth_getCode", [address, "latest"]));
    return typeof now === "string" && now !== "0x" && keccak256(now.toLowerCase() as Hex) === v.code_hash ? v : null;
  };

  // ---------------------------------------------------------------- static
  app.get("/static/*", async (req, reply) => {
    const f = files.get((req.params as { "*": string })["*"]);
    if (!f) return reply.code(404).send("Not found");
    // Pages ask for a file by this release's fingerprint, and only that address may be kept for long.
    // The stylesheet asks for fonts and icons without one: fonts keep their names for good and are kept a week.
    const name = (req.params as { "*": string })["*"];
    const current = (req.query as { v?: unknown }).v === site.build;
    const keep = current ? "public, max-age=31536000, immutable" : name.startsWith("fonts/") ? "public, max-age=604800" : "public, max-age=300";
    return reply.header("cache-control", keep).type(f.type).send(f.body);
  });
  app.get("/favicon.ico", async (_req, reply) => reply.redirect("/static/favicon.svg", 301));
  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain").send("User-agent: *\nAllow: /\nDisallow: /api\n"));

  // /health is served without the origin's secret and without a rate limit, so anyone can ask as
  // often as they like: the database and the node are asked at most once in 5 seconds.
  const health = held(5_000, async (_: void) => {
    const tip = await head();
    const node = await rpc.call<Hex>("eth_blockNumber", []).then((h) => BigInt(h)).catch(() => null);
    return { ok: true, indexed: tip, node, lag: tip !== null && node !== null ? node - tip : null };
  });
  app.get("/health", async () => health());

  /**
   * What a transaction pays now, as the node suggests it: the base fee alone reads 0 on a quiet
   * chain, while the node still asks for its minimum. Asked at most every 15 seconds.
   */
  let gasPriceRead = 0;
  let gasPriceNow: string | null = null;
  const gasPrice = async (): Promise<string | null> => {
    if (Date.now() - gasPriceRead < 15_000) return gasPriceNow;
    gasPriceRead = Date.now();
    gasPriceNow = await rpc.call<Hex>("eth_gasPrice", []).then((p) => BigInt(p).toString()).catch(() => null);
    return gasPriceNow;
  };

  // Putting tokens in order counts the holders of every one of them: a page of the list is read once in 10 seconds.
  const tokenList = held(10_000, (p: number) => Q.tokens(db, PAGE_SIZE, (p - 1) * PAGE_SIZE));

  // ----------------------------------------------------------------- pages
  // The home page's counts by day are read once in 10 seconds; when they cannot be read the page goes out without them.
  const activity = held(10_000, async (_: void) => {
    const now = Date.now() / 1000;
    return Promise.all([Q.lastDayTransactions(db, now), Q.dailyTransactions(db, CHART_DAYS, now)])
      .then(([lastDay, days]) => ({ lastDay, days }))
      .catch(() => ({ lastDay: null, days: [] }));
  });

  app.get("/", async (_req, reply) => {
    const [s, blocks, txs, price, seen] = await Promise.all([Q.stats(db), Q.latestBlocks(db, HOME_ROWS), Q.latestTxs(db, HOME_ROWS), gasPrice(), activity()]);
    return page(reply, site.chainName, homePage(site, { ...s, gasPrice: price, ...seen }, blocks, txs), "/");
  });

  app.get("/blocks", async (req, reply) => {
    const p = pageOf(req.query);
    return page(reply, "Blocks", blocksPage(site, await Q.latestBlocks(db, PAGE_SIZE, (p - 1) * PAGE_SIZE), p), "/blocks");
  });

  app.get("/block/:id", async (req, reply) => {
    const b = await blockById((req.params as { id: string }).id);
    if (!b) return notFound(reply, "No such block, or not indexed yet.");
    const p = pageOf(req.query);
    const [txs, tip] = await Promise.all([Q.blockTxs(db, b.number, PAGE_SIZE, (p - 1) * PAGE_SIZE), head()]);
    return page(reply, `Block ${b.number}`, blockPage(site, b, txs, tip !== null && tip > b.number, p), "/blocks");
  });

  app.get("/txs", async (req, reply) => {
    const p = pageOf(req.query);
    return page(reply, "Transactions", txsPage(site, await Q.latestTxs(db, PAGE_SIZE, (p - 1) * PAGE_SIZE), p), "/txs");
  });

  app.get("/tx/:hash", async (req, reply) => {
    const hash = normHash((req.params as { hash: string }).hash);
    const t = hash ? await txByHash(hash) : null;
    if (!t) return notFound(reply, "No such transaction, or not indexed yet. New transactions appear within seconds.");
    const [logs, transfers, tip] = await Promise.all([Q.txLogs(db, t.hash), Q.txTransfers(db, t.hash), head()]);
    const tokens = await Q.tokensByAddress(db, [...new Set([t.to_address, ...logs.rows.map((l) => l.address)].filter((a): a is string => Boolean(a)))]);
    return page(reply, `Transaction ${t.hash.slice(0, 10)}`, txPage(site, t, logs, transfers, tip, tokens), "/txs");
  });

  app.get("/address/:address", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    if (!a) return notFound(reply, "That is not an address.");
    const query = req.query as { tab?: string; file?: string };
    const tab = query.tab === "transfers" || query.tab === "tokens" || query.tab === "contract" ? query.tab : "txs";
    const p = pageOf(req.query);
    const [balance, code, txCount, creation, token, holdings] = await Promise.all([
      rpc.call<Hex>("eth_getBalance", [a, "latest"]).then((h) => BigInt(h)).catch(() => null),
      rpc.call<Hex>("eth_getCode", [a, "latest"]).catch(() => "0x" as Hex),
      Q.addressTxCount(db, a),
      Q.creation(db, a),
      Q.token(db, a),
      Q.addressTokens(db, a),
    ]);
    const txs = tab === "txs" ? await Q.addressTxs(db, a, PAGE_SIZE, (p - 1) * PAGE_SIZE) : [];
    const transfers = tab === "transfers" ? await Q.addressTransfers(db, a, PAGE_SIZE, (p - 1) * PAGE_SIZE) : [];
    // A source is long: the tab that shows one has a limit of its own.
    if (tab === "contract" && !sourceReads(visitor(req))) return page(reply, "Too many requests", notFoundPage("Try again in a minute.", "Too many requests"), "", 429);
    const hasCode = code !== "0x";
    const source = hasCode ? await verifiedSource(a, code) : null;
    const file = typeof query.file === "string" && /^\d{1,4}$/.test(query.file) ? Number(query.file) : null;
    return page(reply, `Address ${a.slice(0, 10)}`, addressPage(site, a, {
      balance, isContract: hasCode || Boolean(creation), txCount, creation, token, tab: tab === "contract" && !hasCode ? "txs" : tab, page: p, txs, transfers, holdings,
      contract: hasCode ? { code, verified: source, file, canVerify: verifier !== null } : null,
    }));
  });

  app.get("/tokens", async (req, reply) => {
    const p = pageOf(req.query);
    return page(reply, "Tokens", tokensPage(site, await tokenList(p), p), "/tokens");
  });

  app.get("/token/:address", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    const t = a ? await Q.token(db, a) : null;
    if (!t) return a ? reply.redirect(addressPath(a)) : notFound(reply, "That is not a token address.");
    const tab = (req.query as { tab?: string }).tab === "holders" ? "holders" : "transfers";
    const p = pageOf(req.query);
    const [supply, transfers, holders] = await Promise.all([
      totalSupply(rpc, t.address).catch(() => null),
      tab === "transfers" ? Q.tokenTransfers(db, t.address, PAGE_SIZE, (p - 1) * PAGE_SIZE) : [],
      tab === "holders" ? Q.tokenHolders(db, t.address, PAGE_SIZE, (p - 1) * PAGE_SIZE) : [],
    ]);
    return page(reply, `${t.name ?? "Token"} (${t.symbol ?? "?"})`, tokenPage(site, t, { supply, tab, page: p, transfers, holders }), "/tokens");
  });

  app.get("/bridge", async (_req, reply) => {
    const [deps_, wds] = await Promise.all([Q.deposits(db, 20), Q.withdrawals(db, 20)]);
    // The token a deposit brought is in the bridge's event of that transaction; a withdrawal's is in its own message.
    const brought = new Map<string, ReturnType<typeof bridgedToken>>();
    for (const l of await Q.depositTokenLogs(db, deps_.map((t) => t.hash))) brought.set(l.tx_hash, bridgedToken(l));
    const ins = deps_.map((t) => ({ ...t, bridged: brought.get(t.hash) ?? null }));
    const outs = wds.map((w) => ({ ...w, bridged: bridgedToken(w) }));
    const tokens = await Q.tokensByAddress(db, [...new Set([...ins, ...outs].flatMap((x) => (x.bridged ? [x.bridged.token] : [])))]);
    return page(reply, "Bridge", bridgePage(site, ins, outs, tokens), "/bridge");
  });

  app.get("/search", async (req, reply) => {
    const q = String((req.query as { q?: string }).q ?? "").trim().slice(0, 100);
    if (!q) return reply.redirect("/");
    if (/^\d{1,18}$/.test(q)) return reply.redirect(blockPath(q));
    const hash = normHash(q);
    if (hash) {
      if (await Q.tx(db, hash)) return reply.redirect(txPath(hash));
      if (await Q.block(db, { hash })) return reply.redirect(`/block/${hash}`);
      if (await nodeSystemTx(hash)) return reply.redirect(txPath(hash));
      if (await nodeBlock({ hash })) return reply.redirect(`/block/${hash}`);
      return notFound(reply, "No transaction or block with that hash yet.");
    }
    const a = normAddress(q);
    if (a) return reply.redirect((await Q.token(db, a)) ? tokenPath(a) : addressPath(a));
    const found = await Q.searchTokens(db, q);
    if (found.length === 1) return reply.redirect(tokenPath(found[0]!.address));
    return page(reply, "Search", searchPage(q, found));
  });

  app.get("/api-docs", async (_req, reply) => page(reply, "API", apiDocsPage(site), "/api-docs"));

  app.get("/verify", async (req, reply) => {
    if (!verifier) return notFound(reply, `${OFF}.`);
    const address = normAddress(String((req.query as { address?: unknown }).address ?? ""));
    return page(reply, "Verify contract", verifyPage({ contractaddress: address ?? "" }));
  });
  app.post("/verify", { bodyLimit: VERIFY_BODY_BYTES, onRequest: beforeUpload }, async (req, reply) => {
    if (!verifier) return notFound(reply, `${OFF}.`);
    const field = fields(req);
    const form: VerifyForm = Object.fromEntries(VERIFY_FIELDS.map((name) => [name, field(name)]));
    if (!submits(visitor(req))) return fresh(reply, "Verify contract", verifyPage(form, "Too many verifications at once. Try again in a minute"), 429);
    const sent = await verifier.submit(field);
    if (!sent.ok) return fresh(reply, "Verify contract", verifyPage(form, sent.error), 422);
    return reply.header("cache-control", "no-store").redirect(`/verify/status/${sent.guid}`, 303);
  });
  app.get("/verify/status/:guid", async (req, reply) => {
    const guid = (req.params as { guid: string }).guid;
    const job = /^[0-9a-f]{32}$/.test(guid) ? verifier?.status(guid) : null;
    if (!job) return notFound(reply, "No such verification. A result is kept for an hour.");
    if (job.state === "pass") return reply.header("cache-control", "no-store").redirect(`${addressPath(job.address)}?tab=contract`, 303);
    return fresh(reply, "Verification", verifyStatusPage(job), 200, job.state === "pending" ? 3 : undefined);
  });

  // ------------------------------------------------------------- JSON API
  const api = (reply: FastifyReply) => reply.header("cache-control", "public, max-age=2");
  const nf = (reply: FastifyReply) => reply.code(404).send({ error: "not_found" });

  app.get("/api/v1/stats", async (_req, reply) => api(reply).send(await Q.stats(db)));
  app.get("/api/v1/home", async (_req, reply) => api(reply).send({ blocks: await Q.latestBlocks(db, HOME_ROWS), txs: await Q.latestTxs(db, HOME_ROWS) }));
  app.get("/api/v1/blocks", async (req, reply) => api(reply).send(await Q.latestBlocks(db, PAGE_SIZE, (pageOf(req.query) - 1) * PAGE_SIZE)));
  app.get("/api/v1/block/:id", async (req, reply) => {
    const b = await blockById((req.params as { id: string }).id);
    return b ? api(reply).send({ ...b, transactions: await Q.blockTxs(db, b.number, PAGE_SIZE, (pageOf(req.query) - 1) * PAGE_SIZE) }) : nf(reply);
  });
  app.get("/api/v1/txs", async (req, reply) => api(reply).send(await Q.latestTxs(db, PAGE_SIZE, (pageOf(req.query) - 1) * PAGE_SIZE)));
  app.get("/api/v1/tx/:hash", async (req, reply) => {
    const hash = normHash((req.params as { hash: string }).hash);
    const t = hash ? await txByHash(hash) : null;
    if (!t) return nf(reply);
    const [logs, transfers] = await Promise.all([Q.txLogs(db, t.hash), Q.txTransfers(db, t.hash)]);
    return api(reply).send({
      ...t,
      method: methodName(t.method_id),
      call: decodeCall(t.input),
      logs: logs.rows.map((l) => ({ ...l, decoded: decodeLog([l.topic0, l.topic1, l.topic2, l.topic3], l.data) })),
      logsTotal: logs.total,
      transfers: transfers.rows,
      transfersTotal: transfers.total,
    });
  });
  app.get("/api/v1/address/:address", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    if (!a) return reply.code(400).send({ error: "address_invalid" });
    const [balance, txCount, creation] = await Promise.all([
      rpc.call<Hex>("eth_getBalance", [a, "latest"]).then((h) => BigInt(h)).catch(() => null),
      Q.addressTxCount(db, a),
      Q.creation(db, a),
    ]);
    return api(reply).send({ address: a, balance, transactions: txCount, creation });
  });
  app.get("/api/v1/address/:address/txs", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    return a ? api(reply).send(await Q.addressTxs(db, a, PAGE_SIZE, (pageOf(req.query) - 1) * PAGE_SIZE)) : reply.code(400).send({ error: "address_invalid" });
  });
  app.get("/api/v1/address/:address/transfers", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    return a ? api(reply).send(await Q.addressTransfers(db, a, PAGE_SIZE, (pageOf(req.query) - 1) * PAGE_SIZE)) : reply.code(400).send({ error: "address_invalid" });
  });
  app.get("/api/v1/address/:address/tokens", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    return a ? api(reply).send(await Q.addressTokens(db, a)) : reply.code(400).send({ error: "address_invalid" });
  });
  app.get("/api/v1/tokens", async (req, reply) => api(reply).send(await tokenList(pageOf(req.query))));
  app.get("/api/v1/token/:address", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    const t = a ? await Q.token(db, a) : null;
    return t ? api(reply).send({ ...t, totalSupply: await totalSupply(rpc, t.address).catch(() => null) }) : nf(reply);
  });
  app.get("/api/v1/token/:address/holders", async (req, reply) => {
    const a = normAddress((req.params as { address: string }).address);
    return a ? api(reply).send(await Q.tokenHolders(db, a, PAGE_SIZE, (pageOf(req.query) - 1) * PAGE_SIZE)) : reply.code(400).send({ error: "address_invalid" });
  });

  // ------------------------------------------------- Etherscan-compatible
  app.get("/api", async (req, reply) => etherscan(req, reply));
  // Foundry and Hardhat post a verification, and ask after it, as a form.
  app.post("/api", { bodyLimit: VERIFY_BODY_BYTES, onRequest: beforeUpload }, async (req, reply) => etherscan(req, reply));
  async function etherscan(req: FastifyRequest, reply: FastifyReply) {
    const field = fields(req);
    const q = Object.fromEntries(ETHERSCAN_FIELDS.map((name) => [name, field(name)])) as Record<(typeof ETHERSCAN_FIELDS)[number], string | undefined>;
    if (q.module === "contract") return contractApi(req, reply, field);
    if (req.method !== "GET") return reply.code(405).send({ status: "0", message: "NOTOK", result: "Error! Use GET for this action" });
    const ok = (result: unknown) => api(reply).send({ status: "1", message: "OK", result });
    const none = (message: string) => api(reply).send({ status: "0", message, result: [] });
    const bad = (message: string) => api(reply).send({ status: "0", message: "NOTOK", result: `Error! ${message}` });
    const num = (v: string | undefined, d: bigint) => (v && /^\d{1,18}$/.test(v) ? BigInt(v) : d);
    // Whole numbers only: anything else takes the default, as a missing value does.
    const whole = (v: string | undefined, d: number) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) || d : d);
    const pageNo = Math.max(1, Math.min(10_000, whole(q.page, 1)));
    const offset = Math.max(1, Math.min(1000, whole(q.offset, 100)));
    if (pageNo * offset > 10_000) return bad("Result window is too large, PageNo x Offset size must be less than or equal to 10000");
    const asc = q.sort !== "desc";
    const start = num(q.startblock, 0n);
    const end = num(q.endblock, 9_223_372_036_854_775_807n);

    if (q.module === "account" && q.action === "balance") {
      const a = normAddress(q.address ?? "");
      if (!a) return bad("Invalid address format");
      return ok((await rpc.call<Hex>("eth_getBalance", [a, "latest"]).then((h) => BigInt(h))).toString());
    }
    if (q.module === "account" && q.action === "txlist") {
      const a = normAddress(q.address ?? "");
      if (!a) return bad("Invalid address format");
      const tip = await head();
      const per = Math.min(offset, TXLIST_ROWS);
      const rows = await Q.accountTxList(db, a, start, end, asc, per, (pageNo - 1) * per);
      if (!rows.length) return none("No transactions found");
      return ok(rows.map((t) => ({
        blockNumber: String(t.block_number), timeStamp: String(t.timestamp), hash: t.hash, nonce: String(t.nonce), blockHash: t.block_hash,
        transactionIndex: String(t.tx_index), from: t.from_address, to: t.to_address ?? "", value: t.value, gas: t.gas_limit,
        gasPrice: t.gas_price ?? "0", isError: t.status === 0 ? "1" : "0", txreceipt_status: t.status === null ? "" : String(t.status),
        input: t.input, contractAddress: t.contract_address ?? "", cumulativeGasUsed: "", gasUsed: t.gas_used ?? "",
        confirmations: tip === null ? "0" : String(tip - t.block_number + 1n), methodId: t.method_id ?? "0x", functionName: methodName(t.method_id) ?? "",
      })));
    }
    if (q.module === "account" && q.action === "tokentx") {
      const a = q.address ? normAddress(q.address) : undefined;
      const token = q.contractaddress ? normAddress(q.contractaddress) : undefined;
      if (a === null || token === null || (!a && !token)) return bad("Invalid address format");
      const tip = await head();
      const rows = await Q.accountTokenTx(db, { address: a, token }, start, end, asc, offset, (pageNo - 1) * offset);
      if (!rows.length) return none("No transactions found");
      return ok(rows.map((x) => ({
        blockNumber: String(x.block_number), timeStamp: String(x.timestamp), hash: x.tx_hash, logIndex: String(x.log_index),
        from: x.from_address, to: x.to_address, value: x.value, contractAddress: x.token, tokenName: x.name ?? "", tokenSymbol: x.symbol ?? "",
        tokenDecimal: x.decimals === null ? "" : String(x.decimals), confirmations: tip === null ? "0" : String(tip - x.block_number + 1n),
      })));
    }
    if (q.module === "account" && q.action === "tokenbalance") {
      const a = normAddress(q.address ?? "");
      const token = normAddress(q.contractaddress ?? "");
      if (!a || !token) return bad("Invalid address format");
      return ok(await Q.tokenBalance(db, token, a));
    }
    if (q.module === "stats" && q.action === "tokensupply") {
      const token = normAddress(q.contractaddress ?? "");
      if (!token) return bad("Invalid address format");
      const s = await totalSupply(rpc, token);
      return s === null ? bad("Not a token contract") : ok(s.toString());
    }
    return bad("Unsupported module or action");
  }

  /** Etherscan's contract module: verification as Foundry and Hardhat ask for it, and what was verified. */
  async function contractApi(req: FastifyRequest, reply: FastifyReply, field: (name: string) => string | undefined) {
    const answer = (status: "0" | "1", result: unknown) => reply.header("cache-control", "no-store").send({ status, message: status === "1" ? "OK" : "NOTOK", result });
    const action = field("action");
    if (action === "verifysourcecode") {
      if (req.method !== "POST") return answer("0", "Error! Use POST for this action");
      if (!verifier) return answer("0", OFF);
      if (!submits(visitor(req))) return tooMany(reply);
      const sent = await verifier.submit(field);
      return sent.ok ? answer("1", sent.guid) : answer("0", sent.error);
    }
    if (action === "checkverifystatus") {
      const guid = field("guid") ?? "";
      const job = /^[0-9a-f]{32}$/.test(guid) ? verifier?.status(guid) : null;
      if (!job) return answer("0", "Error! No verification with that guid");
      if (job.state === "pending") return answer("0", "Pending in queue");
      return job.state === "pass" ? answer("1", "Pass - Verified") : answer("0", `Fail - Unable to verify. ${job.reason ?? ""}`.trim());
    }
    if (action === "getabi" || action === "getsourcecode") {
      const a = normAddress(field("address") ?? "");
      if (!a) return answer("0", "Error! Invalid address format");
      if (!sourceReads(visitor(req))) return tooMany(reply);
      const v = await verifiedSource(a);
      if (action === "getabi") return v ? answer("1", v.abi) : answer("0", "Contract source code not verified");
      const blank = { SourceCode: "", ABI: "Contract source code not verified", ContractName: "", CompilerVersion: "", OptimizationUsed: "", Runs: "", ConstructorArguments: "", EVMVersion: "Default", Library: "", LicenseType: "Unknown", Proxy: "0", Implementation: "", SwarmSource: "" };
      if (!v) return answer("1", [blank]);
      return answer("1", [{
        ...blank,
        // Etherscan's way of giving several files: the standard JSON input inside a second pair of braces.
        SourceCode: `{${v.input}}`, ABI: v.abi, ContractName: v.name, CompilerVersion: `v${v.compiler}`, OptimizationUsed: v.optimizer ? "1" : "0",
        Runs: v.runs === null ? "" : String(v.runs), ConstructorArguments: v.constructor_args ?? "", EVMVersion: v.evm_version ?? "Default",
      }]);
    }
    return answer("0", "Error! Unsupported module or action");
  }

  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api") ? nf(reply) : notFound(reply, "There is nothing at this address.")));
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    if (req.url.startsWith("/api")) return reply.code(status).send({ error: status === 429 ? "rate_limited" : status >= 500 ? "internal" : "bad_request" });
    const [heading, what] = status === 429 ? ["Too many requests", "Try again in a minute."]
      : ["Something went wrong", status >= 500 ? "Try again in a moment." : "That request could not be read."];
    return page(reply, heading, notFoundPage(what, heading), "", status);
  });

  return app;
}
