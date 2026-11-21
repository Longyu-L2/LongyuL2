# LONGYU Mining Specification

This is the rule set the contracts and the reward engine implement. Where any other description of LONGYU mining disagrees with this file, this file is right.

## Sessions

- A session lasts 24 hours. A new session may start 20 hours after the previous start.
- A session counts for the UTC day in which it **starts**, at most one per day. The 4-hour early-renewal window stops start times drifting past midnight and costing a day.
- The phone does no work. "Mining" is a participation reward.

## Daily reward

```
w_i = b × τ_i × (1 + s_i + n_i + c_i) × (1 + p_i)   all factors in basis points, rounded down
k   = min(1, E_d / Σ w)
r_i = floor(k × w_i)                          so Σ r_i ≤ E_d always
```

| Parameter | Testnet launch value | Notes |
|---|---|---|
| b, base reward | 24 tLONG | shown as 1 tLONG per hour |
| τ, tier multiplier | T0 = 0, T1 = 1.0, T2 = 1.0, T3 = 1.15 | see "Tiers" |
| s, streak | +2% per consecutive day, cap +20% | |
| n, invites | +5% for each counted invite, cap +25% | see "Invite bonus" |
| c, contribution | **0 at launch** | cap +10% if enabled later |
| p, mining capacity | 0 without a plan; +10% (C1) to +100% (C5) while one runs | paid in BNB on BSC; see "Mining capacity plans" |
| E_d, daily budget | 12,000,000 tLONG | from EmissionSchedule |
| Highest launch reward | 40.02 tLONG (T3, full streak, five counted invites) | 1.6675 × b |
| Per-user bound on-chain | 90 tLONG × (day + 1) | covers every bonus and the largest boost at their caps (1.7825 × 2 × b = 85.56) |

The budget is a ceiling, not an amount shared out. While the weights of everyone mining that day add up to no more than E_d, k is 1 and every miner is paid their full weight: a bonus or a plan on one account takes nothing from another, and the rest of the day's budget is not paid to anyone. Above that, every reward is scaled by the same k. With every miner at the base weight of 24:

| Miners that day | Paid to each | Paid in total |
|---|---|---|
| 1,000 | 24 tLONG | 24,000 |
| 100,000 | 24 tLONG | 2,400,000 |
| 500,000 | 24 tLONG | 12,000,000 |
| 1,000,000 | 12 tLONG | 12,000,000 |
| 5,000,000 | 2.4 tLONG | 12,000,000 |

## Tiers

| Tier | Reached by |
|---|---|
| T0 | Signing in. Cannot mine |
| T1 | Passing the device check (in a browser, the human check) |
| T2 | Verifying identity: one person, one account |
| T3 | Verified, 60 or more mining days, and never held by a risk rule |

On testnet, mining does not wait for an identity check: T1 earns the full rate, straight into its entitlement. The check is asked for before mainnet conversion, and the migration snapshot counts verified accounts only. What stands between one person and many accounts until then is the X sign-in, the device or human check and the risk rules below. The daily budget E_d is fixed either way, so extra accounts take a larger share of it and cannot enlarge it.

The engine also carries a gated parameter set (`VERIFICATION_GATED_PARAMS`: T1 = 0.5, held off-chain until the account verifies). It is not in use.

## Mining capacity plans (paid boosts)

Miners can buy mining capacity: classes C1 to C5, each for an epoch of 7, 30 or 90 days, paid in BNB. In the code and the API a plan is called a boost. A boost multiplies the miner's weight, so it raises their share of the day's fixed budget E_d. It never raises E_d, so boosts cannot create tokens; when demand exceeds the budget, everyone else's share shrinks accordingly.

