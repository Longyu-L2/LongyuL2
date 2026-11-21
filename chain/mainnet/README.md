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

## Deployed

Launched on 21 November 2026 at 17:58:20 UTC, from BSC block 134931142. The genesis file's SHA-256 is `2effd38dc204641332b29ab018223045cfd2cb265e06f1642c4dd4ca41442f8b`. Rollup contracts on BSC: [l1-deployments.json](l1-deployments.json).

| What | Where | Address |
|---|---|---|
| Founders' Safe (two of three): treasury, system config owner, guardian, fee recipient | BSC | `0x426Ff9521BfA16A413162eeE550CB6560Ba41074` |
| Timelock (2 days, only the Safe proposes and runs): the rollup's upgrade rights | BSC | `0x590415ECB7cd1784E56E2c3af9e3D9e0dEB3E722` |
| OptimismPortal (deposits and withdrawals) | BSC | `0x09BD641f8A55cDC49851f828cb392134c9aE35eb` |
| L1StandardBridge | BSC | `0xA44A484bfDBfB97951A172fC798389Dd37599a5a` |
| L2OutputOracle (state roots; withdrawals wait 1 hour) | BSC | `0x77fF9CDD8B92869D428956695dE0e2d94a75aDC8` |
| ProxyAdmin (owned by the timelock above) | BSC | `0x5767D430cbBc422c2B9E6a81390cF56C737B87Ab` |
| Founders' Safe on LONGYU (the same two of three) | LONGYU | `0x8C0a6E6827BA2bd65D35366ee734cD69f02bF463` |
| Timelock on LONGYU (2 days, only that Safe proposes and runs): the genesis ProxyAdmin's owner | LONGYU | `0x5767D430cbBc422c2B9E6a81390cF56C737B87Ab` |

| PaymentRouter (capacity plans and partner orders, in BNB or USDT; every payment goes straight to the founders' Safe; admin: the BSC timelock) | BSC | `0x1beA1c0BE9ca54FC4942AC49D3bC634DaAED474C` |
| LONG (`LongMiningToken`: supply starts at zero, created only by mining within a 3 billion pool, locked until the TGE, unlocks by itself on 19 November 2029 at the latest) | LONGYU | `0xc6D2B2483EC93C15109FCe43d21Ac05919031655` |
| EmissionSchedule (day 0: 23 November 2026; a ceiling of 8,219,179 LONG a day, 3 billion in all) | LONGYU | `0xbe5322A2149770611B59C037A80cEFE9ea1017Fb` |
| MintingVault (creates LONG as rewards become claimable) | LONGYU | `0x185eEc50d8D22090575D48bcF416237339c9eD06` |
| MiningDistributor (daily roots, 12-hour challenge delay; guardians: the founders' Safe, the API's watch key and the watchtower) | LONGYU | `0x39F71d572a8aeE7D2DDF6F94c01f47908304f8d2` |

The mining contracts were deployed by a key used for nothing else (`0xC436309c1bff4ED19bdC0b83bec399c06B45e990`), so their addresses exist on no other chain; it must never send a transaction on BSC. Their admin is the LONGYU timelock; that key holds no role.

Services, each only through Cloudflare: RPC `https://rpc.longyu.network`, explorer `https://scan.longyu.network`, API `https://api.longyu.network`, LONGYU MINE `https://mine.longyu.network`, the pages (claim, bridge, Safe, payment) `https://app.longyu.network`.

The BSC ProxyAdmin and the LONGYU timelock have the same address: the same deploying key created each at the same transaction count, one on each chain. They are different contracts.

Safe v1.3.0 on LONGYU: the singletons and MultiSendCallOnly are in the genesis; the proxy factory (`0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC`) and the fallback handler (`0x017062a1dE2FE6b99BE3d9d37841FeD19F573804`) were deployed on launch day through the genesis SafeSingletonFactory, and their code equals Safe's published 1.3.0.

Keys: deployer `0x6beafe04B6b1A937d9e7723118BE5eF6A3049121`, sequencer `0x1524BB688C971FB3616056550aD80d94D2EE9F6A`, batcher `0xD30a32DF9e35c64f22a794C35dd2304e25f3967D`, proposer `0x5995434f37B0a1b753883ab6A8d4A346bA0Cd246`, the watchtower's challenger `0x05468D86d81DA80C777814f30550cc9F2dC28fB3`.

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
