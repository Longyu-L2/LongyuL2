// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {DexFixture} from "./utils/DexFixture.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";
import {DeflatingERC20} from "./mocks/DeflatingERC20.sol";

/// @notice Fee-on-transfer tokens (1% burned on every transfer) work only through the
///         ...SupportingFeeOnTransferTokens functions, which measure balances instead of trusting amounts.
contract FeeOnTransferTest is DexFixture {
    DeflatingERC20 internal dtt;

    function setUp() public override {
        super.setUp();
        dtt = new DeflatingERC20();
    }

    struct Sig {
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function received(uint256 sent) internal pure returns (uint256) {
        return sent - sent / 100;
    }

    /// @dev What the pair pays out for `liquidity` before any transfer fee.
    function naivePayout(IUniswapV2Pair pair, uint256 liquidity)
        internal
        view
        returns (uint256 dttOut, uint256 ethOut)
    {
        uint256 total = pair.totalSupply();
        dttOut = (dtt.balanceOf(address(pair)) * liquidity) / total;
        ethOut = (weth.balanceOf(address(pair)) * liquidity) / total;
    }

    function test_LiquidityAddedWithFeeOnTransferToken() public {
        (IUniswapV2Pair pair,) = addLiquidity(alice, dtt, tokenB, 100e18, 100e18);
        (uint256 rD, uint256 rB) = reservesOf(pair, address(dtt));
        assertEq(rD, 99e18); // the transfer into the pair burned 1%
        assertEq(rB, 100e18);
    }

    function test_StandardSwapRevertsForFeeOnTransferInput() public {
        addLiquidity(alice, dtt, tokenB, 100e18, 100e18);
        fund(dtt, bob, 1e18);
        vm.prank(bob);
        vm.expectRevert(bytes("UniswapV2: K"));
        router.swapExactTokensForTokens(1e18, 0, path2(address(dtt), address(tokenB)), bob, deadline());
    }

    function test_SupportingSwapWithFeeOnInput() public {
        (IUniswapV2Pair pair,) = addLiquidity(alice, dtt, tokenB, 100e18, 100e18);
        (uint256 rIn, uint256 rOut) = reservesOf(pair, address(dtt));
        uint256 expected = amountOutFor(received(1e18), rIn, rOut);
        address[] memory p = path2(address(dtt), address(tokenB));

        fund(dtt, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1e18, expected + 1, p, bob, deadline());
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1e18, expected, p, bob, deadline());
        vm.stopPrank();
        assertEq(tokenB.balanceOf(bob), expected);
        assertEq(dtt.balanceOf(bob), 0);
    }

    /// @dev The minimum applies to what the recipient actually receives, after the token's own fee.
    function test_SupportingSwapWithFeeOnOutput() public {
        (IUniswapV2Pair pair,) = addLiquidity(alice, dtt, tokenB, 100e18, 100e18);
        (uint256 rIn, uint256 rOut) = reservesOf(pair, address(tokenB));
        uint256 pairOut = amountOutFor(1e18, rIn, rOut);
        uint256 expected = received(pairOut);
        address[] memory p = path2(address(tokenB), address(dtt));

        fund(tokenB, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1e18, expected + 1, p, bob, deadline());
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(1e18, expected, p, bob, deadline());
        vm.stopPrank();
        assertEq(dtt.balanceOf(bob), expected);
    }

    /// @dev Caveat: the standard functions check the pair's output, not what arrives, so with a
    ///      fee-on-transfer output token the recipient gets less than amountOutMin without a revert.
    function test_StandardSwapChecksPairOutputNotReceivedAmount() public {
        (IUniswapV2Pair pair,) = addLiquidity(alice, dtt, tokenB, 100e18, 100e18);
        (uint256 rIn, uint256 rOut) = reservesOf(pair, address(tokenB));
        uint256 pairOut = amountOutFor(1e18, rIn, rOut);
        fund(tokenB, bob, 1e18);
        vm.prank(bob);
        router.swapExactTokensForTokens(1e18, pairOut, path2(address(tokenB), address(dtt)), bob, deadline());
        assertEq(dtt.balanceOf(bob), received(pairOut));
        assertLt(dtt.balanceOf(bob), pairOut);
    }

    function test_SupportingSwapExactETHForTokens() public {
        (IUniswapV2Pair pair,) = addLiquidityETH(alice, dtt, 100e18, 10e18);
        (uint256 rIn, uint256 rOut) = reservesOf(pair, address(weth));
        uint256 expected = received(amountOutFor(1e18, rIn, rOut));
        address[] memory p = path2(address(weth), address(dtt));

        vm.deal(bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1e18}(
            expected + 1, p, bob, deadline()
        );
        vm.expectRevert(bytes("UniswapV2Router: INVALID_PATH"));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1e18}(
            0, path2(address(dtt), address(weth)), bob, deadline()
        );
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1e18}(expected, p, bob, deadline());
        vm.stopPrank();
        assertEq(dtt.balanceOf(bob), expected);
        assertEq(bob.balance, 0);
    }

    function test_SupportingSwapExactTokensForETH() public {
        (IUniswapV2Pair pair,) = addLiquidityETH(alice, dtt, 100e18, 10e18);
        (uint256 rIn, uint256 rOut) = reservesOf(pair, address(dtt));
        uint256 expected = amountOutFor(received(1e18), rIn, rOut);
        address[] memory p = path2(address(dtt), address(weth));

        fund(dtt, bob, 1e18);
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(1e18, expected + 1, p, bob, deadline());
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(1e18, expected, p, bob, deadline());
        vm.stopPrank();
        assertEq(bob.balance, expected);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    function test_SupportingSwapsRevertAfterDeadline() public {
        addLiquidityETH(alice, dtt, 100e18, 10e18);
        fund(dtt, bob, 1e18);
        vm.deal(bob, 1e18);
        vm.warp(1_000_000);
        uint256 late = block.timestamp - 1;
        vm.startPrank(bob);
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 1e18}(
            0, path2(address(weth), address(dtt)), bob, late
        );
        vm.expectRevert(bytes("UniswapV2Router: EXPIRED"));
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            1e18, 0, path2(address(dtt), address(weth)), bob, late
        );
        vm.stopPrank();
    }

    /// @dev Mirrors v2-periphery's test: the minimums are the pair's naive payout; the token is taxed
    ///      twice on the way out (pair to router, router to owner).
    function test_RemoveLiquidityETHSupportingFeeOnTransferTokens() public {
        (IUniswapV2Pair pair, uint256 liquidity) = addLiquidityETH(alice, dtt, 1e18, 4e18);
        (uint256 naiveDtt, uint256 ethExpected) = naivePayout(pair, liquidity);

        vm.startPrank(alice);
        pair.approve(address(router), type(uint256).max);
        // The standard function forwards the pair's payout amount, which the router no longer has.
        vm.expectRevert(bytes("TransferHelper: TRANSFER_FAILED"));
        router.removeLiquidityETH(address(dtt), liquidity, 0, 0, alice, deadline());
        uint256 amountETH = router.removeLiquidityETHSupportingFeeOnTransferTokens(
            address(dtt), liquidity, naiveDtt, ethExpected, alice, deadline()
        );
        vm.stopPrank();
        assertEq(amountETH, ethExpected);
        assertEq(alice.balance, ethExpected);
        assertEq(dtt.balanceOf(alice), received(received(naiveDtt)));
        assertEq(dtt.balanceOf(address(router)), 0);
    }

    function test_RemoveLiquidityETHWithPermitSupportingFeeOnTransferTokens() public {
        (address lp, uint256 lpKey) = makeAddrAndKey("dtt lp");
        (IUniswapV2Pair pair, uint256 liquidity) = addLiquidityETH(lp, dtt, 1e18, 4e18);
        (uint256 naiveDtt, uint256 ethExpected) = naivePayout(pair, liquidity);
        Sig memory sig;
        (sig.v, sig.r, sig.s) = signLpPermit(pair, lpKey, address(router), liquidity, deadline());

        vm.prank(lp);
        router.removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
            address(dtt), liquidity, naiveDtt, ethExpected, lp, deadline(), false, sig.v, sig.r, sig.s
        );
        assertEq(lp.balance, ethExpected);
        assertEq(dtt.balanceOf(lp), received(received(naiveDtt)));
        assertEq(pair.balanceOf(lp), 0);
    }
}
