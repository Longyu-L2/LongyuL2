# Patches to Uniswap V2

Exactly two source files differ from the npm packages (see `NOTICE.md` for hashes). Nothing else in
`src/` was changed: no pragmas, imports, revert strings, function names, fees or constants.

## 1. LP token name and symbol (`src/core/UniswapV2ERC20.sol`)

```solidity
// before (v2-core 1.0.1)
string public constant name = 'Uniswap V2';
string public constant symbol = 'UNI-V2';

// after
string public constant name = 'LONGYU Swap LP';
string public constant symbol = 'LONGYU-LP';
```

Why: wallets and explorers show these strings, and LONGYU's pools must not pass as Uniswap's.

Effect: the EIP-712 domain separator is built from `keccak256(bytes(name))`, so LP permits (EIP-2612)
must be signed for the domain `{name: "LONGYU Swap LP", version: "1", chainId, verifyingContract: pair}`.
A signature made for the name "Uniswap V2" is rejected (`test/Permit.t.sol`). The patch also changes the
Pair bytecode, and with it the init code hash (patch 2).

## 2. Init code hash (`src/periphery/libraries/UniswapV2Library.sol`, `pairFor`)

```solidity
// before (v2-periphery 1.1.0-beta.0): Uniswap's mainnet Pair
hex'96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f' // init code hash

// after: keccak256 of this project's UniswapV2Pair creation code
hex'1907514ce58ff8bfdf875cc39008a411896e40d361d744a143d33cb957350a5f' // init code hash
```

Why: the router locates pairs by CREATE2 address, `keccak256(0xff ++ factory ++ salt ++ initCodeHash)`.
Without this patch the router would route every call to addresses where no LONGYU pair exists.

How it was computed: `forge inspect src/core/UniswapV2Pair.sol:UniswapV2Pair bytecode | cast keccak`.
The same value comes from hashing `bytecode.object` in `out/UniswapV2Pair.sol/UniswapV2Pair.json` with
viem. Clean full builds, core-only builds (`forge build src/core`) and incremental builds give the same
value.

Guards:

- `test/InitCodeHash.t.sol` asserts `keccak256(vm.getCode("UniswapV2Pair.sol:UniswapV2Pair"))` equals
  the constant, that the compiled router contains it (and not Uniswap's), and that factory-created pairs
  sit at the predicted address and are found by the router.
- `script/DeployDex.s.sol` refuses to deploy unless both checks hold for the artifacts it is about to
  deploy. After broadcasting it creates a pair locally (not broadcast) and checks its address.
- Mutation check: adding a single trailing newline to `UniswapV2Pair.sol` makes 39 tests fail.

### What the hash depends on

The Pair creation code ends with a metadata hash (`bzzr1`). That hash covers:

- the exact bytes of the 10 core source files in the Pair's import graph. `.gitattributes` forces LF
  line endings, because this repository's `* text=auto` setting would otherwise check CRLF out on
  Windows and change the hash;
- their source unit names (`src/core/...`, relative to `contracts/dex`, forward slashes on every OS);
- the compiler (`0.5.16+commit.9c3226ce`) and settings: optimizer on, 999999 runs, `evmVersion`
  istanbul;
- **every remapping in `foundry.toml`**, including the one for forge-std, because Foundry passes the
  whole list to each compiler run. `auto_detect_remappings = false` keeps that list fixed.

Built with Foundry 1.5.1. If anything above changes (a new remapping, a Foundry upgrade that passes
different settings, an edit under `src/core`), recompute the hash, update it in `UniswapV2Library.sol`,
`script/DeployDex.s.sol`, `test/utils/DexFixture.sol` and the docs, and re-run the tests. A router
already deployed keeps working with its own factory; only rebuilds from source are affected.

## Not patches

- Imports are untouched. The periphery's `@uniswap/v2-core/contracts/...` and
  `@uniswap/lib/contracts/libraries/...` imports resolve through remappings in `foundry.toml`.
- `test/mocks/WETH9.sol` is verbatim and test-only.
- Nothing else was needed to compile: the original compilers (0.5.16 for core, 0.6.6 for periphery)
  accept the sources as published.
