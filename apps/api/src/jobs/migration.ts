/**
 * Testnet-to-mainnet migration snapshot (docs/MINING_SPEC.md).
 *
 * Eligible people share a fixed pool of mainnet $LONG in proportion to the tLONG they earned:
 *   a_i = floor(P * e_i / sum(e))
 * where e_i counts every address the person ever used (rewards follow wallet changes).
 * Nothing is converted at a rate; buying or receiving tLONG counts for nothing.
 *
 * An account verified with a BABT is known by the address that held the token, and the token can be
 * revoked and minted again to another address, which could then verify a second account. So the
 * snapshot reads each such address again and counts the account only while it still holds one.
 */
import { getAddress } from "viem";
import { buildTree, canonicalJson, hashJson, type Address, type RewardTree } from "@longyu/reward-engine";
import type { Queryable } from "../db/index.ts";
import { toBig } from "../lib/util.ts";
import type { ChainGateway } from "../services/chain.ts";

export const MIGRATION_FORMAT = "longyu-migration/1";

export interface MigrationRules {
  /** Last testnet day that counts. The ledger must be settled up to exactly this day. */
  snapshotDay: bigint;
  /** Mainnet $LONG to share, in wei (proposal: 500,000,000 LONG). */
  pool: bigint;
  /** Minimum credited mining days (proposal: 30). */
  minMiningDays: number;
  /** ISO country codes excluded from the allocation. */
  excludedCountries: string[];
  /** Allocations above this are held until the person passes KYC; null disables the hold. */
  kycThreshold: bigint | null;
}

export type ExclusionReason =
  | "banned" | "not_verified" | "babt_not_held" | "on_hold" | "too_few_days" | "excluded_region" | "no_wallet" | "nothing_mined";

export interface MigrationEntry {
  userId: string;
  account: Address;
  mined: bigint;
  allocation: bigint;
}

export interface MigrationResult {
  rules: MigrationRules;
  entries: MigrationEntry[];
  heldForKyc: MigrationEntry[];
  excluded: Record<ExclusionReason, number>;
  totalMined: bigint;
  totalAllocated: bigint;
  root: `0x${string}` | null;
  tree: RewardTree | null;
  dataJson: string;
  dataHash: `0x${string}`;
}

