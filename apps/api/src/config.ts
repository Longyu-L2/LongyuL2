import { z } from "zod";
import { parseL1Watch } from "./services/l1.ts";
import { paymentConfig } from "./services/payments.ts";
import { parseBoostPlans } from "./boosts.ts";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key");
const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  /** Postgres URL. When absent, an in-process PGlite database is used (development only). */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),

  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400 * 31).default(900),
  SIWE_DOMAIN: z.string().default("longyu.network"),

  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.bigint(),
  DISTRIBUTOR_ADDRESS: address,
  FAUCET_ADDRESS: address.optional(),
  EXPLORER_URL: z.string().default("https://scan-testnet.longyu.network"),
  PUBLIC_RPC_URL: z.string().optional(),
  CHAIN_NAME: z.string().min(1).max(64).default("LONGYU Testnet"),
  /** LONGYU's gas token is BNB bridged from BSC: "tBNB" on the testnet, "BNB" on mainnet. */
  NATIVE_SYMBOL: z.enum(["tBNB", "BNB"]).default("tBNB"),
  /** Gas sent by each faucet drip, in wei of the native token (default 0.0002 BNB, enough for hundreds of transactions). */
  FAUCET_DRIP_WEI: z.coerce.bigint().refine((v) => v > 0n && v <= 10n ** 18n, "between 1 wei and 1 BNB").default(200_000_000_000_000n),

  /**
   * Who signs for the publisher, relayer and faucet signer. One of: the signer service (apps/signer,
   * reached over the private network), AWS KMS key IDs, or raw keys (development only, refused in
   * production). The signer service holds the keys; this API then holds none.
   */
  SIGNER_URL: z.string().url().optional(),
  SIGNER_TOKEN: z.string().min(32).optional(),
  PUBLISHER_KEY: privateKey.optional(),
  RELAYER_KEY: privateKey.optional(),
  FAUCET_SIGNER_KEY: privateKey.optional(),
  /** Outside production only: the guardian-only key of the automatic watch. With SIGNER_URL it is the signer's. */
  WATCH_KEY: privateKey.optional(),
  KMS_REGION: z.string().optional(),
  KMS_PUBLISHER_KEY_ID: z.string().optional(),
  KMS_RELAYER_KEY_ID: z.string().optional(),
  KMS_FAUCET_SIGNER_KEY_ID: z.string().optional(),

  BSC_RPC_URL: z.string().url().default("https://bsc-dataseed.bnbchain.org"),
  /**
   * Business payments through PaymentRouter on BSC (optional). The watcher needs an RPC that serves
   * eth_getLogs (BNB's public dataseed endpoints do not); it defaults to BSC_RPC_URL.
   */
  PAYMENT_ROUTER_ADDRESS: address.optional(),
  /** Block the router was deployed in: its constructor's TreasurySet event must be read. */
  PAYMENT_START_BLOCK: z.coerce.bigint().optional(),
  /** The treasury multisig. Payments made while the router pointed elsewhere go to review. */
  TREASURY_ADDRESS: address.optional(),
  PAYMENT_RPC_URL: z.string().url().optional(),
  PAYMENT_CHAIN_ID: z.coerce.bigint().default(56n),
  /** SYMBOL:address:decimals, comma-separated; "native" is BNB. Default: BSC-USD (USDT) and BNB. */
  PAYMENT_TOKENS: z.string().default("USDT:0x55d398326f99059fF775485246999027B3197955:18,BNB:native:18"),
  /** "finalized" (BSC fast finality) or a number of confirmations. */
  PAYMENT_FINALITY: z.string().default("finalized"),
  /**
   * Mining capacity plans, as id:bps:days:TOKEN:price, comma-separated (empty: none offered). An id
   * is "<class>-<days>": the app groups plans into classes (C1 to C5) and epochs (7, 30 or 90 days).
   * Default: five classes from 1.10x to 2.00x, each a daily rate in BNB with 10% off for 30 days and
   * 20% off for 90. Changing a plan never alters ones already paid for.
   */
  BOOST_PLANS: z.string().default(
    "c1-1:1000:1:BNB:0.0014,c1-3:1000:3:BNB:0.0054,c1-7:1000:7:BNB:0.0144,c2-1:2500:1:BNB:0.0028,c2-3:2500:3:BNB:0.0108,c2-7:2500:7:BNB:0.0288,c3-1:5000:1:BNB:0.0049,c3-3:5000:3:BNB:0.0189,c3-7:5000:7:BNB:0.0504,c4-1:7500:1:BNB:0.007,c4-3:7500:3:BNB:0.027,c4-7:7500:7:BNB:0.072,c5-1:10000:1:BNB:0.0091,c5-3:10000:3:BNB:0.0351,c5-7:10000:7:BNB:0.0936",
  ),
  /** Web page where a payer completes an order with their own wallet (?order=<order id>). */
  PAY_PAGE_URL: z.string().url().default("https://testnet.longyu.network/pay.html"),
  /** Telegram bot and chat that receive order and payment notices (both or neither; otherwise they are logged). */
  TELEGRAM_BOT_TOKEN: z.string().regex(/^[0-9]{5,20}:[A-Za-z0-9_-]{20,100}$/, "a bot token from @BotFather").optional(),
  TELEGRAM_CHAT_ID: z.string().regex(/^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$/, "a numeric chat id or @channel").optional(),
  BABT_ADDRESS: address.default("0x2B09d47D550061f995A3b5C6F0Fd58005215D7c8"),

  TURNSTILE_SECRET: z.string().optional(),
  /** LONGYU Launch (TokenLauncher) on LONGYU: the creators of the tokens it made may upload their logos. Unset: no uploads. */
  TOKEN_LAUNCHER: address.optional(),
  /**
   * true: no human check anywhere. Browsers set up and start sessions without one, and phones are
   * never asked for one. Sign-in with X and the phone's device proof still apply.
   */
  HUMAN_CHECK_OFF: bool,
  /**
   * Sign-in with X (OAuth 2.0, confidential client). The redirect URI is this API's own
   * /v1/auth/x/callback, exactly as registered in the X developer app. All three are required in
   * production; without them nobody can sign in.
   */
  X_CLIENT_ID: z.string().min(1).max(200).optional(),
  X_CLIENT_SECRET: z.string().min(1).max(200).optional(),
  X_REDIRECT_URI: z.string().url().optional(),
  /**
   * The most sign-ins completed at X in one UTC day. Each one is a billed read of the account, so
   * past this number the callback refuses to call X until the next day.
   */
  X_DAILY_SIGNIN_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(5000),
  /** Where the callback sends the app once X has answered: the app's own link, never a web page. */
  APP_AUTH_REDIRECT: z.string().max(200).default("longyumine://auth"),
  /**
   * Mining in a browser, for people without the Android app. A browser cannot prove what device it
   * runs on, so a web miner passes the human check at every session instead of the device check.
   * Off by default; turning it off again stops web sign-ins and web sessions at once.
   */
  WEB_MINING: bool,
  /**
   * Where the callback sends a browser that signed in from the web app: the web app's own address,
   * which must also be listed in WEB_ORIGINS. Required with WEB_MINING.
   */
  WEB_AUTH_REDIRECT: z.string().max(200).optional(),
  /**
   * The invite bonus: each invited account that mines on a day raises its inviter's weight that
   * day (see invites.ts). Off by default; turning it off again ends the bonus from the next
   * settlement on, and days already settled stay as they were.
   */
  INVITE_REWARD: bool,
  VERIFICATION_WEBHOOK_SECRET: z.string().min(16).optional(),

  /** Comma-separated "name:sha256(key)" pairs for admin API access. */
  ADMIN_KEYS: z.string().default(""),
  /** sha256 of a read-only key for uptime monitors; it opens /v1/admin/health and nothing else. */
  MONITOR_KEY_SHA256: z.string().regex(/^[0-9a-f]{64}$/, "lower-case hex sha256").optional(),
  /** Publisher and relayer gas balances below this (in the chain's native token) raise a warning. */
  ALERT_MIN_GAS_BALANCE: z.string().regex(/^\d{1,9}(\.\d{1,18})?$/).default("0.002"),
  /**
   * The chain's batcher and proposer pay gas on the L1 and stop without it, while the chain keeps
   * making blocks. With both set, the health check reads their balances: the L1's RPC, and
   * comma-separated "name:address" pairs such as "batcher:0x…,proposer:0x…".
   */
  L1_RPC_URL: z.string().url().optional(),
  /**
   * The rollup's L2OutputOracle on the L1. With L1_RPC_URL, phones rebuild a state root posted there
   * to start a session, and report the newer ones they check while it runs (modules/phone-work.ts).
   */
  L1_OUTPUT_ORACLE: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  /** Zero bits the session puzzle asks for; 0 turns the puzzle off. Each bit doubles the average work. */
  WORK_BITS: z.coerce.number().int().min(0).max(24).default(15),
  /** Devices that must do the phone work to start a session (android, ios, web, or none); others may. */
  PHONE_WORK_PLATFORMS: z.string().regex(/^(none|(android|ios|web)(,(android|ios|web))*)$/).default("web"),
  L1_WATCH: z.string().max(600).optional(),
  /** L1 balances below this (in the L1's native token) raise a warning; below a fifth of it they are critical. */
  L1_MIN_GAS_BALANCE: z.string().regex(/^\d{1,9}(\.\d{1,18})?$/).default("0.01"),
  /**
   * Which proxies may set X-Forwarded-For: "false" (none, the default), or comma-separated
   * addresses/CIDRs such as Cloudflare's published ranges. Never "true" on an origin reachable
   * from the internet, or clients can choose their own IP.
   */
  TRUST_PROXY: z.string().default("false"),
  /**
   * Shared secret that Cloudflare adds to every request (a Transform Rule setting the
   * x-longyu-origin header). With it set, requests without it are refused (except /health), and the
   * client address and country come from Cloudflare's headers. Use it on hosts whose origin is
   * reachable from the internet, such as Railway.
   */
  ORIGIN_SECRET: z.string().min(32).optional(),
  /** Reject requests without the CDN country header (on by default in production). */
  REQUIRE_COUNTRY: z.string().optional(),
  /** Origins allowed to call the API from a browser (the web claim page), comma-separated. */
  WEB_ORIGINS: z.string().default(""),
  /** Secret for deterministic per-day decisions (pulse checks). Defaults to a derivative of JWT_SECRET. */
  PULSE_SECRET: z.string().optional(),
  /** Risk rules: accounts on one network address in a day, failed device checks, and how regular start times may be. */
  RISK_IP_CLUSTER_LIMIT: z.coerce.number().int().min(1).max(100_000).default(20),
  RISK_ATTESTATION_FAILURES: z.coerce.number().int().min(1).max(1000).default(5),
  RISK_TIMING_STDDEV_SECONDS: z.coerce.number().min(0).max(3600).default(30),
  /** Wallet-sweep rule: this many accounts sending to one destination within the window raises flags. */
  SWEEP_MIN_ACCOUNTS: z.coerce.number().int().min(2).max(1000).default(5),
  SWEEP_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /** Destinations never flagged (bridges, exchanges, other known services), comma-separated. */
  SWEEP_ALLOWLIST: z.string().default(""),
  /** ISO country codes that may not mine (mainland China and sanctioned regions by default). */
  BLOCKED_COUNTRIES: z.string().default("CN,KP,IR,CU,SY"),

  /** Local folder for data files when no bucket is set (development only). */
  DATA_DIR: z.string().default("./data"),
  /** Public base URL of the data files. Written on-chain with every root, so it must last. */
  PUBLIC_DATA_BASE_URL: z.string().url().default("http://localhost:8080/data"),
  /** S3-compatible bucket for data files (a Railway bucket, Cloudflare R2 or AWS S3). Required in production. */
  STORAGE_BUCKET: z.string().optional(),
  /** "auto" for a Railway bucket or R2, or the AWS region. */
  STORAGE_REGION: z.string().default("auto"),
  /** The bucket's S3 endpoint (Railway: its ENDPOINT variable; R2: https://<account id>.r2.cloudflarestorage.com). Omit for AWS S3. */
  STORAGE_ENDPOINT: z.string().url().optional(),
  /**
   * false (the default): the bucket is private, as every Railway bucket is, and this API serves the
   * files at /data/roots/, so PUBLIC_DATA_BASE_URL must be this API's own public address plus /data.
   * true: the bucket is readable by anyone at PUBLIC_DATA_BASE_URL (R2 with a public domain).
   */
  STORAGE_PUBLIC_READ: bool,
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

  ANDROID_PACKAGE: z.string().default("app.longyu.mine"),
  /**
   * SHA-256 of the Android app's signing certificate (hex, colons allowed; several comma-separated
   * during a key rotation). Enables hardware key attestation for the APK distributed outside Google Play.
   */
  ANDROID_SIGNING_CERT_SHA256: z
    .string()
    .regex(/^\s*[0-9A-Fa-f]{2}(:?[0-9A-Fa-f]{2}){31}\s*(,\s*[0-9A-Fa-f]{2}(:?[0-9A-Fa-f]{2}){31}\s*)*$/, "SHA-256 hex digests, comma-separated")
    .optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().default("app.longyu.mine"),
  /** Accept "dev:<nonce>" attestation tokens. Refused in production. */
  ALLOW_DEV_ATTESTATION: bool,
  /** Enable the development identity-verification provider. Refused in production. */
  ALLOW_DEV_VERIFICATION: bool,
  /** Sign in as any X account with a "dev:<id>:<username>" code, without X. Refused in production. */
  ALLOW_DEV_X_LOGIN: bool,
  /** Run background jobs in this process. */
  RUN_JOBS: bool,
});