| Rule | Value |
|---|---|
| Plans at launch | 15, set by `BOOST_PLANS`: class C1 1.10×, C2 1.25×, C3 1.50×, C4 1.75×, C5 2.00×, each for 7, 30 or 90 days |
| Prices at launch (BNB) | Daily rate per class: C1 0.0002, C2 0.0004, C3 0.0007, C4 0.001, C5 0.0013; 10% off for 30 days, 20% off for 90. So C1 for 7 days costs 0.0014 BNB, C3 for 30 days 0.0189, C5 for 90 days 0.0936. |
| Receipt | The payment transaction on BSC (PaymentRouter emits the order ID, which it derives from the order's reference, the token and the amount), linked from the payment page |
| Rate estimate | The app's hourly estimate includes today's plan, exactly as settlement counts it |
| Who can buy | Accounts that earn into their entitlement (T1 and above at launch) and are not banned |
| Payment | BNB on BSC through PaymentRouter; the boost starts once the payment is final |
| Start | The mining day the payment was made, or right after the buyer's current boost; boosts never overlap |
| Held or banned accounts | Earn nothing, boosted or not |
| Refund | A boost not yet begun is cancelled; a running one ends that day; settled days stay as they were |
| Limits | At most +100%; at most three unpaid orders per account; boosts can be bought up to a year ahead |

Migration to mainnet counts mined tLONG pro rata, so boosted mining earns a larger migration share.

## Invite bonus

An account that signed up with another account's invite code adds to that account's `n` on each day it counts: +5% each, at most +25% (five counted invites). The bonus is the inviter's alone, and it applies only on a day the inviter mines, because it multiplies their own weight. The daily budget does not change: a bonus raises a miner's share of it.

An invited account counts on a mining day when all of this holds:

- it mined that day, is not banned, is at an entitled tier and has no open hold flag;
- its session did not run on an app install or browser the inviter has signed in on;
- its session came from a network address other than the inviter's that day.

Invited accounts that mined from one network address count once between them. A network address is an IPv4 address, or the /64 of an IPv6 address.

The estimate the app shows and the settlement count with the same rule. The bonus has a deployment switch (`INVITE_REWARD` in the API's configuration): off, `n` is 0 for everyone from the next settlement on, and days already settled stay as they were.

## Streak

- +1 per credited day. Every 7 consecutive days banks a grace day, at most 2.
- A missed day uses a grace day if one is banked; otherwise the streak halves.

## Ledger

- Rewards of the entitled tiers (`entitledFromTier`: T1 and above at launch) go straight into the account's cumulative entitlement, which is the Merkle leaf.
- Rewards of a tier below that are **pending** and stay off-chain. When the account reaches the entitled tier, the backlog is released oldest first, as long as both on-chain limits below hold. Anything that does not fit is deferred to the next day, in strict first-in, first-out order. At launch no tier earns pending rewards.
- Pending rewards of accounts that never reach the entitled tier expire after 90 days and are never emitted.
- **Freezing** (a wallet change or a ban) lowers the address's leaf to what it has claimed and moves the rest into a **reserve**. The reserve is not in any leaf, but it stays in the root's declared total, so anything an older, still-live root lets that address claim is covered. Once no live root can pay the address more than it has claimed, the reserve moves to the new wallet (a wallet change) or is dropped (a ban). This takes about two days. Rewards are never paid twice, and nothing is stranded when the old key is lost.
- A frozen address keeps a leaf, even at zero, so each new root retires its old, higher leaf.
- Settlement never stops because of anything a user does. Inconsistencies are repaired conservatively and listed in the day's `stats.alerts`.

## Risk rules

Rules run on each closed day, just before settlement. A **hold** flag keeps the account's rewards for that day out of the root until an admin clears it. A **watch** flag only queues the account for review.

| Rule | Flag | Looks for |
|---|---|---|
| Shared device | hold | One app install used by more than one account that mined that day. A flag an admin cleared for an install is not raised again for that install |
| Network cluster | watch | Many accounts mining from one network address in a day |
| Attestation failures | hold | A device that keeps failing its integrity check |
| Regular timing | watch | Sessions that start at the same moment of the day, time after time |
| Wallet sweep | hold, or watch for a contract | Several accounts sending the reward asset to one address within a set window |

The thresholds are deployment settings (`RISK_*` and `SWEEP_*` in the API's configuration), not part of this specification.

Wallet-sweep details:
- A background job records reward-asset transfers out of every wallet a user has linked, now or before. Reverted transfers and transfers to oneself are ignored.
- If the shared destination has no code, the senders are held, and so is any account that owns the destination.
- If the destination is a contract, such as a bridge, a DEX or a multisig, only watch flags are raised, so a popular contract cannot freeze its users.
- `SWEEP_ALLOWLIST` (bridges, exchanges) and LONGYU's own contracts are never flagged. Once an admin clears an account's flag for a destination, it is not raised again for that destination.

## On-chain limits (MiningDistributor)

| Limit | Rule |
|---|---|
| Running budget cap | root total ≤ cumulative budget up to the root's day |
| Growth cap | root total − previous root total ≤ `maxDailyIncrease` × days elapsed |
| Payout cap | total paid ≤ the active root's declared total |
| Per-user bound | leaf ≤ `maxRewardPerDay` × (day + 1) |
| Claimed floor | root total ≥ total already claimed, checked when the root is posted and again when it activates; a root below it at activation is dropped and the root before it stays claimable |
| Ordering | one root per closed UTC day, strictly increasing, one waiting at a time |
| Veto window | 12 hours; the guardian can veto a waiting root. The wait is fixed when the root is posted: a setting change can lengthen it, not shorten it |
| Pause | the guardian pauses; only the admin (timelock) unpauses; nothing matures while paused |
| Replay protection | leaf = keccak256(keccak256(abi.encode(chainId, distributor, account, cumulative))) |

## Migration (MigrationDistributor)

- The snapshot counts accounts that verified their identity (T2 and above), are not banned or on hold, mined the minimum number of days, are outside the excluded regions and have a wallet. An account verified by a BABT must still hold it when the snapshot is taken. They share a fixed pool in proportion to the tLONG they earned. Nothing is converted at a rate, and tLONG that was bought or received counts for nothing.
- One fixed root of (account, total allocation), settable only before claims open.
- 25% vests at claim start, the rest linearly over 12 months.
- Claims track the amount already paid, so users claim as tokens vest and are never paid twice.
- `claimTo` lets an account send its allocation to another address with an EIP-712 signature (EOA or ERC-1271), using a per-account nonce.
- Whatever is unclaimed at the end goes to a fixed community recipient.

## Published data per root

`longyu-mining-root/1` JSON with sorted keys: chain ID, distributor, day, root, total, leaf encoding, every (account, cumulative) entry and the day's statistics. Its keccak256 is posted on-chain as `dataHash`, so anyone can rebuild the tree and check it.
