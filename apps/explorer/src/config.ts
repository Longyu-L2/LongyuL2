import { z } from "zod";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  /** Postgres server URL. The explorer keeps its tables in their own database (EXPLORER_DATABASE). */
  DATABASE_URL: z.string().optional(),
  /** Database the explorer creates (once) and uses on that server. Empty: use DATABASE_URL as given. */
  EXPLORER_DATABASE: z.string().regex(/^([a-z_][a-z0-9_]{0,62})?$/, "lower-case letters, digits and _").default("explorer"),
  /** In-process PGlite when DATABASE_URL is absent (development and tests only). */
  PGLITE_DIR: z.string().optional(),

  /** LONGYU node (op-geth) JSON-RPC, normally over the private network. */
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.bigint(),
  CHAIN_NAME: z.string().min(1).max(64).default("LONGYU Testnet"),
  NATIVE_SYMBOL: z.enum(["tBNB", "BNB"]).default("tBNB"),
  /** Shown to visitors (wallet setup). */
  PUBLIC_RPC_URL: z.string().url().optional(),
  L1_EXPLORER_URL: z.string().url().default("https://testnet.bscscan.com"),
  BRIDGE_URL: z.string().url().default("https://testnet.longyu.network/bridge.html"),
  /** LONGYU Swap's page; the footer links to it when set. */
  SWAP_URL: z.string().url().startsWith("https://").optional(),
  /** LONGYU's API, where creators' token logos are read (/v1/tokens/<token>/logo). Unset: monograms only. */
  TOKEN_LOGO_API: z.string().url().startsWith("https://").optional(),
  /** LONGYU's website, mining app, developer guide and source code; the menu and the footer link to each one that is set. */
  WEBSITE_URL: z.string().url().startsWith("https://").optional(),
  MINE_URL: z.string().url().startsWith("https://").optional(),
  DEVELOPERS_URL: z.string().url().startsWith("https://").optional(),
  GITHUB_URL: z.string().url().startsWith("https://").optional(),
  /** Names for LONGYU's own contracts, as address:Label pairs, comma-separated. */
  KNOWN_ADDRESSES: z.string().default(""),
  /** LONGYU Launch (TokenLauncher): tokens it made are marked as plain fixed-supply tokens with no owner. */
  TOKEN_LAUNCHER: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address").optional(),
  /**
   * LONGYU's own tokens (LONG), comma-separated addresses. They are marked official, and any other
   * token whose name or symbol passes for LONG or LONGYU carries a warning that names them.
   */
  /** A line shown on the official token's page and in every imitation warning ("... not tradable yet"). */
  OFFICIAL_NOTE: z.string().max(200).default(""),
  OFFICIAL_TOKENS: z
    .string()
    .default("")
    .refine((v) => v.split(",").map((s) => s.trim()).filter(Boolean).every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)), "comma-separated addresses"),

  START_BLOCK: z.coerce.bigint().default(0n),
  /** Blocks fetched per indexer step. */
  BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(25),
  /** Pause between steps once the indexer has caught up. */
  POLL_MS: z.coerce.number().int().min(200).max(60_000).default(1000),
  RUN_INDEXER: bool(true),
  /**
   * Blocks without transactions are deleted this many hours after they were made (0 keeps them).
   * LONGYU makes 345,600 blocks a day; their pages are then read from the node.
   */
  PRUNE_EMPTY_AFTER_HOURS: z.coerce.number().int().min(0).max(87_600).default(24),
  /** "false" (default) or comma-separated proxy addresses/CIDRs allowed to set X-Forwarded-For. */
  TRUST_PROXY: z.string().default("false"),
  /**
   * Shared secret that Cloudflare adds to every request (the x-longyu-origin header). With it set,
   * requests without it are refused and each visitor is counted by Cloudflare's cf-connecting-ip.
   * Without it, a host that puts its own proxy in front (Railway) shows every visitor as that proxy.
   */
  ORIGIN_SECRET: z.string().min(32).optional(),
  /** Requests per minute per client address. */
  RATE_LIMIT: z.coerce.number().int().min(10).max(100_000).default(600),

  /** "false" stops new contract verifications. Sources verified before stay on their pages. */
  VERIFICATION: bool(true),
  /** Where downloaded compilers are kept. Each is checked against its pinned hash every time it is read. */
  COMPILER_CACHE_DIR: z.string().min(1).optional(),
  /** Bytes of verified source the database takes in 24 hours. The database is shared, so this is its guard. */
  VERIFY_DAILY_BYTES: z.coerce.number().int().min(0).max(10 * 1024 ** 3).default(100 * 1024 * 1024),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = ConfigSchema.parse(env);
  if (c.NODE_ENV === "production" && !c.DATABASE_URL) throw new Error("DATABASE_URL is required in production");
  if (c.TRUST_PROXY === "true") throw new Error('TRUST_PROXY must be "false" or a list of proxy addresses, never "true"');
  return c;
}
