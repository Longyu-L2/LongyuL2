# NOTICE

LONGYU Swap (everything under `contracts/dex/`) is derived from **Uniswap V2**
(https://github.com/Uniswap/uniswap-v2-core and https://github.com/Uniswap/uniswap-v2-periphery, as
declared by the npm packages), licensed under the GNU General Public License v3.0 (the packages declare
`GPL-3.0-or-later`).
`LICENSE` in this directory is the GPL-3.0 text shipped in those packages; the three packages carry
byte-identical copies. LONGYU Swap is distributed under the same licence. `test/mocks/WETH9.sol` is
WETH9, Copyright (C) 2015, 2016, 2017 Dapphub, GPL-3.0-or-later, as stated in its own header.

The upstream `.sol` files have no per-file SPDX or copyright headers, and none were added: the files
are kept as published, except for the two patches in `PATCHES.md`. New files written for LONGYU (tests,
mocks other than WETH9, the deploy script and the ABI export script) carry
`SPDX-License-Identifier: GPL-3.0-or-later`.

## Sources

Fetched with `npm pack` on 2026-11-18. Each tarball's sha512 was computed locally and matched against
`npm view <pkg>@<version> dist.integrity`. Only `.sol` files and `LICENSE` were extracted, and no package
scripts were run.

| Package | Integrity (sha512) |
|---|---|
| `@uniswap/v2-core@1.0.1` | `sha512-MtybtkUPSyysqLY2U210NBDeCHX+ltHt3oADGdjqoThZaFRDKwM6k1Nb3F0A3hk5hwuQvytFWhrWHOEq6nVJ8Q==` |
| `@uniswap/v2-periphery@1.1.0-beta.0` | `sha512-6dkwAMKza8nzqYiXEr2D86dgW3TTavUvCR0w2Tu33bAbM8Ah43LKAzH7oKKPRT5VJQaMi1jtkGs1E8JPor1n5g==` |
| `@uniswap/lib@1.1.1` | `sha512-2yK7sLpKIT91TiS5sewHtOa7YuM8IuBXVl4GZv2jZFys4D2sY7K5vZh6MqD25TPA95Od+0YzCVq6cTF2IKrOmg==` |

v2-periphery 1.1.0-beta.0 declares `@uniswap/lib` 1.1.1 and `@uniswap/v2-core` **1.0.0**
(`sha512-BJiXrBGnN8mti7saW49MXwxDBRFiWemGetE58q8zgfnPPzQKq55ADltEILqOt6VFZ22kVeVKbF8gVd8aY3l7pA==`).
That tarball was fetched as well: its `.sol` files and `LICENSE` are byte-identical to 1.0.1's.

## Files

The sha256 column is the **upstream** file. Verbatim copies have the same hash here. The patched files
now hash to `dec06ee2…54024ff` (`UniswapV2ERC20.sol`) and `a07a6440…2f05c10` (`UniswapV2Library.sol`).

