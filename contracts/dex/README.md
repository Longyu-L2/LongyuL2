# LONGYU Swap

LONGYU Swap is the DEX for LONGYU: a fork of Uniswap V2 (v2-core 1.0.1, v2-periphery 1.1.0-beta.0)
with two patches, the LP token name and the init code hash (`PATCHES.md`). It has a 0.3% swap fee to
liquidity providers. The optional protocol fee (1/6 of that fee) is off until the `feeToSetter`
multisig calls `setFeeTo`. Provenance and licence (GPL-3.0-or-later) are in `NOTICE.md` and `LICENSE`.

This is a separate Foundry project. It does not share settings with `contracts/` (solc 0.8.28).

| Path | Contents | Compiler |
|---|---|---|
| `src/core/` | UniswapV2Factory, UniswapV2Pair, UniswapV2ERC20, interfaces, libraries | 0.5.16 |
| `src/periphery/` | UniswapV2Router02, interfaces, UniswapV2Library, SafeMath, TransferHelper | 0.6.6 |
| `test/` | Foundry tests, test tokens; `mocks/WETH9.sol` (0.6.6) is test-only | 0.8.28 |
| `script/DeployDex.s.sol` | deploys Factory and Router02 | 0.8.28 |
| `scripts/export-abis.mjs` | writes `packages/abis/src/dex.ts` | node |

Optimizer on with 999999 runs, `evm_version` istanbul, as in the original builds. svm downloads each
solc version on first build (Windows builds of 0.5.16 and 0.6.6 are available).

## Build and test

```sh
cd contracts/dex
forge install --no-git foundry-rs/forge-std@v1.17.0   # lib/ is git-ignored, as in contracts/
forge build
forge test
```

The suite covers the init code hash, the factory, Uniswap's own pair test vectors, router liquidity and
swap flows, fee-on-transfer tokens, LP permits, `feeTo`, a constant-product fuzz test and invariant,
and the deploy script. The WETH9 mock cannot be imported by 0.8 tests, so a filtered run
(`forge test --match-*`) reads its artifact from `out/`: run one full `forge build` first.

## Init code hash

```
0x1907514ce58ff8bfdf875cc39008a411896e40d361d744a143d33cb957350a5f
```

A pair's address is `CREATE2(factory, keccak256(token0 ++ token1), initCodeHash)`, with the token
addresses sorted. The hash depends on the exact build (`PATCHES.md`, "What the hash depends on"), so do
not edit `src/core`, the remappings or the compiler settings without updating it. The tests fail if
the hash and the build disagree.

## Deploy

```sh
cd contracts/dex
FEE_TO_SETTER=<admin multisig> forge script script/DeployDex.s.sol \
  --rpc-url $LONGYU_RPC --broadcast --sender <deployer address> <signer flags, e.g. --ledger or --account>
```

- `FEE_TO_SETTER` is required and must be non-zero. It is the only account that can turn the protocol
  fee on or hand over the role. The script warns if the address has no code (not a multisig).
- `WETH` is optional and defaults to `0x4200000000000000000000000000000000000006`. That is the OP Stack
  WETH9 predeploy: on LONGYU, where BNB is the gas token, it wraps native BNB, so it is LONGYU's WBNB.
  The script refuses an address with no code. The router's `...ETH` functions (`addLiquidityETH`,
  `swapExactETHForTokens`, ...) take and pay native BNB.
- Before anything is broadcast, the script checks that the Pair artifact hashes to the init code hash
  and that the router artifact contains it. It sends two transactions (Factory, then Router02; forge
  estimated about 10.1M gas in total on a local chain). It then verifies the wiring and makes a
  local-only `createPair` call to confirm pairs land where the router looks. It logs the chain id, both
  addresses, WBNB, the feeToSetter and the init code hash.

## ABIs for the apps

```sh
cd contracts/dex && forge build && node scripts/export-abis.mjs
```

This writes `packages/abis/src/dex.ts`: `uniswapV2Router02Abi`, `uniswapV2FactoryAbi`,
`uniswapV2PairAbi` and `minimalErc20Abi`, all `as const`. `packages/abis/src/index.ts` re-exports them,
and `packages/abis/scripts/generate.mjs` keeps that line when it regenerates the file.

## Caveats inherited from Uniswap V2

- **Fee-on-transfer tokens** only work through the `...SupportingFeeOnTransferTokens` functions. With
  the standard functions, such a token as input reverts (`UniswapV2: K`). As output, the recipient
  silently gets less than `amountOutMin`, because the check applies to the pair's payout. Exact-output
  swaps are unsupported.
- **Rebasing and other balance-changing tokens** are unsupported. Reserves drift from balances:
  anyone can `skim` a positive rebase, and after a negative rebase swaps revert or overpay until
  someone calls `sync`. LPs absorb the loss.
- **First liquidity provider** sets the price, and a mispriced first deposit is arbitraged away. The
  1000 LP wei locked forever make share-price inflation (donating to a near-empty pool so later
  deposits round down) expensive, not impossible. Seed new pools with meaningful amounts at the market
  price.
- **Slippage and deadlines are the user's only protection.** Every swap and liquidity call has
  `amountOutMin` / `amountInMax` / `amount*Min` and a `deadline`. The UI must set them from fresh quotes
  (never 0 or `type(uint256).max`). Prices move between quote and inclusion, and the sequencer
  decides ordering even without a public mempool.
- **Prices from `getReserves` are spot prices** that can be moved within one transaction. Never use them
  as an oracle. The cumulative prices support TWAPs only over windows long enough to be costly to
  manipulate.
- **LP permits** use the domain `{name: "LONGYU Swap LP", version: "1"}`. The chain id is fixed into it
  when the pair is created.
