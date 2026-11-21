# LONGYU mainnet

Not launched. Chain 668800, settling on BSC (chain 56). This folder receives the chain files when the rollup is deployed (`genesis.json`, `rollup.json`, `deploy-config.json`, `l1-deployments.json`, `l2-allocs.json`), exactly as [../testnet](../testnet) did.

## What differs from the testnet

| | Testnet | Mainnet |
|---|---|---|
| Withdrawal wait on BSC | 10 minutes | 1 hour |
| Who deletes a wrong state root | the watchtower's key (since 21 November 2026) | the watchtower's key, from the first block |
| System config owner, guardian (pause), fee recipient | the testnet admin key | the founders' Safe, from the first block |
| Upgrade rights on BSC and on LONGYU | the testnet admin key | a timelock (2 days) that only the founders' Safe can use |
| Reward token | tLONG, 10 billion held by the admin key | LONG, created on LONGYU only by mining (at most 10 billion), and locked until the TGE |

## Launch order

Every step has a check that runs against the chain afterwards (`--sig "verify()"`), and the whole sequence is rehearsed on a fork of BSC first with `chain/mainnet/rehearse.sh`, which spends nothing.

1. **Keys.** A new keys file for mainnet: deployer, sequencer, batcher, proposer and the watchtower's challenger and guardian. No key of the testnet's is reused.
2. **The founders' Safe on BSC**: `contracts/script/CreateSafe.s.sol`, at least two signers on their own devices, at least two signatures.
3. **The rollup**: `MODE=bsc chain/testnet/deploy-rollup.sh` with `NETWORK` mainnet settings (the Safe's address as `safe.address` in the keys file). It refuses a Safe address without code.
4. **The handover on BSC**: `contracts/script/HandoverMainnetBsc.s.sol`. The upgrade rights move to the timelock; the SystemOwnerSafe the deployment created owns nothing afterwards.
5. **The chain on Railway**: a project of its own, built with `NETWORK=mainnet`, and the watchtower in a second project of its own, with its own node (`ROLE=verifier`).
6. **The founders' Safe on LONGYU** and `contracts/script/HandoverMainnetLongyu.s.sol`.
7. **LONG and mining**: `contracts/script/DeployMainnetMining.s.sol`. LONG starts at zero supply; the minting vault creates it only as mining rewards become claimable, within the emission schedule and the mining pool. Miners hold what they claim, but nobody can move it until the TGE (or the latest unlock date fixed in the token), so no pool can exist before then. The timelock is admin of everything; the Safe and the two watch keys are guardians.
8. **Apps and pages** switched to the mainnet addresses, with mined LONG shown as locked until the TGE; contracts verified on the explorer; the chain registry entry (`../registry/eip155-668800.json`).
9. **At the TGE**: LONG unlocked by the timelock, the allocations created (`mintAllocation`, within what the mining pool leaves of the 10 billion), LONG's copy on BSC created through the bridge's token factory, the migration root and the first liquidity.

## Rehearsal

`chain/mainnet/rehearse.sh` runs steps 2 to 4 on a fork of BSC with throwaway keys and reports the gas of each step at BSC's gas price.
