/** Calls and requests the tests share. */
import { faucetAbi, miningDistributorAbi } from "@longyu/abis";
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { Limits, TransactionRequest } from "../src/policy.ts";

export const DISTRIBUTOR: Address = "0x1111111111111111111111111111111111111111";
export const FAUCET: Address = "0x2222222222222222222222222222222222222222";
export const OTHER: Address = "0x3333333333333333333333333333333333333333";
export const WORD = `0x${"ab".repeat(32)}` as Hex;

export const limits: Limits = {
  chainId: 668801,
  distributor: DISTRIBUTOR,
  faucet: FAUCET,
  maxGas: 5_000_000n,
  maxFeePerGas: 1_000_000_000n,
  maxDataBytes: 131_072,
  faucetMaxAmount: 1_000_000_000_000_000n,
  voucherMaxTtl: 900n,
};

export const proposeRoot = encodeFunctionData({ abi: miningDistributorAbi, functionName: "proposeRoot", args: [3n, WORD, 1000n, WORD, "https://data.example/roots/day-3.json"] });
export const claimMany = encodeFunctionData({ abi: miningDistributorAbi, functionName: "claimMany", args: [[OTHER], [5n], [[WORD]]] });
export const drip = encodeFunctionData({ abi: faucetAbi, functionName: "drip", args: [OTHER, 1n, 2n, 3n, "0x1234"] });
export const pause = encodeFunctionData({ abi: miningDistributorAbi, functionName: "pause" });

export const tx = (over: Partial<TransactionRequest> = {}): TransactionRequest => ({
  type: "eip1559",
  chainId: 668801,
  to: DISTRIBUTOR,
  data: proposeRoot,
  value: 0n,
  nonce: 7,
  gas: 300_000n,
  maxFeePerGas: 2_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  ...over,
});
