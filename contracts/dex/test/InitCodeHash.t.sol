// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {DexFixture} from "./utils/DexFixture.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";

/// @notice The router finds pairs by CREATE2 address, which commits to the Pair creation code. Any change
///         to the compiler, settings, remappings, paths or core sources changes that code; these tests
///         fail first, before a router with a stale hash can be deployed.
contract InitCodeHashTest is DexFixture {
    bytes32 internal constant UNISWAP_MAINNET_INIT_CODE_HASH =
        0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;

    function test_PairCreationCodeMatchesInitCodeHash() public view {
        assertEq(
            keccak256(vm.getCode("UniswapV2Pair.sol:UniswapV2Pair")),
            INIT_CODE_HASH,
            "UniswapV2Pair creation code changed: update the init code hash (see PATCHES.md)"
        );
    }

    function test_RouterEmbedsOurInitCodeHashNotUniswaps() public view {
        bytes memory code = vm.getDeployedCode("UniswapV2Router02.sol:UniswapV2Router02");
        assertTrue(contains(code, INIT_CODE_HASH), "router does not contain the LONGYU Swap init code hash");
        assertFalse(contains(code, UNISWAP_MAINNET_INIT_CODE_HASH), "router still contains Uniswap's hash");
    }

    function test_FactoryDeploysThePairArtifact() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertEq(pair, pairAddress(address(factory), address(tokenA), address(tokenB)));
        assertEq(keccak256(pair.code), keccak256(vm.getDeployedCode("UniswapV2Pair.sol:UniswapV2Pair")));
    }

    /// @dev The pair is created and funded through the core contracts only; the router must find it.
    function test_RouterFindsPairsCreatedByTheFactory() public {
        IUniswapV2Pair pair = IUniswapV2Pair(factory.createPair(address(tokenA), address(tokenB)));
        tokenA.mint(address(pair), 5e18);
        tokenB.mint(address(pair), 10e18);
        pair.mint(address(this));

        uint256[] memory amounts = router.getAmountsOut(1e18, path2(address(tokenA), address(tokenB)));
        assertEq(amounts[1], 1662497915624478906);

        fund(tokenA, alice, 1e18);
        vm.prank(alice);
        router.swapExactTokensForTokens(
            1e18, amounts[1], path2(address(tokenA), address(tokenB)), alice, deadline()
        );
        assertEq(tokenB.balanceOf(alice), 1662497915624478906);
    }

    function contains(bytes memory code, bytes32 word) internal pure returns (bool found) {
        for (uint256 i = 0; i + 32 <= code.length; i++) {
            bytes32 w;
            assembly {
                w := mload(add(add(code, 32), i))
            }
            if (w == word) return true;
        }
    }
}
