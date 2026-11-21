# Contracts

Solidity 0.8.28, Foundry, OpenZeppelin 5.6.1. The DEX is a separate project in [dex/](dex/).

| Contract | What it does |
|---|---|
| `EmissionSchedule` | The mining budget per day and in total. Immutable parameters, integer maths the reward engine reproduces exactly. |
| `MiningVault` | Holds the mining pool. Releases to the distributor only what is entitled and unclaimed, never more than the schedule's cumulative budget. No withdraw function. |
| `MiningDistributor` | One Merkle root per UTC day of every account's cumulative reward. A root waits out a challenge delay before it pays, and the guardian can veto it. |
| `Faucet` | Testnet gas against a signed voucher, with a daily cap enforced on chain. |
| `MigrationDistributor` | Pays the mainnet token to testnet miners from one fixed root, with vesting. |
| `PaymentRouter` | Takes BNB or approved tokens on BSC for an order, forwards them to the treasury and emits one event per order. Holds no funds. |
| `LongToken` | Fixed-supply BEP-20 with permit. Minted once in the constructor. |

The reward rules these implement are in [docs/MINING_SPEC.md](../docs/MINING_SPEC.md).

## Build and test

```sh
cd contracts
forge install --no-git foundry-rs/forge-std@v1.17.0
forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.6.1
forge build
forge test
```

`lib/` is git-ignored; the two commands above fetch the pinned libraries.

The suite has unit, fuzz and invariant tests. `EngineParity.t.sol` claims every leaf of roots built by the TypeScript reward engine (`packages/reward-engine`), so the engine and the contract cannot drift apart. `MiningInvariant.t.sol` checks under random action sequences that payouts never pass the budget and nothing is paid twice.

## Roles

| Role | Holder | Can |
|---|---|---|
| Admin | Multisig or timelock | Grant roles, change limits, unpause, point the vault at a new distributor |
| Guardian | Multisig | Pause, veto a waiting root |
| Publisher | Backend key | Post the daily root, inside the budget and growth caps |
| Faucet signer | Backend key | Sign faucet vouchers, inside the on-chain daily cap |

Claims need no role: anyone may submit one, and it pays only the account named in the leaf.

`DeployMining` gives the deployer admin rights only long enough to wire the contracts, then renounces them. The handover scripts move the remaining admin powers (rollup contracts on BSC, the DEX fee setter, the predeploy proxy admin) from the testnet admin key to multisigs; `test/Handover.t.sol` covers both.

## Scripts

| Script | Purpose |
|---|---|
| `DeployMining.s.sol` | Schedule, vault, distributor and faucet on the L2 |
| `DeployTestToken.s.sol`, `CreateL2Token.s.sol`, `BridgeToL2.s.sol` | The testnet token on BSC and its bridged form on the L2 |
| `AllocateLong.s.sol` | Mint the fixed $LONG supply on BSC and split it across the allocation and vesting wallets |
| `DeployMigration.s.sol` | The migration distributor |
| `DeployPaymentRouter.s.sol` | The payment router on BSC |
| `CreateSafe.s.sol`, `Safes.sol` | Multisig setup |
| `HandoverLongyu.s.sol`, `HandoverBsc.s.sol` | Move ownership from the deployer to the multisigs |
| `SetWithdrawalWait.s.sol` | Change how long a withdrawal waits on BSC, in one Safe transaction that leaves the output oracle on its own implementation |
