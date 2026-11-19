// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {DexFixture} from "./utils/DexFixture.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";
import {TestERC20} from "./mocks/TestERC20.sol";

/// @notice Router02 liquidity and swap flows. Expected amounts come from v2-periphery's test suite and
///         from the fee formula in DexFixture, which restates UniswapV2Library independently.
contract RouterTest is DexFixture {
    // v2-periphery vectors: 1 in against 5/10 reserves, and the input needed for 1 out of 5/10 reserves.
    uint256 internal constant OUT_1_IN_5_10 = 1662497915624478906;
    uint256 internal constant IN_FOR_1_OUT_5_10 = 557227237267357629;

    // ---------------------------------------------------------------- liquidity, token/token

    function test_AddLiquidityCreatesPairAndLocksMinimum() public {
        assertEq(factory.getPair(address(tokenA), address(tokenB)), address(0));
        fund(tokenA, alice, 1e18);
        fund(tokenB, alice, 4e18);
        vm.prank(alice);
        (uint256 amountA, uint256 amountB, uint256 liquidity) =
            router.addLiquidity(address(tokenA), address(tokenB), 1e18, 4e18, 1e18, 4e18, alice, deadline());

        IUniswapV2Pair pair = pairFor(address(tokenA), address(tokenB));
        assertEq(factory.getPair(address(tokenA), address(tokenB)), address(pair));
        assertEq(amountA, 1e18);
        assertEq(amountB, 4e18);
        assertEq(liquidity, 2e18 - MINIMUM_LIQUIDITY);
        assertEq(pair.balanceOf(alice), 2e18 - MINIMUM_LIQUIDITY);
        assertEq(pair.balanceOf(address(0)), MINIMUM_LIQUIDITY);
        assertEq(pair.totalSupply(), 2e18);
        assertEq(tokenA.balanceOf(address(pair)), 1e18);
        assertEq(tokenB.balanceOf(address(pair)), 4e18);
    }

    function test_AddLiquidityUsesPoolRatioAndEnforcesMinimums() public {
        addLiquidity(alice, tokenA, tokenB, 1e18, 4e18);
        fund(tokenA, bob, 10e18);
        fund(tokenB, bob, 10e18);
        vm.startPrank(bob);
        // Desired 1 A : 10 B, but the pool is 1:4, so the router takes 1 A and 4 B.
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_B_AMOUNT"));
        router.addLiquidity(address(tokenA), address(tokenB), 1e18, 10e18, 0, 4e18 + 1, bob, deadline());
        // Desired 10 A : 4 B: the router takes 1 A and 4 B.
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_A_AMOUNT"));
        router.addLiquidity(address(tokenA), address(tokenB), 10e18, 4e18, 1e18 + 1, 0, bob, deadline());
        (uint256 amountA, uint256 amountB, uint256 liquidity) =
            router.addLiquidity(address(tokenA), address(tokenB), 1e18, 10e18, 1e18, 4e18, bob, deadline());
        vm.stopPrank();
        assertEq(amountA, 1e18);
        assertEq(amountB, 4e18);
        assertEq(liquidity, 2e18);
        assertEq(tokenB.balanceOf(bob), 6e18);
    }

    function test_AddLiquidityRevertsAfterDeadline() public {
        fund(tokenA, alice, 1e18);
        fund(tokenB, alice, 1e18);
        vm.warp(1_000_000);
        vm.prank(alice);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.addLiquidity(address(tokenA), address(tokenB), 1e18, 1e18, 0, 0, alice, block.timestamp - 1);
    }

    function test_RemoveLiquidity() public {
        (IUniswapV2Pair pair, uint256 liquidity) = addLiquidity(alice, tokenA, tokenB, 1e18, 4e18);
        vm.startPrank(alice);
        pair.approve(address(router), type(uint256).max);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_A_AMOUNT"));
        router.removeLiquidity(address(tokenA), address(tokenB), liquidity, 1e18 - 499, 0, alice, deadline());
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_B_AMOUNT"));
        router.removeLiquidity(address(tokenA), address(tokenB), liquidity, 0, 4e18 - 1999, alice, deadline());
        (uint256 amountA, uint256 amountB) = router.removeLiquidity(
            address(tokenA), address(tokenB), liquidity, 1e18 - 500, 4e18 - 2000, alice, deadline()
        );
        vm.stopPrank();
        assertEq(amountA, 1e18 - 500);
        assertEq(amountB, 4e18 - 2000);
        assertEq(tokenA.balanceOf(alice), 1e18 - 500);
        assertEq(tokenB.balanceOf(alice), 4e18 - 2000);
        assertEq(pair.balanceOf(alice), 0);
        assertEq(pair.totalSupply(), MINIMUM_LIQUIDITY);
    }

    function test_RemoveLiquidityRevertsAfterDeadline() public {
        (IUniswapV2Pair pair, uint256 liquidity) = addLiquidity(alice, tokenA, tokenB, 1e18, 4e18);
        vm.warp(1_000_000);
        vm.startPrank(alice);
        pair.approve(address(router), liquidity);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.removeLiquidity(address(tokenA), address(tokenB), liquidity, 0, 0, alice, block.timestamp - 1);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- liquidity, token/WBNB

    function test_AddLiquidityETHWrapsAndRefundsDust() public {
        (IUniswapV2Pair pair, uint256 liquidity) = addLiquidityETH(alice, tokenA, 1e18, 4e18);
        assertEq(liquidity, 2e18 - MINIMUM_LIQUIDITY);
        assertEq(address(pair), factory.getPair(address(tokenA), address(weth)));
        assertEq(weth.balanceOf(address(pair)), 4e18);
        assertEq(tokenA.balanceOf(address(pair)), 1e18);
        assertEq(alice.balance, 0);
        assertEq(address(router).balance, 0);

        // Second deposit at 1:4 sends 5 BNB for 1 token: 4 are used and 1 is refunded.
        fund(tokenA, bob, 1e18);
        vm.deal(bob, 5e18);
        vm.prank(bob);
        (uint256 amountToken, uint256 amountETH,) =
            router.addLiquidityETH{value: 5e18}(address(tokenA), 1e18, 1e18, 4e18, bob, deadline());
        assertEq(amountToken, 1e18);
        assertEq(amountETH, 4e18);
        assertEq(bob.balance, 1e18);
        assertEq(weth.balanceOf(address(pair)), 8e18);
        assertEq(address(router).balance, 0);
    }

    function test_AddLiquidityETHRevertsAfterDeadline() public {
        fund(tokenA, alice, 1e18);
        vm.deal(alice, 1e18);
        vm.warp(1_000_000);
        vm.prank(alice);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.addLiquidityETH{value: 1e18}(address(tokenA), 1e18, 0, 0, alice, block.timestamp - 1);
    }

    function test_RemoveLiquidityETH() public {
        (IUniswapV2Pair pair, uint256 liquidity) = addLiquidityETH(alice, tokenA, 1e18, 4e18);
        vm.startPrank(alice);
        pair.approve(address(router), liquidity);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_B_AMOUNT")); // WBNB is token B inside the router
        router.removeLiquidityETH(address(tokenA), liquidity, 0, 4e18 - 1999, alice, deadline());
        (uint256 amountToken, uint256 amountETH) =
            router.removeLiquidityETH(address(tokenA), liquidity, 1e18 - 500, 4e18 - 2000, alice, deadline());
        vm.stopPrank();
        assertEq(amountToken, 1e18 - 500);
        assertEq(amountETH, 4e18 - 2000);
        assertEq(tokenA.balanceOf(alice), 1e18 - 500);
        assertEq(alice.balance, 4e18 - 2000);
        assertEq(weth.balanceOf(alice), 0);
        assertEq(address(router).balance, 0);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    // ---------------------------------------------------------------- swaps, token/token

    function setUpTokenPool() internal returns (IUniswapV2Pair pair) {
        (pair,) = addLiquidity(alice, tokenA, tokenB, 5e18, 10e18);
    }

    function test_SwapExactTokensForTokens() public {
        IUniswapV2Pair pair = setUpTokenPool();
        address[] memory p = path2(address(tokenA), address(tokenB));
        fund(tokenA, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokens(1e18, OUT_1_IN_5_10 + 1, p, bob, deadline());
        uint256[] memory amounts = router.swapExactTokensForTokens(1e18, OUT_1_IN_5_10, p, bob, deadline());
        vm.stopPrank();
        assertEq(amounts[0], 1e18);
        assertEq(amounts[1], OUT_1_IN_5_10);
        assertEq(tokenB.balanceOf(bob), OUT_1_IN_5_10);
        assertEq(tokenA.balanceOf(bob), 0);
        (uint256 rA, uint256 rB) = reservesOf(pair, address(tokenA));
        assertEq(rA, 6e18);
        assertEq(rB, 10e18 - OUT_1_IN_5_10);
    }

    function test_SwapExactTokensForTokensOtherDirection() public {
        setUpTokenPool();
        uint256 expected = amountOutFor(1e18, 10e18, 5e18);
        assertEq(expected, 453305446940074565);
        address[] memory p = path2(address(tokenB), address(tokenA));
        fund(tokenB, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokens(1e18, expected + 1, p, bob, deadline());
        router.swapExactTokensForTokens(1e18, expected, p, bob, deadline());
        vm.stopPrank();
        assertEq(tokenA.balanceOf(bob), expected);
    }

    function test_SwapTokensForExactTokens() public {
        setUpTokenPool();
        assertEq(amountInFor(1e18, 5e18, 10e18), IN_FOR_1_OUT_5_10);
        address[] memory p = path2(address(tokenA), address(tokenB));
        fund(tokenA, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"));
        router.swapTokensForExactTokens(1e18, IN_FOR_1_OUT_5_10 - 1, p, bob, deadline());
        uint256[] memory amounts =
            router.swapTokensForExactTokens(1e18, IN_FOR_1_OUT_5_10, p, bob, deadline());
        vm.stopPrank();
        assertEq(amounts[0], IN_FOR_1_OUT_5_10);
        assertEq(tokenB.balanceOf(bob), 1e18);
        assertEq(tokenA.balanceOf(bob), 1e18 - IN_FOR_1_OUT_5_10);
    }

    function test_SwapTokensForExactTokensOtherDirection() public {
        setUpTokenPool();
        uint256 expectedIn = amountInFor(1e18, 10e18, 5e18);
        address[] memory p = path2(address(tokenB), address(tokenA));
        fund(tokenB, bob, 5e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"));
        router.swapTokensForExactTokens(1e18, expectedIn - 1, p, bob, deadline());
        router.swapTokensForExactTokens(1e18, expectedIn, p, bob, deadline());
        vm.stopPrank();
        assertEq(tokenA.balanceOf(bob), 1e18);
        assertEq(tokenB.balanceOf(bob), 5e18 - expectedIn);
    }

    /// @dev amountIn from getAmountIn is the smallest input that buys the output: one wei less buys less.
    function test_ExactOutputInputIsTight() public {
        setUpTokenPool();
        assertLt(router.getAmountOut(IN_FOR_1_OUT_5_10 - 1, 5e18, 10e18), 1e18);
        assertGe(router.getAmountOut(IN_FOR_1_OUT_5_10, 5e18, 10e18), 1e18);
    }

    function test_SwapsRevertAfterDeadline() public {
        setUpTokenPool();
        address[] memory p = path2(address(tokenA), address(tokenB));
        fund(tokenA, bob, 1e18);
        vm.warp(1_000_000);
        uint256 late = block.timestamp - 1;
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.swapExactTokensForTokens(1e18, 0, p, bob, late);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.swapTokensForExactTokens(1, 1e18, p, bob, late);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1e18, 0, p, bob, late);
        vm.stopPrank();
        // The deadline is inclusive.
        vm.prank(bob);
        router.swapExactTokensForTokens(1e18, 0, p, bob, block.timestamp);
    }

    function test_MultiHop() public {
        TestERC20 tokenC = new TestERC20("Token C", "TKC");
        addLiquidity(alice, tokenA, tokenB, 5e18, 10e18);
        addLiquidity(alice, tokenB, tokenC, 20e18, 7e18);
        address[] memory p = new address[](3);
        p[0] = address(tokenA);
        p[1] = address(tokenB);
        p[2] = address(tokenC);
        uint256 mid = amountOutFor(1e18, 5e18, 10e18);
        uint256 expected = amountOutFor(mid, 20e18, 7e18);
        uint256[] memory quoted = router.getAmountsOut(1e18, p);
        assertEq(quoted[1], mid);
        assertEq(quoted[2], expected);

        fund(tokenA, bob, 1e18);
        vm.prank(bob);
        router.swapExactTokensForTokens(1e18, expected, p, bob, deadline());
        assertEq(tokenC.balanceOf(bob), expected);
        assertEq(tokenB.balanceOf(bob), 0);
    }

    function test_QuoteHelpers() public view {
        assertEq(router.quote(1e18, 5e18, 10e18), 2e18);
        assertEq(router.getAmountOut(1e18, 5e18, 10e18), OUT_1_IN_5_10);
        assertEq(router.getAmountIn(1e18, 5e18, 10e18), IN_FOR_1_OUT_5_10);
    }

    function test_GetAmountsMatchFormula() public {
        setUpTokenPool();
        address[] memory p = path2(address(tokenA), address(tokenB));
        assertEq(router.getAmountsOut(1e18, p)[1], OUT_1_IN_5_10);
        assertEq(router.getAmountsIn(1e18, p)[0], IN_FOR_1_OUT_5_10);
        vm.expectRevert(bytes("UniswapV2Library: INVALID_PATH"));
        router.getAmountsOut(1e18, new address[](1));
    }

    // ---------------------------------------------------------------- swaps, token/WBNB

    function test_SwapExactETHForTokens() public {
        addLiquidityETH(alice, tokenA, 10e18, 5e18);
        address[] memory p = path2(address(weth), address(tokenA));
        vm.deal(bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactETHForTokens{value: 1e18}(OUT_1_IN_5_10 + 1, p, bob, deadline());
        vm.expectRevert(bytes("UniswapV2Router: INVALID_PATH"));
        router.swapExactETHForTokens{value: 1e18}(0, path2(address(tokenA), address(weth)), bob, deadline());
        router.swapExactETHForTokens{value: 1e18}(OUT_1_IN_5_10, p, bob, deadline());
        vm.stopPrank();
        assertEq(tokenA.balanceOf(bob), OUT_1_IN_5_10);
        assertEq(bob.balance, 0);
    }

    function test_SwapTokensForExactETH() public {
        addLiquidityETH(alice, tokenA, 5e18, 10e18);
        address[] memory p = path2(address(tokenA), address(weth));
        fund(tokenA, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"));
        router.swapTokensForExactETH(1e18, IN_FOR_1_OUT_5_10 - 1, p, bob, deadline());
        vm.expectRevert(bytes("UniswapV2Router: INVALID_PATH"));
        router.swapTokensForExactETH(1e18, 1e18, path2(address(weth), address(tokenA)), bob, deadline());
        router.swapTokensForExactETH(1e18, IN_FOR_1_OUT_5_10, p, bob, deadline());
        vm.stopPrank();
        assertEq(bob.balance, 1e18);
        assertEq(tokenA.balanceOf(bob), 1e18 - IN_FOR_1_OUT_5_10);
        assertEq(address(router).balance, 0);
    }

    function test_SwapExactTokensForETH() public {
        addLiquidityETH(alice, tokenA, 5e18, 10e18);
        address[] memory p = path2(address(tokenA), address(weth));
        fund(tokenA, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForETH(1e18, OUT_1_IN_5_10 + 1, p, bob, deadline());
        router.swapExactTokensForETH(1e18, OUT_1_IN_5_10, p, bob, deadline());
        vm.stopPrank();
        assertEq(bob.balance, OUT_1_IN_5_10);
        assertEq(tokenA.balanceOf(bob), 0);
    }

    function test_SwapETHForExactTokensRefundsExcess() public {
        addLiquidityETH(alice, tokenA, 10e18, 5e18);
        address[] memory p = path2(address(weth), address(tokenA));
        vm.deal(bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"));
        router.swapETHForExactTokens{value: IN_FOR_1_OUT_5_10 - 1}(1e18, p, bob, deadline());
        uint256[] memory amounts = router.swapETHForExactTokens{value: 1e18}(1e18, p, bob, deadline());
        vm.stopPrank();
        assertEq(amounts[0], IN_FOR_1_OUT_5_10);
        assertEq(tokenA.balanceOf(bob), 1e18);
        assertEq(bob.balance, 1e18 - IN_FOR_1_OUT_5_10);
        assertEq(address(router).balance, 0);
    }

    function test_EthSwapsRevertAfterDeadline() public {
        addLiquidityETH(alice, tokenA, 10e18, 5e18);
        vm.deal(bob, 1e18);
        vm.warp(1_000_000);
        uint256 late = block.timestamp - 1;
        address[] memory p = path2(address(weth), address(tokenA));
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.swapExactETHForTokens{value: 1e18}(0, p, bob, late);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.swapETHForExactTokens{value: 1e18}(1, p, bob, late);
        vm.stopPrank();
    }

    function test_RouterRejectsDirectBnbTransfers() public {
        vm.deal(bob, 1e18);
        vm.prank(bob);
        (bool ok,) = address(router).call{value: 1e18}("");
        assertFalse(ok, "only WBNB may send BNB to the router");
    }
}
