/**
 * What the signer agrees to sign. The API asks; these rules decide.
 * - Publisher: only MiningDistributor.proposeRoot on this chain.
 * - Relayer: only MiningDistributor.claimMany and Faucet.drip on this chain.
 * - Faucet signer: only the faucet's Voucher, within the amount, lifetime and daily limits.
 * No key sends value, deploys a contract, signs a message or signs for another chain.
 */
import { faucetAbi, miningDistributorAbi } from "@longyu/abis";
import { decodeFunctionData, encodeFunctionData, size, type Abi, type Address, type Hex } from "viem";
import { z } from "zod";

export type TxRole = "publisher" | "relayer";

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status = 403,
  ) {
    super(code);
  }
}

const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .transform((v) => BigInt(v));
const hexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Unknown fields are refused, so an access list, blobs or an authorization list can never be signed. */
export const TransactionSchema = z.strictObject({
  type: z.enum(["legacy", "eip1559"]),
  chainId: z.number().int().positive(),
  to: addr,
  data: hexData,
  value: quantity,
  nonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  gas: quantity,
  gasPrice: quantity.optional(),
  maxFeePerGas: quantity.optional(),
  maxPriorityFeePerGas: quantity.optional(),
});
export type TransactionRequest = z.infer<typeof TransactionSchema>;

export const VoucherSchema = z.strictObject({
  recipient: addr,
  amount: quantity,
  nonce: quantity,
  deadline: quantity,
});
export type VoucherRequest = z.infer<typeof VoucherSchema>;

export interface Limits {
  chainId: number;
  distributor?: Address;
  faucet?: Address;
  maxGas: bigint;
  maxFeePerGas: bigint;
  maxDataBytes: number;
  faucetMaxAmount: bigint;
  voucherMaxTtl: bigint;
}

const same = (a: string, b: string | undefined) => !!b && a.toLowerCase() === b.toLowerCase();

/** The call must decode as the one allowed function and carry nothing else. */
function isCall(abi: Abi, functionName: string, data: Hex): boolean {
  try {
    const call = decodeFunctionData({ abi, data });
    return call.functionName === functionName && encodeFunctionData({ abi, functionName, args: call.args as never }) === data.toLowerCase();
  } catch {
    return false;
  }
}

/** Returns the allowed call's name and the most the transaction can cost in L2 fees, or throws. */
export function checkTransaction(role: TxRole, tx: TransactionRequest, limits: Limits): { call: string; maxFee: bigint } {
  if (!limits.distributor) throw new PolicyError("not_configured", 503);
  if (tx.chainId !== limits.chainId) throw new PolicyError("wrong_chain");
  if (tx.value !== 0n) throw new PolicyError("value_not_allowed");
  const data = tx.data as Hex;
  if (size(data) > limits.maxDataBytes) throw new PolicyError("data_too_large");

  let call: string;
  if (same(tx.to, limits.distributor)) {
    call = role === "publisher" ? "proposeRoot" : "claimMany";
    if (!isCall(miningDistributorAbi as Abi, call, data)) throw new PolicyError("call_not_allowed");
  } else if (role === "relayer" && same(tx.to, limits.faucet)) {
    call = "drip";
    if (!isCall(faucetAbi as Abi, call, data)) throw new PolicyError("call_not_allowed");
  } else {
    throw new PolicyError("target_not_allowed");
  }

  if (tx.gas === 0n || tx.gas > limits.maxGas) throw new PolicyError("gas_out_of_range");
  let feePerGas: bigint;
  if (tx.type === "legacy") {
    if (tx.gasPrice === undefined || tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined) throw new PolicyError("fee_fields_invalid", 400);
    feePerGas = tx.gasPrice;
  } else {
    if (tx.gasPrice !== undefined || tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) throw new PolicyError("fee_fields_invalid", 400);
    if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) throw new PolicyError("fee_fields_invalid", 400);
    feePerGas = tx.maxFeePerGas;
  }
  if (feePerGas > limits.maxFeePerGas) throw new PolicyError("fee_too_high");
  return { call, maxFee: tx.gas * feePerGas };
}

export function checkVoucher(v: VoucherRequest, limits: Limits, nowSeconds: bigint): void {
  if (!limits.faucet) throw new PolicyError("not_configured", 503);
  if (/^0x0{40}$/.test(v.recipient)) throw new PolicyError("recipient_not_allowed");
  if (v.amount === 0n || v.amount > limits.faucetMaxAmount) throw new PolicyError("amount_out_of_range");
  if (v.deadline <= nowSeconds || v.deadline > nowSeconds + limits.voucherMaxTtl) throw new PolicyError("deadline_out_of_range");
}

/** A spending allowance that starts again each UTC day. Held in memory: a restart starts the day again. */
export class DailyBudget {
  private day = -1;
  private spent = 0n;
  constructor(private readonly limit: bigint) {}

  /** Takes `amount` from today's allowance, or throws without taking anything. */
  spend(amount: bigint, nowMs: number): void {
    const day = Math.floor(nowMs / 86_400_000);
    if (day !== this.day) {
      this.day = day;
      this.spent = 0n;
    }
    if (this.spent + amount > this.limit) throw new PolicyError("daily_limit_reached", 429);
    this.spent += amount;
  }
}
