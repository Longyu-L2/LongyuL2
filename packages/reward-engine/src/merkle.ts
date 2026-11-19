/**
 * Merkle trees in exactly the format the distributor contracts verify:
 * leaf = keccak256(keccak256(abi.encode(chainId, contract, account, amount))).
 * This is OpenZeppelin's StandardMerkleTree, so third parties can rebuild and check roots with
 * standard tooling.
 */

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, keccak256, stringToBytes } from "viem";
import type { Address } from "./rewards.ts";

export const LEAF_ENCODING = ["uint256", "address", "address", "uint256"] as const;

export interface LeafEntry {
  account: Address;
  amount: bigint;
}

export type RewardTree = StandardMerkleTree<[string, string, string, string]>;

export function buildTree(chainId: bigint, contract: Address, entries: readonly LeafEntry[]): RewardTree {
  if (entries.length === 0) throw new Error("cannot build a tree with no entries");
  const seen = new Set<string>();
  const values = entries.map((e) => {
    const account = getAddress(e.account);
    if (seen.has(account)) throw new Error(`duplicate leaf for ${account}`);
    seen.add(account);
    if (e.amount < 0n) throw new Error("negative amount");
    return [chainId.toString(), getAddress(contract), account, e.amount.toString()] as [string, string, string, string];
  });
  return StandardMerkleTree.of(values, [...LEAF_ENCODING]);
}

export function proofFor(tree: RewardTree, account: Address): { amount: bigint; proof: `0x${string}`[] } {
  const target = getAddress(account);
  for (const [i, v] of tree.entries()) {
    if (v[2] === target) return { amount: BigInt(v[3]), proof: tree.getProof(i) as `0x${string}`[] };
  }
  throw new Error(`no leaf for ${target}`);
}

/** Every leaf's proof, in one pass over the tree (O(n log n)); use this for whole settlements. */
export function proofMap(tree: RewardTree): Map<Address, { amount: bigint; proof: `0x${string}`[] }> {
  const out = new Map<Address, { amount: bigint; proof: `0x${string}`[] }>();
  for (const [i, v] of tree.entries()) {
    out.set(v[2] as Address, { amount: BigInt(v[3]), proof: tree.getProof(i) as `0x${string}`[] });
  }
  return out;
}

/** Canonical JSON (sorted keys, bigint as decimal strings) so the published file hashes the same everywhere. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function hashJson(json: string): `0x${string}` {
  return keccak256(stringToBytes(json));
}
