# LONGYU testnet chain files

The chain images on Railway bake in two files from this folder. Both are created during the rollup deployment (step 2 of [Launching a chain from these files](../README.md#launching-a-chain-from-these-files)) and are public:

| File | Created by | Used by |
|---|---|---|
| `genesis.json` | `op-node genesis l2` after the BSC contracts are deployed | op-geth, once, to initialise the chain |
| `rollup.json` | the same command | op-node |

Commit both before the first Railway deploy; the op-geth and op-node builds fail without them. Never change them after launch: a different genesis is a different chain, and replacing it erases the old one (op-geth only does so when `RESET_CHAIN_FOR_GENESIS` holds the new file's SHA-256). The op-geth start-up refuses a genesis whose `chainId` is not `668801`.

## Deployed

Launched on 18 November 2026 at 11:43:47 UTC, from BSC testnet block 143441461.

This is the day's second launch. The first (from BSC testnet block 143412595) was replaced within four hours, before anything public pointed at it, because its wrapped gas token was named Wrapped Ether (WETH); the name is fixed at genesis and now reads Wrapped BNB (WBNB). The first launch's rollup contracts are still on BSC testnet and belong to no chain. The LONGYU addresses below are the same as on the first launch, because the same key deployed them in the same order.

| What | Where | Address |
|---|---|---|
| Rollup contracts | BSC testnet | [l1-deployments.json](l1-deployments.json) |
| tLONG (`LongToken`, 10 billion, held by the testnet admin key) | BSC testnet | `0x88d5B1946BaB654e31Fbf0bcc3D022e995aB129C` |
| tLONG, the bridged copy (`OptimismMintableERC20`, minted only by the bridge) | LONGYU | `0xF4769160D6dc78F66f61F0eA1638E65d43610163` |
| MiningDistributor (pays mining rewards against the daily root) | LONGYU | `0x096ca64cB06f555c56F67FD618684D5C2b7F9e06` |
| MiningVault (holds the mining pool) | LONGYU | `0x5c8630c2210943aF91F01774cC1CafdAf61ff097` |
| EmissionSchedule (the daily budget) | LONGYU | `0x6F11804A7993895b112A99caf774b37cEd49E096` |
| Faucet (testnet gas for new wallets) | LONGYU | `0x4C48f21885eE29a9682D0bf37b0c6af544dFEE51` |
| LONGYU Swap factory (fee setter: the testnet admin key until the Safe exists) | LONGYU | `0xfE5372cA129113bf12EC70D1EE4A7cBB14f172B0` |
| LONGYU Swap router | LONGYU | `0xed3Eb7fe322424C14cc356Ab182021cAb8dCf01A` |
| Wrapped BNB (WBNB), built into the chain; the router's wrapped token | LONGYU | `0x4200000000000000000000000000000000000006` |
| LONGYU Swap tLONG/WBNB pool (opened 18 November 2026 with 0.015 tBNB and 750 tLONG from the testnet admin key, which holds the pool tokens; the ratio is a test value, not a price) | LONGYU | `0x57ae40c1e343442B9CFFc1BC992C5EB5D27B2BFd` |

Safe v1.3.0, for the admin multisigs. On BSC testnet the scripts use Safe's own deployment. On LONGYU the two singletons are in the genesis; the proxy factory and the fallback handler were deployed on 18 November 2026 through the genesis SafeSingletonFactory, and their code equals the published `@gnosis.pm/safe-contracts@1.3.0`:

| What | Where | Address |
|---|---|---|
| Safe proxy factory | LONGYU | `0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC` |
| Safe singleton (L2 variant, used for new Safes) | LONGYU | `0xfb1bffC9d739B8D520DaF37dF666da4C687191EA` |
| Safe singleton | LONGYU | `0x69f4D1788e39c87893C980c06EdF4b7f686e2938` |
| CompatibilityFallbackHandler | LONGYU | `0x017062a1dE2FE6b99BE3d9d37841FeD19F573804` |
| MultiSendCallOnly | LONGYU | `0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B` |
| SystemOwnerSafe (owns the rollup's upgrade rights; its only signer is the testnet admin key until the handover) | BSC testnet | `0x7b47bB59dD70457d08C5c639Edd0f7647BA9A66D` |

The withdrawal wait of the output oracle was seven days at launch. On 21 November 2026 it was set to 10 minutes by `contracts/script/SetWithdrawalWait.s.sol`, in BSC testnet transaction `0x6e52c438aecd583f5b7db10e7fa1dc76755f52674c2e921c2b7dda2b0fb91080`; the oracle's implementation is the one in [l1-deployments.json](l1-deployments.json), as before. [deploy-config.json](deploy-config.json) carries the current value.

LONGYU Scan runs at https://scan-testnet.longyu.network.

## Connecting a wallet

| Setting | Value |
|---|---|
| Network name | LONGYU Testnet |
| RPC URL | `https://rpc-testnet.longyu.network` |
| Chain ID | `668801` |
| Currency symbol | `tBNB` |
| Block explorer | `https://scan-testnet.longyu.network` |
| Bridge | `https://testnet.longyu.network/bridge.html` |
| Swap | `https://testnet.longyu.network/swap.html` |
| Safe signing page (for the multisig signers) | `https://testnet.longyu.network/safe.html` |
| Claim page | `https://testnet.longyu.network` |
| LONGYU MINE in a browser (any phone or computer) | `https://mine-testnet.longyu.network` |
| LONGYU MINE for Android (the APK) | `https://mine-testnet.longyu.network/download/android` |

The RPC address is the `rpc` service (`chain/railway/rpc`), a gateway in front of the sequencer's node; the node itself has no public address. It serves the read and send methods wallets, apps and the bridge use, and nothing else (no `debug`, `admin` or `txpool`, no filters, no WebSocket). Each client address may spend 50 units a second with a burst of 300: a light call costs 1, sending a transaction 2, and `eth_call`, `eth_estimateGas`, `eth_getLogs` and `eth_getProof` 4. A batch holds at most 25 calls and one `eth_getLogs` query at most 50,000 blocks. Over the limit it answers HTTP 429 with `retry-after`. It is reached through Cloudflare only.
