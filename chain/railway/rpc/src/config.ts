/** Settings of the public RPC gateway, read once from the environment. */
export type Config = {
  port: number;
  host: string;
  /** The LONGYU node's JSON-RPC over the private network (op-geth, port 8545). */
  upstreamUrl: string;
  chainId: bigint;
  /**
   * Shared secret that Cloudflare adds to every request (the x-longyu-origin header). With it set,
   * requests without it are refused and the client address is Cloudflare's cf-connecting-ip.
   * Without it, the client address is the x-real-ip header that Railway's edge sets.
   */
  originSecret: string | null;
  /** Allowance each client address earns per second, and the most it can save up. A light call costs 1. */
  ratePerSecond: number;
  burst: number;
  maxBatch: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  /** Most blocks one eth_getLogs query may cover. */
  maxLogRange: number;
  /** Most requests sent to the node at once, in total and for one client address. */
  maxInFlight: number;
  maxInFlightPerClient: number;
  upstreamTimeoutMs: number;
  /** One log line per request (for debugging). The 60-second summary is always logged. */
  accessLog: boolean;
};

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d{1,12}$/.test(raw)) throw new Error(`${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const upstream = env.UPSTREAM_URL?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error("UPSTREAM_URL must be the node's JSON-RPC URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("UPSTREAM_URL must be an http(s) URL");
  const chain = env.CHAIN_ID?.trim() ?? "";
  if (!/^[1-9]\d{0,17}$/.test(chain)) throw new Error("CHAIN_ID must be the chain's number");
  const secret = env.ORIGIN_SECRET?.trim() || null;
  if (secret !== null && secret.length < 32) throw new Error("ORIGIN_SECRET must be at least 32 characters");

  const config: Config = {
    port: int(env, "PORT", 8080, 1, 65_535),
    host: env.HOST?.trim() || "0.0.0.0",
    upstreamUrl: url.toString(),
    chainId: BigInt(chain),
    originSecret: secret,
    ratePerSecond: int(env, "RATE_PER_SECOND", 50, 1, 100_000),
    burst: int(env, "RATE_BURST", 300, 1, 1_000_000),
    maxBatch: int(env, "MAX_BATCH", 25, 1, 1_000),
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 512_000, 1_024, 10_000_000),
    maxResponseBytes: int(env, "MAX_RESPONSE_BYTES", 8_000_000, 65_536, 100_000_000),
    maxLogRange: int(env, "MAX_LOG_RANGE", 50_000, 1, 10_000_000),
    maxInFlight: int(env, "MAX_IN_FLIGHT", 32, 1, 10_000),
    maxInFlightPerClient: int(env, "MAX_IN_FLIGHT_PER_CLIENT", 8, 1, 10_000),
    upstreamTimeoutMs: int(env, "UPSTREAM_TIMEOUT_MS", 15_000, 100, 120_000),
    accessLog: env.ACCESS_LOG === "true",
  };
  // A full batch of the dearest calls must fit in the allowance, or it could never be served.
  if (config.burst < config.maxBatch * 4) throw new Error("RATE_BURST must be at least 4 times MAX_BATCH");
  return config;
}
