# The LONGYU chain

LONGYU is its own Layer 2 network that settles on BNB Smart Chain (BSC).

It runs the rollup software BNB Chain publishes for building L2s on BSC: the BSC edition of the OP Stack, in [bnb-chain/opbnb](https://github.com/bnb-chain/opbnb) (op-node, op-batcher, op-proposer) and [bnb-chain/op-geth](https://github.com/bnb-chain/op-geth). opBNB, BNB Chain's own L2, runs the same software. LONGYU is a separate chain with its own chain ID, sequencer, bridge contracts on BSC, RPC and explorer, in the way Base and Optimism are separate chains on one stack.

| | Testnet | Mainnet (not launched) |
|---|---|---|
| Chain ID | 668801 | 668800 |
| Settles on | BSC testnet (chain 97) | BSC (chain 56) |
| Gas token | BNB bridged from BSC testnet, shown as tBNB | BNB bridged from BSC |
| Mining reward token | tLONG (bridged BEP-20) | LONG (bridged BEP-20) |
| Block time | 250 ms | 250 ms |
| State root posted to BSC | Every 3,600 L2 blocks (15 minutes) | The same |
| Withdrawal delay to BSC | 7 days | 7 days |
| Chain registry entry | [registry/eip155-668801.json](registry/eip155-668801.json) | [registry/eip155-668800.json](registry/eip155-668800.json) |

Addresses, launch block and wallet settings of the testnet are in [testnet/README.md](testnet/README.md).

## What runs where

| Component | Runs on | Source |
|---|---|---|
| Rollup contracts: portal, output oracle, bridge, system config | BSC | opbnb v0.5.6, deployed by [testnet/deploy-rollup.sh](testnet/deploy-rollup.sh) |
| Transaction data, as blobs with calldata as the fallback | BSC | Posted by op-batcher |
| State roots | BSC | Posted by op-proposer |
| Sequencer: op-geth v0.5.11 and op-node v0.5.6 | LONGYU's servers | [railway/op-geth](railway/op-geth), [railway/op-node](railway/op-node) |
| Batcher and proposer | LONGYU's servers | [railway/op-batcher](railway/op-batcher), [railway/op-proposer](railway/op-proposer) |
| Public RPC | LONGYU's servers | [railway/rpc](railway/rpc), a gateway in front of the node |
| Explorer | LONGYU's servers | [apps/explorer](../apps/explorer) |
| Mining contracts and LONGYU Swap | LONGYU | [contracts](../contracts), [contracts/dex](../contracts/dex) |

Each image pins its upstream release by digest and adds only an entrypoint that checks its settings before the node starts. op-geth and op-node bake in `genesis.json` and `rollup.json` from [testnet/](testnet/). The node has no public address: everything outside reaches it through the gateway, which serves the methods wallets, apps and the bridge use and refuses the rest.

## Settings that differ from the upstream guide

BNB Chain's guide, [Run your own L2](https://docs.bnbchain.org/bnb-opbnb/advanced/run-your-own-l2-with-opbnb/), is the starting point. LONGYU's config comes from [testnet/deploy-config.ts](testnet/deploy-config.ts) and not from the guide's template, which pre-funds well-known development accounts, deploys a governance token and sets 12-second withdrawals.

| Setting | Value | Why |
|---|---|---|
| `l2BlockTime` | 1, with the Volta and Fourier upgrades active from the first block | The chain makes a block every 250 ms; `l2BlockTime` is the setting from before those upgrades |
| Sequencer window | 96,000 L1 blocks | BSC's blocks are 0.45 s, so windows counted in L1 blocks are long |
| Channel timeout | 1,200 L1 blocks | The same |
| Output interval | 3,600 L2 blocks | A state root every 15 minutes |
| Finalization period | 7 days | Withdrawals to BSC wait this long |
| Batcher channel duration | 300 L1 blocks | One data transaction about every two minutes; the guide's 20 blocks would post one every 9 seconds |
| Pre-funded accounts | None | Checked by the deploy script before the genesis is written |
| Wrapped gas token | Named Wrapped BNB (WBNB) | The stack only knows the gas token as Ether; two name functions are fixed at genesis |

## What the chain costs on BSC

Measured on BSC testnet on 19 November 2026, with gas at 0.1 gwei:

| Account | Transactions a day | BNB in 30 days |
|---|---|---|
| Batcher | About 760 | About 0.05 |
| Proposer | 96 | About 0.03 |

Costs follow BSC's gas price in proportion.

## Watching the batcher and the proposer

A chain whose batcher or proposer has stopped keeps making blocks, so nothing on LONGYU itself shows the fault. Three things do:

- **Balances on BSC.** Both accounts pay BSC gas. The API's health job reads their balances and reports when either runs low.
- **The latest state root.** `latestBlockNumber()` on the L2OutputOracle should trail the chain's head by no more than the output interval plus a few minutes.
- **The safe head.** `optimism_syncStatus` on op-node gives `safe_l2`, the newest block whose data is on BSC. It should trail the head by a few minutes at most.

## Launching a chain from these files

1. Clone `bnb-chain/opbnb` at v0.5.6. Create separate admin, sequencer, batcher and proposer keys, and fund the admin, batcher and proposer on BSC.
2. Run [testnet/deploy-rollup.sh](testnet/deploy-rollup.sh) with `MODE=rehearsal` first. It deploys to a local fork of BSC and spends nothing. With `MODE=bsc-testnet` it deploys the rollup contracts and writes `genesis.json`, `rollup.json` and `l1-deployments.json`, then checks them: chain IDs, the portal and system config addresses, 250 ms blocks, no pre-funded accounts.
3. Build and start the four images in [railway/](railway/): op-geth and op-node as the sequencer, then op-batcher and op-proposer. Start the proposer within one output interval of the first block.
4. Put the gateway in [railway/rpc](railway/rpc) in front of op-geth and start the explorer against the node.
5. Deploy the token on BSC (`DeployTestToken.s.sol`), create its bridged copy on LONGYU (`CreateL2Token.s.sol`), deploy the mining contracts (`DeployMining.s.sol`) and bridge the mining pool into the vault (`BridgeToL2.s.sol`). The scripts are in [contracts/script](../contracts/script).

A genesis is a chain: `genesis.json` and `rollup.json` never change after launch.

## Gas and the LONG token

BNB is LONGYU's gas token, as on BSC. Wallets, bridges and exchanges already understand it, and nobody needs LONG to pay a fee. BNB arrives on LONGYU through the bridge.

$LONG is a BEP-20 on BSC (tLONG on BSC testnet): 18 decimals, fixed supply, no transfer fees. Its copy on LONGYU is a standard bridged token created by the factory built into the chain. The bridge mints it on LONGYU only against tokens locked on BSC and burns it on the way back, so the two supplies always match. Mining pays this token.