export type Config = Omit<z.infer<typeof ConfigSchema>, "REQUIRE_COUNTRY"> & { REQUIRE_COUNTRY: boolean };

/** Schemes a browser handles itself: sending a sign-in ticket to one would hand it to a web page. */
const WEB_SCHEMES = ["http:", "javascript:", "data:", "file:", "blob:", "about:", "vbscript:", "ftp:", "ws:", "wss:", "view-source:"];

/**
 * The sign-in callback redirects here and nowhere else, adding only "?ticket=" or "?error=". It must
 * be a link the app owns: its own scheme, or an https link the app has claimed.
 */
function checkAppRedirect(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_AUTH_REDIRECT must be a link such as longyumine://auth");
  }
  if (WEB_SCHEMES.includes(url.protocol) || url.search || url.hash || url.username || url.password || /[\s?#]/.test(value)) {
    throw new Error("APP_AUTH_REDIRECT must be the app's own link (its scheme, or https), with no query");
  }
}

/**
 * The callback sends web sign-ins here and nowhere else, adding only "#ticket=" or "#error=". It
 * must be the web app's own https address (plain http only on the same machine, outside production),
 * and one of the origins allowed to call this API.
 */
function checkWebRedirect(value: string, origins: string, production: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WEB_AUTH_REDIRECT must be the web app's address, such as https://mine.longyu.network/");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && !production)) {
    throw new Error("WEB_AUTH_REDIRECT must be an https address");
  }
  if (url.search || url.hash || url.username || url.password || /[\s?#]/.test(value)) {
    throw new Error("WEB_AUTH_REDIRECT must have no query, fragment or credentials");
  }
  if (!origins.split(",").map((s) => s.trim()).includes(url.origin)) {
    throw new Error(`WEB_AUTH_REDIRECT's origin (${url.origin}) must be listed in WEB_ORIGINS, or the web app cannot call this API`);
  }
}