export async function computeMigration(
  q: Queryable,
  rules: MigrationRules,
  target: { chainId: bigint; distributor: Address },
  chain: Pick<ChainGateway, "babtBalance">,
): Promise<MigrationResult> {
  const meta = (await q.query<{ last_settled_day: bigint | null }>("SELECT last_settled_day FROM ledger_meta WHERE id = 1")).rows[0];
  if (meta?.last_settled_day !== rules.snapshotDay) {
    throw new Error(`ledger is settled to day ${meta?.last_settled_day ?? "none"}, snapshot day is ${rules.snapshotDay}`);
  }

  const users = (await q.query<{
    id: string; tier: number; banned: boolean; country: string | null; wallet: string | null; days: bigint; on_hold: boolean;
    babt_key: string | null;
  }>(
    `SELECT u.id, u.tier, u.banned, u.country, w.address AS wallet,
            (SELECT count(*) FROM mining_sessions m WHERE m.user_id = u.id AND m.credited_day <= $1)::bigint AS days,
            (SELECT v.unique_key FROM verifications v
             WHERE v.user_id = u.id AND v.status = 'approved' AND v.provider = 'babt'
               AND NOT EXISTS (SELECT 1 FROM verifications o WHERE o.user_id = u.id AND o.status = 'approved' AND o.provider <> 'babt')
             LIMIT 1) AS babt_key,
            EXISTS (SELECT 1 FROM flags f WHERE f.user_id = u.id AND f.severity = 'hold' AND f.status IN ('open','confirmed')) AS on_hold
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id
     ORDER BY u.id`,
    [rules.snapshotDay],
  )).rows;

  // Every address each user has used, and what the ledger holds for it (leaf plus moving reserve).
  const addressRows = (await q.query<{ user_id: string; address: string }>(
    `SELECT user_id, address FROM wallets
     UNION SELECT user_id, from_address FROM wallet_changes
     UNION SELECT user_id, to_address FROM wallet_changes`,
  )).rows;
  const ledger = new Map(
    (await q.query<{ address: string; cumulative: string; reserve: { to: string | null; amount: string } | null }>(
      "SELECT address, cumulative::text, reserve FROM ledger_accounts",
    )).rows.map((r) => [getAddress(r.address), r]),
  );
  const minedBy = new Map<string, bigint>();
  for (const r of addressRows) {
    const l = ledger.get(getAddress(r.address));
    if (!l) continue;
    // A reserve on its way to the user's newer wallet is still theirs; a forfeited one is not.
    const reserve = l.reserve && l.reserve.to ? BigInt(l.reserve.amount) : 0n;
    minedBy.set(r.user_id, (minedBy.get(r.user_id) ?? 0n) + toBig(l.cumulative) + reserve);
  }

  // Accounts whose only verification is a BABT: the address they signed with is read again now.
  // A read that fails stops the snapshot, so no account is counted on a balance nobody saw.
  const babtGone = new Set<string>();
  for (const u of users) {
    if (u.banned || u.tier < 2 || !u.babt_key) continue;
    const holder = getAddress(u.babt_key.slice("babt:".length));
    if ((await chain.babtBalance(holder)) === 0n) babtGone.add(u.id);
  }

  const excludedSet = new Set(rules.excludedCountries.map((c) => c.toUpperCase()));
  const excluded: Record<ExclusionReason, number> = {
    banned: 0, not_verified: 0, babt_not_held: 0, on_hold: 0, too_few_days: 0, excluded_region: 0, no_wallet: 0, nothing_mined: 0,
  };
  const eligible: { userId: string; account: Address; mined: bigint }[] = [];
  for (const u of users) {
    const reason: ExclusionReason | null = u.banned
      ? "banned"
      : u.tier < 2
        ? "not_verified"
        : babtGone.has(u.id)
          ? "babt_not_held"
          : u.on_hold
            ? "on_hold"
            : Number(u.days) < rules.minMiningDays
              ? "too_few_days"
              : u.country && excludedSet.has(u.country.toUpperCase())
                ? "excluded_region"
                : !u.wallet
                  ? "no_wallet"
                  : (minedBy.get(u.id) ?? 0n) === 0n
                    ? "nothing_mined"
                    : null;
    if (reason) {
      excluded[reason]++;
      continue;
    }
    eligible.push({ userId: u.id, account: getAddress(u.wallet!) as Address, mined: minedBy.get(u.id)! });
  }

  const totalMined = eligible.reduce((s, e) => s + e.mined, 0n);
  const all: MigrationEntry[] = eligible.map((e) => ({ ...e, allocation: totalMined === 0n ? 0n : (rules.pool * e.mined) / totalMined }));
  const entries = all.filter((e) => e.allocation > 0n && (rules.kycThreshold === null || e.allocation <= rules.kycThreshold));
  const heldForKyc = all.filter((e) => e.allocation > 0n && rules.kycThreshold !== null && e.allocation > rules.kycThreshold);
  const totalAllocated = entries.reduce((s, e) => s + e.allocation, 0n);
  if (totalAllocated + heldForKyc.reduce((s, e) => s + e.allocation, 0n) > rules.pool) throw new Error("invariant: allocations exceed the pool");

  const tree = entries.length ? buildTree(target.chainId, target.distributor, entries.map((e) => ({ account: e.account, amount: e.allocation }))) : null;
  const root = tree ? (tree.root as `0x${string}`) : null;
  const dataJson = canonicalJson({
    format: MIGRATION_FORMAT,
    chainId: target.chainId,
    distributor: getAddress(target.distributor),
    root,
    rules,
    totalMined,
    totalAllocated,
    excluded,
    entries: entries.map((e) => ({ account: e.account, mined: e.mined, allocation: e.allocation })),
    heldForKyc: heldForKyc.map((e) => ({ account: e.account, allocation: e.allocation })),
  });
  return { rules, entries, heldForKyc, excluded, totalMined, totalAllocated, root, tree, dataJson, dataHash: hashJson(dataJson) };
}
