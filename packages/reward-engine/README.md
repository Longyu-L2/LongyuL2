# Reward engine

The rules of mining as a library with no I/O: given a day's miners and the ledger so far, it returns every account's reward, the new ledger and the Merkle tree whose root goes on chain. The API runs it once a day; anyone can run it against a published data file and get the same root.

All amounts are `bigint` in the token's smallest unit, with the same rounding as the contracts.

| Module | Contents |
|---|---|
| [src/schedule.ts](src/schedule.ts) | The emission schedule: `dayOf`, `dailyBudget`, `cumulativeBudget`, matching `EmissionSchedule.sol` |
| [src/rewards.ts](src/rewards.ts) | One day's split: `weightOf` and `computeDay`, with the launch parameters (`TESTNET_LAUNCH_PARAMS`) |
| [src/streak.ts](src/streak.ts) | Sessions and streaks: a 24-hour session, renewal after 20 hours, grace days |
| [src/settle.ts](src/settle.ts) | `settleDay`: the cumulative ledger, pending rewards and their expiry, and the published data format |
| [src/merkle.ts](src/merkle.ts) | `buildTree` and `proofFor`: leaves of (chain ID, contract, account, cumulative amount), and the canonical JSON that is hashed |

The specification these follow is [docs/MINING_SPEC.md](../../docs/MINING_SPEC.md).

## Agreement with the contracts

```sh
npm test -w @longyu/reward-engine
npm run fixture -w @longyu/reward-engine    # writes contracts/test/fixtures/engine-root.json
```

`contracts/test/EngineParity.t.sol` posts the fixture's root to the real `MiningDistributor` and claims every leaf, so a change to the engine's leaves, proofs or totals that the contract would not accept fails the contract tests.
