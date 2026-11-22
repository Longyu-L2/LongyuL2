# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Include the affected contract or service, the steps to reproduce and what an attacker gains. A proof of concept against a local fork or Anvil is welcome; do not test against the live network in a way that touches other people's funds or data.

We acknowledge reports within three days and keep the reporter informed until the fix is live.

## Scope

| In scope | Notes |
|---|---|
| Contracts in `contracts/src` | Mining distributor, vault, emission schedule, faucet, migration distributor, payment router, token |
| `contracts/dex` | Only the two local patches and the deployment script; report upstream Uniswap V2 issues upstream |
| `apps/api`, `apps/signer` | Authentication, settlement, claims, the faucet, the admin console |
| `apps/web`, `apps/explorer`, `apps/mobile` | Anything that lets one user act as another, or that runs untrusted content |
| `chain/railway/rpc` | The public RPC gateway |

Out of scope: denial of service by volume, findings that need a rooted or modified device belonging to the victim, and issues in the L2 node software itself (report those to [bnb-chain/opbnb](https://github.com/bnb-chain/opbnb)).

## Status

Mainnet (chain 668800 on BNB Smart Chain) has been live since 21 November 2026; the testnet (chain 668801 on BSC testnet) runs beside it. The contracts have unit, fuzz and invariant tests, an internal review and review passes by reviewers that did not write them, whose findings were fixed before launch. They have not had an external audit, and the project does not plan one.

## Design limits worth knowing

These hold even if a backend key is stolen:

- A mining root becomes claimable only after a challenge delay, and the guardian can veto it during that time.
- The watch on the challenge delay is automatic: every 30 seconds the API compares the roots on chain with the ones it computed, and on a mismatch a key that holds only the guardian role vetoes a waiting root and pauses claims. Only the admin unpauses.
- A watchtower runs apart from the API and the chain's services, with its own node, which derives LONGYU from the batches on BSC, and its own keys ([apps/watchtower](apps/watchtower)). It deletes a state root on BSC that its node does not rebuild, before any withdrawal can use it, and it stops a mining root whose published file, limits or history do not check out.
- A root's total can never exceed the emission schedule's cumulative budget, and can grow by at most a fixed amount per day.
- The vault releases funds only up to what is entitled and unclaimed. The admin (a timelock on mainnet) can take back only the part of the pool beyond every daily budget to date, which no miner can have earned yet; the testnet's vault predates that and has no withdrawal at all.
- The faucet enforces its own daily cap on chain.
- The API holds no signing keys. A separate private service signs, and only the specific calls it is built for.
- A payment counts for an order only if it is the order's exact token and amount. The router derives the order ID from the reference, the token and the amount.

Known limits of the testnet (mainnet's are below):

- One testnet admin key holds every privileged role: the rollup's upgrade rights on BSC (through SystemOwnerSafe, a Safe with that key as its only signer), the L2 ProxyAdmin (`0x4200000000000000000000000000000000000018`), the system config, the admin and guardian roles of the mining contracts, the swap factory's fee setter, and the tLONG on BSC testnet that has not been bridged. Mainnet moves each of them to a multisig, the upgrade and admin roles behind a timelock.
- The growth limit bounds a root's total, not who it pays. A stolen publisher key could propose a root that hands everything entitled and not yet claimed to other accounts, within the bound per account. The challenge delay and the guardian's veto are the defence, and the API's health check reports any root on chain that it did not compute.
- The API's own watch runs inside the API and goes with it if the API is taken over. The watchtower does not, but it checks a mining root against the API's published file: someone holding both the API and the publisher key can still steer new rewards to accounts of their own within the contract's per-account bound and the watchtower's limits on new and frozen accounts. Either watch can pause claims; that halts claims and moves no funds.
- A root that waited through a pause becomes claimable when the pause ends. That is an admin-only path.
- A withdrawal to BSC can be finalized 10 minutes after its state root is posted; the stack's usual wait is seven days. A wrong state root can be deleted only inside that window. The watchtower's own node is still catching up with the testnet's history; until it has, roots past it are rebuilt from the public RPC, which catches a root posted with a stolen proposer key but not a sequencer that lies. The wait was shortened on 21 November 2026 so that testers get a withdrawal back in minutes.
- The watchtower's pause and veto go to the sequencer through the public RPC. A sequencer that refuses them delays them.
- Mining on testnet does not wait for an identity check, so one person with several X accounts and devices can mine with each. That dilutes other miners' share of the fixed daily budget and cannot enlarge it. Mainnet conversion counts verified accounts only.
- `MiningDistributor.claimMany` with the native asset would revert as a batch if one recipient refused the transfer. The deployed distributor pays an ERC-20, where this cannot happen.

## Mainnet

In place since launch on 21 November 2026, each checked on chain:

- The founders' Safe (two of three signers) owns the system config, holds the pause and receives every fee and payment, from the first block. The upgrade rights on BSC and on LONGYU sit behind two-day timelocks that only that Safe can use; the deploying keys hold no role.
- LONG has no supply until mining creates it, within a fixed pool, and cannot be moved, approved or pooled before the TGE (or a latest unlock date fixed in the token).
- Withdrawals to BSC wait one hour, with the watchtower's challenger and its own node running from the first block on infrastructure separate from the chain's.
- The mining contracts, the watchtower and the LONG token were reviewed by reviewers that did not write them; every finding was fixed before deployment.

Known limits of mainnet:

- The sequencer, batcher, proposer and publisher keys are hot keys held by the services that use them, not yet in hardware or a key service.
- The watchtower's pause and veto go to the sequencer through the public RPC; sending them also as deposits through BSC, so a sequencer cannot refuse them, is the next step.
- A one-hour withdrawal wait is only as safe as the challenger watching it.
- The mining-root limits above (the growth bound, the API's own watch) apply on mainnet as on testnet.
- LONGYU Swap and LONGYU Launch are open to anyone: tokens made by others are theirs, not LONGYU's. Pages and the explorer mark the official LONG and warn on look-alikes.
- Identity verification before the TGE.
