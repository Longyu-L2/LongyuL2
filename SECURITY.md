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

The network is on testnet. The contracts have unit, fuzz and invariant tests and an internal review, and have not had an external audit. An external audit comes before mainnet.

## Design limits worth knowing

These hold even if a backend key is stolen:

- A mining root becomes claimable only after a challenge delay, and the guardian can veto it during that time.
- A root's total can never exceed the emission schedule's cumulative budget, and can grow by at most a fixed amount per day.
- The vault releases funds only up to what is entitled and unclaimed. It has no withdraw function.
- The faucet enforces its own daily cap on chain.
- The API holds no signing keys. A separate private service signs, and only the specific calls it is built for.
- A payment counts for an order only if it is the order's exact token and amount. The router derives the order ID from the reference, the token and the amount.

Known limits of the testnet deployment, to be closed before mainnet:

- One testnet admin key holds every privileged role: the rollup's upgrade rights on BSC (through SystemOwnerSafe, a Safe with that key as its only signer), the L2 ProxyAdmin (`0x4200000000000000000000000000000000000018`), the system config, the admin and guardian roles of the mining contracts, the swap factory's fee setter, and the tLONG on BSC testnet that has not been bridged. Mainnet moves each of them to a multisig, the upgrade and admin roles behind a timelock.
- The growth limit bounds a root's total, not who it pays. A stolen publisher key could propose a root that hands everything entitled and not yet claimed to other accounts, within the bound per account. The challenge delay and the guardian's veto are the defence, and the API's health check reports any root on chain that it did not compute.
- A root's total is compared with the amount already claimed when the root is proposed, and not again when it activates. If a root that lowers the total waits while claims continue, the total can end below what was paid, and claims then stop until a later root. Nothing is overpaid.
- The guardian's veto depends on someone looking within the challenge delay. The delay is a setting and the watch is manual on testnet.
- `MiningDistributor.setChallengeDelay` also applies to a root that is already waiting, and a root that waited through a pause becomes claimable when the pause ends. Both are admin-only paths.
- A withdrawal to BSC can be finalized 10 minutes after its state root is posted; the stack's usual wait is seven days. A wrong state root can be deleted only inside that window, by the challenger (the admin key), and nothing deletes one automatically. Whoever held the proposer key could post a false root and take what the bridge holds on BSC testnet, which is test BNB and tLONG. The wait was shortened on 21 November 2026 so that testers get a withdrawal back in minutes.
- Mining on testnet does not wait for an identity check, so one person with several X accounts and devices can mine with each. That dilutes other miners' share of the fixed daily budget and cannot enlarge it. Mainnet conversion counts verified accounts only.
- `MiningDistributor.claimMany` with the native asset would revert as a batch if one recipient refused the transfer. The deployed distributor pays an ERC-20, where this cannot happen.

## Before mainnet

- An external audit of the mining contracts, the faucet, the payment router and the two swap patches.
- Multisigs for every role above, with a timelock on upgrades and admin settings, and the handover checked on chain.
- The distributor changes listed above: the claimed amount checked at activation, and a setting change that cannot shorten the wait of a root already posted.
- A watch on the challenge delay that does not depend on one person, and a delay long enough for it.
- A one-hour withdrawal wait, and with it a challenger that checks every posted state root against its own node and deletes a wrong one without a person. A wait that short is only as safe as that challenger, so it is part of the audit, and it runs on separate infrastructure from the proposer.
- Identity verification before any conversion to LONG.
- The sequencer, batcher and proposer keys in hardware or a key service, and a second L1 RPC provider.
