// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {StdUtils} from "forge-std/StdUtils.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DexFixture} from "./utils/DexFixture.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Router02} from "../src/periphery/interfaces/IUniswapV2Router02.sol";
import {TestERC20} from "./mocks/TestERC20.sol";

/// @notice k = reserve0 * reserve1 never decreases on a swap, and the 0.3% fee formula is exactly the
///         largest output the pair accepts.
contract ConstantProductFuzzTest is DexFixture {
    function testFuzz_SwapNeverDecreasesK(uint256 r0, uint256 r1, uint256 amountIn, bool zeroForOne) public {
        r0 = bound(r0, 1e4, 2 ** 100);
        r1 = bound(r1, 1e4, 2 ** 100);
        (TestERC20 t0, TestERC20 t1) = sorted(tokenA, tokenB);
        IUniswapV2Pair pair = IUniswapV2Pair(factory.createPair(address(t0), address(t1)));
        t0.mint(address(pair), r0);
        t1.mint(address(pair), r1);
        pair.mint(address(this));

        (uint256 rIn, uint256 rOut) = zeroForOne ? (r0, r1) : (r1, r0);
        // Smallest input that buys at least 1 wei, up to the uint112 balance limit.
        uint256 minIn = (rIn * 1000) / (997 * (rOut - 1)) + 1;
        amountIn = bound(amountIn, minIn, type(uint112).max - rIn);
        uint256 out = amountOutFor(amountIn, rIn, rOut);
        assertGt(out, 0);
        assertLt(out, rOut);
        assertEq(router.getAmountOut(amountIn, rIn, rOut), out);
        (zeroForOne ? t0 : t1).mint(address(pair), amountIn);

        // One wei more than the formula breaks k (or drains the reserve).
        if (out + 1 < rOut) vm.expectRevert(bytes("UniswapV2: K"));
        else vm.expectRevert(bytes("UniswapV2: INSUFFICIENT_LIQUIDITY"));
        pair.swap(zeroForOne ? 0 : out + 1, zeroForOne ? out + 1 : 0, address(this), "");

        pair.swap(zeroForOne ? 0 : out, zeroForOne ? out : 0, address(this), "");
        (uint112 n0, uint112 n1,) = pair.getReserves();
        assertGe(uint256(n0) * n1, r0 * r1, "k decreased");
        assertEq(n0, zeroForOne ? r0 + amountIn : r0 - out);
        assertEq(n1, zeroForOne ? r1 - out : r1 + amountIn);
    }

    /// @dev A sequence of router swaps, exact-in and exact-out in both directions.
    function testFuzz_RouterSwapSequenceNeverDecreasesK(uint256 seed) public {
        (IUniswapV2Pair pair,) = addLiquidity(alice, tokenA, tokenB, 1_000e18, 3_000e18);
        fund(tokenA, bob, type(uint112).max);
        fund(tokenB, bob, type(uint112).max);
        vm.startPrank(bob);
        for (uint256 i = 0; i < 8; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            bool aToB = (r & 1) == 0;
            bool exactIn = (r & 2) == 0;
            address[] memory p =
                aToB ? path2(address(tokenA), address(tokenB)) : path2(address(tokenB), address(tokenA));
            (uint256 rIn, uint256 rOut) = reservesOf(pair, p[0]);
            (uint112 b0, uint112 b1,) = pair.getReserves();
            uint256 kBefore = uint256(b0) * b1;
            if (exactIn) {
                uint256 amountIn = bound(r >> 8, 1e6, rIn * 2);
                uint256 expected = amountOutFor(amountIn, rIn, rOut);
                if (expected == 0) continue; // the pair rejects a swap with no output
                uint256[] memory amounts =
                    router.swapExactTokensForTokens(amountIn, expected, p, bob, deadline());
                assertEq(amounts[1], expected);
            } else {
                uint256 amountOut = bound(r >> 8, 1, (rOut * 9) / 10);
                uint256 expected = amountInFor(amountOut, rIn, rOut);
                uint256[] memory amounts =
                    router.swapTokensForExactTokens(amountOut, expected, p, bob, deadline());
                assertEq(amounts[0], expected);
            }
            (uint112 a0, uint112 a1,) = pair.getReserves();
            assertGe(uint256(a0) * a1, kBefore, "k decreased");
        }
        vm.stopPrank();
    }
}

