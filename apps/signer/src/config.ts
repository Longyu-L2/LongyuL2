import { z } from "zod";
import { privateKeyToAddress } from "viem/accounts";
import type { Address, Hex } from "viem";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address");
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key");
const wei = (fallback: string) =>
  z
    .string()
    .regex(/^\d{1,30}$/, "must be a whole number of wei")
    .default(fallback)
    .transform((v) => BigInt(v));

export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Railway's private network is IPv6, so the default listens on every address. The service has no public domain. */
  HOST: z.string().default("::"),
  /** The API's bearer token. */
  SIGNER_TOKEN: z.string().min(32),
  CHAIN_ID: z.coerce.number().int().positive(),
  /** Until the distributor's address is set, no transaction is signed. */
  DISTRIBUTOR_ADDRESS: address.optional(),
  FAUCET_ADDRESS: address.optional(),

  PUBLISHER_KEY: privateKey.optional(),
  RELAYER_KEY: privateKey.optional(),
  FAUCET_SIGNER_KEY: privateKey.optional(),
  /** Holds only the distributor's guardian role: vetoes a root the API did not compute and pauses claims. */
  WATCH_KEY: privateKey.optional(),

  /** Limits on one transaction. */
  MAX_GAS: z.coerce.number().int().positive().default(5_000_000),
  MAX_FEE_PER_GAS_WEI: wei("1000000000"),
  MAX_DATA_BYTES: z.coerce.number().int().positive().max(131_072).default(131_072),
  /** The most each transaction key may commit to fees (gas limit times fee cap) in one UTC day. */
  MAX_DAILY_FEE_WEI: wei("10000000000000000"),

  /** Voucher limits. Keep them at or under the faucet contract's own. */
  FAUCET_MAX_AMOUNT_WEI: wei("1000000000000000"),
  FAUCET_MAX_DAILY_WEI: wei("50000000000000000"),
  VOUCHER_MAX_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Blank values mean "not set", never an empty secret.
  const config = ConfigSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "")));
  const keys = [config.PUBLISHER_KEY, config.RELAYER_KEY, config.FAUCET_SIGNER_KEY, config.WATCH_KEY].filter((k): k is string => !!k).map((k) => k.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error("each role needs its own key");
  const token = config.SIGNER_TOKEN.toLowerCase();
  if (keys.some((k) => k === token || k.slice(2) === token)) throw new Error("SIGNER_TOKEN must not be a signing key");
  if (config.DISTRIBUTOR_ADDRESS && config.DISTRIBUTOR_ADDRESS.toLowerCase() === config.FAUCET_ADDRESS?.toLowerCase()) {
    throw new Error("DISTRIBUTOR_ADDRESS and FAUCET_ADDRESS must differ");
  }
  return config;
}

export interface Addresses {
  publisher?: Address;
  relayer?: Address;
  faucetSigner?: Address;
  watch?: Address;
}

/** The public addresses of the configured keys. */
export function addresses(config: Config): Addresses {
  const of = (key: string | undefined) => (key ? privateKeyToAddress(key as Hex) : undefined);
  return { publisher: of(config.PUBLISHER_KEY), relayer: of(config.RELAYER_KEY), faucetSigner: of(config.FAUCET_SIGNER_KEY), watch: of(config.WATCH_KEY) };
}
