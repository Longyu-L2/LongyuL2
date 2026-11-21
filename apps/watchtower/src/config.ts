import { z } from "zod";
import { privateKeyToAddress } from "viem/accounts";
import type { Address, Hex } from "viem";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address").transform((v) => v as Address);
const privateKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key").transform((v) => v as Hex);
const url = z.string().url().refine((v) => /^https?:\/\//.test(v), "must be an http(s) URL");
const urls = z
  .string()
  .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(url).min(1));
const wei = (fallback: string) => z.string().regex(/^\d{1,30}$/, "must be a whole number of wei").default(fallback).transform((v) => BigInt(v));
const seconds = (fallback: number) => z.coerce.number().int().positive().default(fallback).transform((v) => BigInt(v));

export const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("::"),
  /** A volume: the roots this service accepted must outlive a restart. */
  STATE_DIR: z.string().default("./state"),
  POLL_SECONDS: z.coerce.number().int().min(5).max(600).default(30),

  // ---- the challenger, on BSC
  /** BSC endpoints, tried in order. A different provider from the proposer's is best. */
  L1_RPC_URLS: urls,
  L1_CHAIN_ID: z.coerce.number().int().refine((v) => v === 56 || v === 97, "must be 56 (BSC) or 97 (BSC testnet)"),
  L1_OUTPUT_ORACLE: address,
  /** op-node of this service's own node, which derives the chain from BSC (no sequencer, no peers). */
  VERIFIER_NODE_URL: url,
  /** Without it the challenger only reports. It must be the oracle's challenger. */
  CHALLENGER_KEY: privateKey.optional(),
  CHALLENGER_MAX_FEE_PER_GAS_WEI: wei("5000000000"),
  /** A root still unchecked this long before it finalizes is deleted (at most half the wait is used). */
  OUTPUT_LATE_SECONDS: seconds(1200),

  // ---- the mining watch, on LONGYU
  /** op-geth of this service's own node: every read of the distributor comes from it. */
  VERIFIER_GETH_URL: url,
  /** Where transactions go: the sequencer, through LONGYU's public RPC. */
  L2_SEND_URL: url,
  L2_CHAIN_ID: z.coerce.number().int().positive(),
  /** Without it the mining watch is off. */
  DISTRIBUTOR_ADDRESS: address.optional(),
  /** Holds only the distributor's guardian role. Without it the mining watch only reports. */
  GUARDIAN_KEY: privateKey.optional(),
  GUARDIAN_MAX_FEE_PER_GAS_WEI: wei("100000000"),
  /** Data files are read only from these origins: the address on chain is written by the publisher. */
  DATA_ORIGINS: urls,
  MAX_DATA_BYTES: z.coerce.number().int().positive().max(512 * 1024 * 1024).default(64 * 1024 * 1024),
  /** A waiting root not accepted this long before it becomes claimable is stopped (pause, then veto). */
  VETO_MARGIN_SECONDS: seconds(7200),
  /** New accounts allowed per day: a fixed number, so roots the watchtower accepted cannot raise it. */
  NEW_ACCOUNTS_PER_DAY: z.coerce.number().int().positive().default(5000),
  /** Accounts that may be frozen (lowered to what they claimed) in one root. */
  FREEZES_PER_ROOT: z.coerce.number().int().min(0).default(20),
  /** A LONGYU RPC to rebuild state roots from while the own node is behind. */
  FALLBACK_RPC_URL: url.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Blank values mean "not set", never an empty secret.
  const config = ConfigSchema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== "")));
  if (config.CHALLENGER_KEY && config.GUARDIAN_KEY && config.CHALLENGER_KEY.toLowerCase() === config.GUARDIAN_KEY.toLowerCase()) {
    throw new Error("CHALLENGER_KEY and GUARDIAN_KEY must be two different keys");
  }
  if (config.L1_CHAIN_ID === 56 && config.L2_CHAIN_ID !== 668800) throw new Error("BSC goes with LONGYU mainnet (668800)");
  if (config.L1_CHAIN_ID === 97 && config.L2_CHAIN_ID !== 668801) throw new Error("BSC testnet goes with LONGYU testnet (668801)");
  if (config.DATA_ORIGINS.some((o) => new URL(o).origin !== o.replace(/\/+$/, ""))) throw new Error("DATA_ORIGINS must be origins, such as https://api.longyu.network");
  return config;
}

export const addressOf = (key: Hex | undefined): Address | null => (key ? privateKeyToAddress(key) : null);