/// @dev Random swaps and liquidity changes against one pool; records any swap that lowers k.
contract SwapHandler is StdUtils {
    IUniswapV2Router02 internal immutable router;
    IUniswapV2Pair internal immutable pair;
    TestERC20 internal immutable a;
    TestERC20 internal immutable b;
    bool public kDecreasedOnSwap;
    uint256 public swaps;

    constructor(IUniswapV2Router02 router_, IUniswapV2Pair pair_, TestERC20 a_, TestERC20 b_) {
        router = router_;
        pair = pair_;
        a = a_;
        b = b_;
        a.approve(address(router), type(uint256).max);
        b.approve(address(router), type(uint256).max);
        pair.approve(address(router), type(uint256).max);
    }

    function k() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return uint256(r0) * r1;
    }

    function route(bool aToB) internal view returns (address[] memory p, uint256 rIn, uint256 rOut) {
        p = new address[](2);
        (p[0], p[1]) = aToB ? (address(a), address(b)) : (address(b), address(a));
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rIn, rOut) = p[0] == pair.token0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function swapExactIn(uint256 amountIn, bool aToB) external {
        (address[] memory p, uint256 rIn, uint256 rOut) = route(aToB);
        amountIn = bound(amountIn, 1, rIn * 3);
        if (amountIn > type(uint112).max - rIn || router.getAmountOut(amountIn, rIn, rOut) == 0) return;
        TestERC20(p[0]).mint(address(this), amountIn);
        uint256 before = k();
        router.swapExactTokensForTokens(amountIn, 0, p, address(this), block.timestamp);
        if (k() < before) kDecreasedOnSwap = true;
        swaps++;
    }

    function swapExactOut(uint256 amountOut, bool aToB) external {
        (address[] memory p, uint256 rIn, uint256 rOut) = route(aToB);
        if (rOut < 2) return;
        amountOut = bound(amountOut, 1, rOut - 1);
        uint256 amountIn = router.getAmountIn(amountOut, rIn, rOut);
        if (amountIn > type(uint112).max - rIn) return;
        TestERC20(p[0]).mint(address(this), amountIn);
        uint256 before = k();
        router.swapTokensForExactTokens(amountOut, amountIn, p, address(this), block.timestamp);
        if (k() < before) kDecreasedOnSwap = true;
        swaps++;
    }

    function addLiquidity(uint256 amountA, uint256 amountB) external {
        amountA = bound(amountA, 1e9, 1e30);
        amountB = bound(amountB, 1e9, 1e30);
        a.mint(address(this), amountA);
        b.mint(address(this), amountB);
        try router.addLiquidity(
            address(a), address(b), amountA, amountB, 0, 0, address(this), block.timestamp
        ) {}
            catch {} // a deposit too small for one LP wei reverts; that is fine
    }

    function removeLiquidity(uint256 share) external {
        uint256 balance = pair.balanceOf(address(this));
        if (balance == 0) return;
        uint256 liquidity = bound(share, 1, balance);
        try router.removeLiquidity(address(a), address(b), liquidity, 0, 0, address(this), block.timestamp) {}
            catch {} // a burn that rounds one side to zero reverts; that is fine
    }
}

contract ConstantProductInvariantTest is DexFixture {
    SwapHandler internal handler;
    IUniswapV2Pair internal pair;

    function setUp() public override {
        super.setUp();
        (pair,) = addLiquidity(alice, tokenA, tokenB, 1_000e18, 3_000e18);
        handler = new SwapHandler(router, pair, tokenA, tokenB);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = SwapHandler.swapExactIn.selector;
        selectors[1] = SwapHandler.swapExactOut.selector;
        selectors[2] = SwapHandler.addLiquidity.selector;
        selectors[3] = SwapHandler.removeLiquidity.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Guards against a vacuous pass: every run must have swapped.
    function afterInvariant() external view {
        assertGt(handler.swaps(), 0);
    }

    function invariant_KNeverDecreasesOnSwap() public view {
        assertFalse(handler.kDecreasedOnSwap());
    }

    function invariant_ReservesMatchBalances() public view {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(TestERC20(pair.token0()).balanceOf(address(pair)), r0);
        assertEq(TestERC20(pair.token1()).balanceOf(address(pair)), r1);
    }

    function invariant_MinimumLiquidityStaysLocked() public view {
        assertEq(pair.balanceOf(address(0)), MINIMUM_LIQUIDITY);
        assertGe(pair.totalSupply(), MINIMUM_LIQUIDITY);
    }
}
