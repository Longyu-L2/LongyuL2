/**
 * The signer's HTTP interface, for the API alone, over the private network:
 *   GET  /health               liveness, no token
 *   GET  /v1/accounts          the keys' addresses and the chain and contracts the policy is bound to
 *   POST /v1/sign/transaction  { role, transaction } -> { signedTransaction, hash }
 *   POST /v1/sign/voucher      { recipient, amount, nonce, deadline } -> { signature }
 * Keys are read once at start and never leave the process. Nothing here signs a bare hash or a message.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import type { Config } from "./config.ts";
import { checkTransaction, checkVoucher, DailyBudget, PolicyError, TransactionSchema, VoucherSchema, type Limits, type TxRole } from "./policy.ts";

/** Twice the largest call data in hex, with room for the other fields. */
const MAX_BODY_BYTES = 300_000;

const SignTransactionSchema = z.strictObject({ role: z.enum(["publisher", "relayer", "watch"]), transaction: TransactionSchema });

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface AppOptions {
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new PolicyError("json_required", 415);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new PolicyError("body_too_large", 413);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PolicyError("invalid_json", 400);
  }
}

export function createApp(config: Config, options: AppOptions = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const account = (key: string | undefined): PrivateKeyAccount | undefined => (key ? privateKeyToAccount(key as Hex) : undefined);
  const tx: Record<TxRole, { account?: PrivateKeyAccount; budget: DailyBudget }> = {
    publisher: { account: account(config.PUBLISHER_KEY), budget: new DailyBudget(config.MAX_DAILY_FEE_WEI) },
    relayer: { account: account(config.RELAYER_KEY), budget: new DailyBudget(config.MAX_DAILY_FEE_WEI) },
    watch: { account: account(config.WATCH_KEY), budget: new DailyBudget(config.MAX_DAILY_FEE_WEI) },
  };
  const faucetSigner = account(config.FAUCET_SIGNER_KEY);
  const faucetBudget = new DailyBudget(config.FAUCET_MAX_DAILY_WEI);
  const limits: Limits = {
    chainId: config.CHAIN_ID,
    distributor: config.DISTRIBUTOR_ADDRESS as Address | undefined,
    faucet: config.FAUCET_ADDRESS as Address | undefined,
    maxGas: BigInt(config.MAX_GAS),
    maxFeePerGas: config.MAX_FEE_PER_GAS_WEI,
    maxDataBytes: config.MAX_DATA_BYTES,
    faucetMaxAmount: config.FAUCET_MAX_AMOUNT_WEI,
    voucherMaxTtl: BigInt(config.VOUCHER_MAX_TTL_SECONDS),
  };
  const expected = digest(config.SIGNER_TOKEN);

  const authorised = (req: IncomingMessage): boolean => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    return !!match && timingSafeEqual(digest(match[1]!), expected);
  };

  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PolicyError("invalid_request", 400);
    return parsed.data;
  };

  async function signTransaction(body: unknown) {
    const { role, transaction } = parse(SignTransactionSchema, body);
    const signer = tx[role];
    if (!signer.account) throw new PolicyError("not_configured", 503);
    const { call, maxFee } = checkTransaction(role, transaction, limits);
    signer.budget.spend(maxFee, now());
    const common = {
      chainId: transaction.chainId,
      to: transaction.to as Address,
      data: transaction.data as Hex,
      value: 0n,
      nonce: transaction.nonce,
      gas: transaction.gas,
    };
    const signedTransaction =
      transaction.type === "legacy"
        ? await signer.account.signTransaction({ ...common, type: "legacy", gasPrice: transaction.gasPrice! })
        : await signer.account.signTransaction({
            ...common,
            type: "eip1559",
            maxFeePerGas: transaction.maxFeePerGas!,
            maxPriorityFeePerGas: transaction.maxPriorityFeePerGas!,
          });
    const hash = keccak256(signedTransaction);
    log({ event: "signed_transaction", role, call, to: transaction.to, nonce: transaction.nonce, gas: transaction.gas.toString(), maxFee: maxFee.toString(), hash });
    return { signedTransaction, hash };
  }

  async function signVoucher(body: unknown) {
    const voucher = parse(VoucherSchema, body);
    if (!faucetSigner) throw new PolicyError("not_configured", 503);
    checkVoucher(voucher, limits, BigInt(Math.floor(now() / 1000)));
    faucetBudget.spend(voucher.amount, now());
    const signature = await faucetSigner.signTypedData({
      domain: { name: "LONGYU Faucet", version: "1", chainId: limits.chainId, verifyingContract: limits.faucet! },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: { recipient: voucher.recipient as Address, amount: voucher.amount, nonce: voucher.nonce, deadline: voucher.deadline },
    });
    log({ event: "signed_voucher", recipient: voucher.recipient, amount: voucher.amount.toString(), nonce: voucher.nonce.toString(), deadline: voucher.deadline.toString() });
    return { signature };
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? "").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") return reply(200, { ok: true });
      if (!authorised(req)) return reply(401, { error: "unauthorized" });
      if (req.method === "GET" && path === "/v1/accounts") {
        return reply(200, {
          chainId: limits.chainId,
          distributor: limits.distributor ?? null,
          faucet: limits.faucet ?? null,
          publisher: tx.publisher.account?.address ?? null,
          relayer: tx.relayer.account?.address ?? null,
          faucetSigner: faucetSigner?.address ?? null,
          watch: tx.watch.account?.address ?? null,
        });
      }
      if (req.method === "POST" && path === "/v1/sign/transaction") return reply(200, await signTransaction(await readJson(req)));
      if (req.method === "POST" && path === "/v1/sign/voucher") return reply(200, await signVoucher(await readJson(req)));
      return reply(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof PolicyError) {
        if (error.status === 403 || error.status === 429) log({ event: "refused", path, reason: error.code });
        // Close the connection where the body may not have been read to the end.
        if (error.status === 413 || error.status === 415) res.setHeader("connection", "close");
        return reply(error.status, { error: error.code });
      }
      log({ event: "error", path, message: error instanceof Error ? error.message : "unknown" });
      return reply(500, { error: "internal" });
    }
  };
}
