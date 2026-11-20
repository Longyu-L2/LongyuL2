/**
 * The invite bonus. An account that signed up with someone's invite code raises that person's
 * mining weight on each day it mines, by the reward engine's rate and up to its cap. The day's
 * emission is fixed, so the bonus raises the inviter's share of it and never creates tokens.
 *
 * An invited account counts on a mining day when all of this holds:
 *  - it mined that day, is not banned, is at the entitled tier and has no open hold;
 *  - its session did not run on an app install or browser the inviter has signed in on;
 *  - its session came from a network address other than the inviter's that day.
 * Invited accounts that mined from one network address count once between them.
 *
 * The status answer and the settlement both count with the query below, so the estimate a miner
 * sees is what the settlement pays unless something changes before the day closes.
 */
import { TESTNET_LAUNCH_PARAMS, type RewardParams } from "@longyu/reward-engine";
import type { Config } from "./config.ts";
import type { Deps } from "./context.ts";
import type { Queryable } from "./db/index.ts";

/** The reward parameters this deployment runs: the launch set, without the invite bonus when INVITE_REWARD is off. */
export function rewardParams(config: Pick<Config, "INVITE_REWARD">): RewardParams {
  return config.INVITE_REWARD ? TESTNET_LAUNCH_PARAMS : { ...TESTNET_LAUNCH_PARAMS, referralBpsPerInvite: 0n };
}

/** $1 the mining day, $2 the entitled tier, and with `one` $3 the inviter. */
const counted = (one: boolean): string => `
  SELECT v.referred_by AS user_id, count(DISTINCT m.ip)::int AS n
  FROM users v
  JOIN mining_sessions m ON m.user_id = v.id AND m.credited_day = $1
  JOIN devices d ON d.id = m.device_id
  LEFT JOIN mining_sessions im ON im.user_id = v.referred_by AND im.credited_day = $1
  WHERE ${one ? "v.referred_by = $3" : "v.referred_by IS NOT NULL"}
    AND NOT v.banned AND v.tier >= $2
    AND m.ip IS NOT NULL AND m.ip IS DISTINCT FROM im.ip
    AND NOT EXISTS (SELECT 1 FROM flags f WHERE f.user_id = v.id AND f.status = 'open' AND f.severity = 'hold')
    AND NOT EXISTS (SELECT 1 FROM devices x WHERE x.user_id = v.referred_by AND x.install_id = d.install_id)
  GROUP BY v.referred_by`;

/** Every inviter's counted invites on a mining day. Empty while the bonus is off. */
export async function activeInvites(q: Queryable, deps: Deps, day: bigint): Promise<Map<string, number>> {
  if (deps.rewards.referralBpsPerInvite === 0n) return new Map();
  const { rows } = await q.query<{ user_id: string; n: number }>(counted(false), [day, deps.rewards.entitledFromTier]);
  return new Map(rows.map((r) => [r.user_id, r.n]));
}

/** One account's counted invites on a mining day. 0 while the bonus is off. */
export async function activeInvitesOf(q: Queryable, deps: Deps, userId: string, day: bigint): Promise<number> {
  if (deps.rewards.referralBpsPerInvite === 0n) return 0;
  const { rows } = await q.query<{ n: number }>(counted(true), [day, deps.rewards.entitledFromTier, userId]);
  return rows[0]?.n ?? 0;
}

/** The bonus as the app shows it: what `active` invites add today, the rate for each and the most they can add, in bps. */
export function inviteBonus(deps: Deps, active: number): { active: number; bps: number; bpsEach: number; capBps: number } {
  const bpsEach = Number(deps.rewards.referralBpsPerInvite);
  const capBps = Number(deps.rewards.referralCapBps);
  return { active, bps: Math.min(active * bpsEach, capBps), bpsEach, capBps };
}