/** The signer's token crosses this link on every request: plain http only where nobody else can listen. */
function checkSignerUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname;
  const privateHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".internal");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) {
    throw new Error("SIGNER_URL must be https, or http on a private network name (*.internal) or this machine");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("SIGNER_URL must be a plain address, with no credentials or query");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Blank values (as left by copying .env.example) mean "not set", never an empty secret.
  const raw = ConfigSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "")));
  const config: Config = {
    ...raw,
    REQUIRE_COUNTRY: raw.REQUIRE_COUNTRY === undefined ? raw.NODE_ENV === "production" : raw.REQUIRE_COUNTRY === "true",
  };
  if (config.TRUST_PROXY === "true") throw new Error('TRUST_PROXY=true lets clients spoof their IP; list the proxy ranges instead');
  // A mistyped entry would never match a key, or break the comparison. The message names no entry's text.
  config.ADMIN_KEYS.split(",").filter(Boolean).forEach((entry, i) => {
    if (!/^[^:]+:[0-9a-f]{64}$/.test(entry)) {
      throw new Error(`ADMIN_KEYS: entry ${i + 1} must be name:sha256, the hash as 64 lower-case hex characters`);
    }
  });
  const plans = parseBoostPlans(config.BOOST_PLANS);
  const payments = paymentConfig(config);
  for (const p of payments ? plans : []) {
    if (!payments!.tokens.some((t) => t.symbol === p.token)) throw new Error(`BOOST_PLANS: ${p.id} is priced in ${p.token}, which is not in PAYMENT_TOKENS`);
  }
  if (payments) {
    // Checked 2026-11-17: BNB's public dataseed endpoints answer eth_getLogs with "limit exceeded".
    if (new URL(config.PAYMENT_RPC_URL ?? config.BSC_RPC_URL).hostname.includes("bsc-dataseed")) {
      throw new Error("payments need an RPC that serves eth_getLogs; set PAYMENT_RPC_URL (BNB's public dataseed endpoints refuse it)");
    }
  }
  if (!config.STORAGE_ACCESS_KEY_ID !== !config.STORAGE_SECRET_ACCESS_KEY) {
    throw new Error("STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY are set together");
  }
  if (!config.TELEGRAM_BOT_TOKEN !== !config.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set together");
  if (!config.L1_RPC_URL !== !config.L1_WATCH) throw new Error("L1_RPC_URL and L1_WATCH are set together");
  if (config.L1_OUTPUT_ORACLE && !config.L1_RPC_URL) throw new Error("L1_OUTPUT_ORACLE needs L1_RPC_URL");
  parseL1Watch(config.L1_WATCH);
  const rawKeys = [config.PUBLISHER_KEY, config.RELAYER_KEY, config.FAUCET_SIGNER_KEY, config.WATCH_KEY].some(Boolean);
  const kmsKeys = [config.KMS_PUBLISHER_KEY_ID, config.KMS_RELAYER_KEY_ID, config.KMS_FAUCET_SIGNER_KEY_ID].some(Boolean);
  if (!config.SIGNER_URL !== !config.SIGNER_TOKEN) throw new Error("SIGNER_URL and SIGNER_TOKEN are set together");
  if (config.SIGNER_URL) {
    checkSignerUrl(config.SIGNER_URL);
    // One place holds the keys. With the signer service, this API has none of its own.
    if (rawKeys || kmsKeys) throw new Error("SIGNER_URL replaces the signing keys: remove the raw keys and KMS key IDs");
  }
  if (!config.X_CLIENT_ID !== !config.X_CLIENT_SECRET) throw new Error("X_CLIENT_ID and X_CLIENT_SECRET are set together");
  if (config.X_CLIENT_ID && !config.X_REDIRECT_URI) throw new Error("X_REDIRECT_URI is required with X_CLIENT_ID");
  if (config.X_CLIENT_ID && config.ALLOW_DEV_X_LOGIN) throw new Error("ALLOW_DEV_X_LOGIN replaces X: remove it, or remove X_CLIENT_ID and X_CLIENT_SECRET");
  if (config.X_REDIRECT_URI) {
    const uri = new URL(config.X_REDIRECT_URI);
    if (!["https:", "http:"].includes(uri.protocol) || !uri.pathname.endsWith("/v1/auth/x/callback") || uri.search || uri.hash || uri.username || uri.password) {
      throw new Error("X_REDIRECT_URI must be this API's /v1/auth/x/callback URL, with no query");
    }
  }
  checkAppRedirect(config.APP_AUTH_REDIRECT);
  if (config.WEB_MINING && !config.WEB_AUTH_REDIRECT) throw new Error("WEB_AUTH_REDIRECT is required with WEB_MINING");
  if (config.WEB_AUTH_REDIRECT) checkWebRedirect(config.WEB_AUTH_REDIRECT, config.WEB_ORIGINS, config.NODE_ENV === "production");
  if (config.NODE_ENV === "production") {
    if (config.ALLOW_DEV_ATTESTATION || config.ALLOW_DEV_VERIFICATION) {
      throw new Error("development attestation and verification are not allowed in production");
    }
    if (config.ALLOW_DEV_X_LOGIN) throw new Error("development X sign-in is not allowed in production");
    if (rawKeys) throw new Error("raw signing keys are not allowed in production; use the signer service (SIGNER_URL) or KMS");
    if (!config.SIGNER_URL && !(config.KMS_PUBLISHER_KEY_ID && config.KMS_RELAYER_KEY_ID)) {
      throw new Error("SIGNER_URL and SIGNER_TOKEN (or KMS key IDs for the publisher and relayer) are required in production");
    }
    if (!config.X_CLIENT_ID || !config.X_CLIENT_SECRET || !config.X_REDIRECT_URI) {
      throw new Error("X_CLIENT_ID, X_CLIENT_SECRET and X_REDIRECT_URI are required in production");
    }
    if (new URL(config.X_REDIRECT_URI).protocol !== "https:") throw new Error("X_REDIRECT_URI must be https in production");
    if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
    if (!config.TURNSTILE_SECRET && !config.HUMAN_CHECK_OFF) throw new Error("TURNSTILE_SECRET is required in production (or HUMAN_CHECK_OFF=true)");
    // Data files must outlive any one server: their URLs are written on-chain.
    if (!config.STORAGE_BUCKET) throw new Error("STORAGE_BUCKET is required in production");
    const base = new URL(config.PUBLIC_DATA_BASE_URL);
    if (base.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
      throw new Error("PUBLIC_DATA_BASE_URL must be a public https URL in production");
    }
    if (!config.STORAGE_PUBLIC_READ) {
      // A private bucket answers nobody directly. The address written on-chain must be the one this
      // API answers at, which is the host X returns sign-ins to.
      const own = `${new URL(config.X_REDIRECT_URI).origin}/data`;
      if (config.PUBLIC_DATA_BASE_URL.replace(/\/+$/, "") !== own) {
        throw new Error(`PUBLIC_DATA_BASE_URL must be ${own}: the bucket is private and this API serves its files (STORAGE_PUBLIC_READ=true only for a bucket with its own public address)`);
      }
    }
    // The origin is reachable from the internet: without the secret anyone can skip Cloudflare and
    // send its headers (client address, country) themselves.
    if (!config.ORIGIN_SECRET) throw new Error("ORIGIN_SECRET is required in production");
    // /v1/network hands the RPC address to every client; without this it would be the private RPC_URL.
    if (!config.PUBLIC_RPC_URL) throw new Error("PUBLIC_RPC_URL is required in production");
  }
  return config;
}