| Here | Upstream file | State | Upstream sha256 |
|---|---|---|---|
| `src/core/UniswapV2ERC20.sol` | v2-core `contracts/UniswapV2ERC20.sol` | patched | `b8ce88929ce2c93b8fce385f8d57701b1a64c600a95317ea5f3561d36297be32` |
| `src/core/UniswapV2Factory.sol` | v2-core `contracts/UniswapV2Factory.sol` | verbatim | `e0cef3e874a68cbcc5986451b1fec180ba5ff5699f27a256b7c10fafefe36b99` |
| `src/core/UniswapV2Pair.sol` | v2-core `contracts/UniswapV2Pair.sol` | verbatim | `43a5421b31415868367b62bfa161ca10bcee03778873faad905f5a3e2cce9cbd` |
| `src/core/interfaces/IERC20.sol` | v2-core `contracts/interfaces/IERC20.sol` | verbatim | `2b63f199f838028184efefbcfd6cf2b9192624c3dae5dc1116ecbb15c36a67e8` |
| `src/core/interfaces/IUniswapV2Callee.sol` | v2-core `contracts/interfaces/IUniswapV2Callee.sol` | verbatim | `ecfa434d468bb1888124d8c34b0b8483f4ea1e5cd63f0874c8b28aa4305c1dbc` |
| `src/core/interfaces/IUniswapV2ERC20.sol` | v2-core `contracts/interfaces/IUniswapV2ERC20.sol` | verbatim | `7948069aea398dec4b7e771ffc749a24fdce3a64673a1b14deae960e7a54c603` |
| `src/core/interfaces/IUniswapV2Factory.sol` | v2-core `contracts/interfaces/IUniswapV2Factory.sol` | verbatim | `51d056199e3f5e41cb1a9f11ce581aa3e190cc982db5771ffeef8d8d1f962a0d` |
| `src/core/interfaces/IUniswapV2Pair.sol` | v2-core `contracts/interfaces/IUniswapV2Pair.sol` | verbatim | `29c75e69ce173ff8b498584700fef76bc81498c1d98120e2877a1439f0c31b5a` |
| `src/core/libraries/Math.sol` | v2-core `contracts/libraries/Math.sol` | verbatim | `e4a9d451964a0689be2b244322a353de143ca4248d8736d91aca4ffadca4325f` |
| `src/core/libraries/SafeMath.sol` | v2-core `contracts/libraries/SafeMath.sol` | verbatim | `4b1c95ff75de7342e0fadff58064820a4eb7c2fcb422a75b4994980ce8e216ae` |
| `src/core/libraries/UQ112x112.sol` | v2-core `contracts/libraries/UQ112x112.sol` | verbatim | `6633b57b0723b1d72e08cc3e8b29f0af838294e59863b6cdcce95a141ed02cdb` |
| `src/periphery/UniswapV2Router02.sol` | v2-periphery `contracts/UniswapV2Router02.sol` | verbatim | `acabe6d6c9c275aa5c27d8ed59b3d23d21616523071043e89eea7bca474babb8` |
| `src/periphery/interfaces/IERC20.sol` | v2-periphery `contracts/interfaces/IERC20.sol` | verbatim | `2b63f199f838028184efefbcfd6cf2b9192624c3dae5dc1116ecbb15c36a67e8` |
| `src/periphery/interfaces/IUniswapV2Router01.sol` | v2-periphery `contracts/interfaces/IUniswapV2Router01.sol` | verbatim | `0439ffe0fd4a5e1f4e22d71ddbda76d63d61679947d158cba4ee0a1da60cf663` |
| `src/periphery/interfaces/IUniswapV2Router02.sol` | v2-periphery `contracts/interfaces/IUniswapV2Router02.sol` | verbatim | `a2900701961cb0b6152fc073856b972564f7c798797a4a044e83d2ab8f0e8d38` |
| `src/periphery/interfaces/IWETH.sol` | v2-periphery `contracts/interfaces/IWETH.sol` | verbatim | `60760053849b916b72386fef1126ab69c7482c2aa6b5fb836368eff42905cb30` |
| `src/periphery/libraries/SafeMath.sol` | v2-periphery `contracts/libraries/SafeMath.sol` | verbatim | `39e5b4c0bc19b72fa59c2d2177ba5ed6cfadcd76f3f804563011e579367530fb` |
| `src/periphery/libraries/UniswapV2Library.sol` | v2-periphery `contracts/libraries/UniswapV2Library.sol` | patched | `4f83e9334f833568fa47b36e9ceca435f6c2962760a0596b043c4e538d0fd9f2` |
| `src/periphery/libraries/TransferHelper.sol` | lib `contracts/libraries/TransferHelper.sol` | verbatim | `72b232bc3d253ccfcf8299dac036efe549fad3ae45b1e0be813745c6da635281` |
| `test/mocks/WETH9.sol` | v2-periphery `contracts/test/WETH9.sol` | verbatim | `33f13565b207188485030aa20fd1f38d52d8c455cc64720560fb38149dcb4137` |
| `LICENSE` | v2-core `LICENSE` | verbatim | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |

Left out on purpose: v2-core's `contracts/test/ERC20.sol`; v2-periphery's `UniswapV2Router01.sol`,
`UniswapV2Migrator.sol`, `examples/`, the V1 and migrator interfaces, `UniswapV2OracleLibrary.sol` and
the other test contracts; every other `@uniswap/lib` file. `IUniswapV2Router01.sol` is kept because
`IUniswapV2Router02` inherits from it.

## Bytecode check against Uniswap's mainnet deployment

Before patching, the verbatim sources were compiled with this project's settings and compared with the
code on Ethereum mainnet (fetched with `cast code`):

- The Pair creation code embedded in the mainnet UniswapV2Factory
  (`0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`) hashes to the published init code hash
  `0x96e8ac42…8845f`. Ours is identical byte for byte, except for the 32-byte swarm hash inside the
  metadata. The factory's runtime code differs only in its two metadata hashes.
- The mainnet UniswapV2Router02 (`0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`) has the same runtime code
  as ours, except for the two immutables (factory and WETH) and the metadata.

So the compilers and settings reproduce the audited bytecode. The only behavioural differences in this
fork are the two patches.
