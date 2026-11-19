// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {DexFixture} from "./utils/DexFixture.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";
import {TestERC20} from "./mocks/TestERC20.sol";

/// @dev Borrows through a flash swap and repays `repay` of token1 in the callback; optionally re-enters.
contract FlashBorrower {
    IUniswapV2Pair internal immutable pair;
    TestERC20 internal immutable token1;

    constructor(IUniswapV2Pair pair_, TestERC20 token1_) {
        pair = pair_;
        token1 = token1_;
    }

    function borrow(uint256 amount1Out, bytes calldata data) external {
        pair.swap(0, amount1Out, address(this), data);
    }

    function uniswapV2Call(address sender, uint256, uint256, bytes calldata data) external {
        require(msg.sender == address(pair) && sender == address(this), "unexpected caller");
        (uint256 repay, bool reenter) = abi.decode(data, (uint256, bool));
        if (reenter) pair.sync();
        require(token1.transfer(address(pair), repay), "repay failed");
    }
}

/// @notice Core pair behaviour, using the vectors from Uniswap's own v2-core test suite.
contract PairTest is DexFixture {
    TestERC20 internal token0;
    TestERC20 internal token1;
    IUniswapV2Pair internal pair;

    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    function setUp() public override {
        super.setUp();
        (token0, token1) = sorted(tokenA, tokenB);
        pair = IUniswapV2Pair(factory.createPair(address(token0), address(token1)));
    }

    function mintDirect(uint256 amount0, uint256 amount1) internal returns (uint256) {
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        return pair.mint(address(this));
    }

    function test_LpTokenMetadata() public view {
        assertEq(pair.name(), "LONGYU Swap LP");
        assertEq(pair.symbol(), "LONGYU-LP");
        assertEq(pair.decimals(), 18);
        assertEq(pair.MINIMUM_LIQUIDITY(), MINIMUM_LIQUIDITY);
    }

    function test_MintLocksMinimumLiquidity() public {
        uint256 liquidity = mintDirect(1e18, 4e18);
        assertEq(liquidity, 2e18 - MINIMUM_LIQUIDITY);
        assertEq(pair.totalSupply(), 2e18);
        assertEq(pair.balanceOf(address(this)), 2e18 - MINIMUM_LIQUIDITY);
        assertEq(pair.balanceOf(address(0)), MINIMUM_LIQUIDITY);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 1e18);
        assertEq(r1, 4e18);
    }

    function test_FirstMintNeedsMoreThanMinimumLiquidity() public {
        token0.mint(address(pair), 1000);
        token1.mint(address(pair), 1000);
        vm.expectRevert(bytes("UniswapV2: INSUFFICIENT_LIQUIDITY_MINTED"));
        pair.mint(address(this));
    }

    /// @dev [amountIn, reserveIn, reserveOut, expectedOut] in units of 1e18 except expectedOut, from
    ///      v2-core's getInputPrice cases; each case runs in both directions on a fresh pair.
    function test_SwapVectorsBothDirections() public {
        uint256[4][7] memory cases = [
            [uint256(1), 5, 10, 1662497915624478906],
            [uint256(1), 10, 5, 453305446940074565],
            [uint256(2), 5, 10, 2851015155847869602],
            [uint256(2), 10, 5, 831248957812239453],
            [uint256(1), 10, 10, 906610893880149131],
            [uint256(1), 100, 100, 987158034397061298],
            [uint256(1), 1000, 1000, 996006981039903216]
        ];
        for (uint256 i = 0; i < cases.length; i++) {
            uint256 amountIn = cases[i][0] * 1e18;
            uint256 rIn = cases[i][1] * 1e18;
            uint256 rOut = cases[i][2] * 1e18;
            uint256 expected = cases[i][3];
            assertEq(amountOutFor(amountIn, rIn, rOut), expected);
            assertEq(router.getAmountOut(amountIn, rIn, rOut), expected);
            for (uint256 dir = 0; dir < 2; dir++) {
                (TestERC20 t0, TestERC20 t1) = sorted(new TestERC20("X", "X"), new TestERC20("Y", "Y"));
                IUniswapV2Pair p = IUniswapV2Pair(factory.createPair(address(t0), address(t1)));
                bool zeroForOne = dir == 0;
                t0.mint(address(p), zeroForOne ? rIn : rOut);
                t1.mint(address(p), zeroForOne ? rOut : rIn);
                p.mint(address(this));
                (zeroForOne ? t0 : t1).mint(address(p), amountIn);

                vm.expectRevert(bytes("UniswapV2: K"));
                p.swap(zeroForOne ? 0 : expected + 1, zeroForOne ? expected + 1 : 0, address(this), "");
                p.swap(zeroForOne ? 0 : expected, zeroForOne ? expected : 0, address(this), "");
                assertEq((zeroForOne ? t1 : t0).balanceOf(address(this)), expected);
            }
        }
    }

    /// @dev Flash swaps of the same token pay the fee on the way out: [amountOut, reserve0, reserve1, amountIn].
    function test_OptimisticVectors() public {
        uint256[4][4] memory cases = [
            [uint256(0.997e18), 5e18, 10e18, 1e18],
            [uint256(0.997e18), 10e18, 5e18, 1e18],
            [uint256(0.997e18), 5e18, 5e18, 1e18],
            [uint256(1e18), 5e18, 5e18, 1003009027081243732]
        ];
        for (uint256 i = 0; i < cases.length; i++) {
            (TestERC20 t0, TestERC20 t1) = sorted(new TestERC20("X", "X"), new TestERC20("Y", "Y"));
            IUniswapV2Pair p = IUniswapV2Pair(factory.createPair(address(t0), address(t1)));
            t0.mint(address(p), cases[i][1]);
            t1.mint(address(p), cases[i][2]);
            p.mint(address(this));
            t0.mint(address(p), cases[i][3]);
            vm.expectRevert(bytes("UniswapV2: K"));
            p.swap(cases[i][0] + 1, 0, address(this), "");
            p.swap(cases[i][0], 0, address(this), "");
        }
    }

    function test_SwapToken0() public {
        mintDirect(5e18, 10e18);
        uint256 out = 1662497915624478906;
        token0.mint(address(pair), 1e18);
        vm.expectEmit(address(pair));
        emit Sync(uint112(6e18), uint112(10e18 - out));
        vm.expectEmit(address(pair));
        emit Swap(address(this), 1e18, 0, 0, out, address(this));
        pair.swap(0, out, address(this), "");

        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 6e18);
        assertEq(r1, 10e18 - out);
        assertEq(token0.balanceOf(address(pair)), 6e18);
        assertEq(token1.balanceOf(address(pair)), 10e18 - out);
        assertEq(token1.balanceOf(address(this)), out);
    }

    function test_SwapToken1() public {
        mintDirect(5e18, 10e18);
        uint256 out = 453305446940074565;
        token1.mint(address(pair), 1e18);
        pair.swap(out, 0, address(this), "");
        (uint112 r0, uint112 r1,) = pair.getReserves();
        assertEq(r0, 5e18 - out);
        assertEq(r1, 11e18);
        assertEq(token0.balanceOf(address(this)), out);
    }

    function test_SwapGuards() public {
        mintDirect(5e18, 10e18);
        vm.expectRevert(bytes("UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT"));
        pair.swap(0, 0, address(this), "");
        vm.expectRevert(bytes("UniswapV2: INSUFFICIENT_LIQUIDITY"));
        pair.swap(0, 10e18, address(this), "");
        vm.expectRevert(bytes("UniswapV2: INVALID_TO"));
        pair.swap(0, 1, address(token1), "");
        vm.expectRevert(bytes("UniswapV2: INSUFFICIENT_INPUT_AMOUNT"));
        pair.swap(0, 1, address(this), "");
    }

    function test_Burn() public {
        mintDirect(3e18, 3e18);
        assertTrue(pair.transfer(address(pair), 3e18 - MINIMUM_LIQUIDITY));
        (uint256 amount0, uint256 amount1) = pair.burn(address(this));
        assertEq(amount0, 3e18 - MINIMUM_LIQUIDITY);
        assertEq(amount1, 3e18 - MINIMUM_LIQUIDITY);
        assertEq(pair.balanceOf(address(this)), 0);
        assertEq(pair.totalSupply(), MINIMUM_LIQUIDITY);
        assertEq(token0.balanceOf(address(pair)), 1000);
        assertEq(token1.balanceOf(address(pair)), 1000);
    }

    function test_FlashSwapRepaidWithFee() public {
        mintDirect(5e18, 10e18);
        FlashBorrower borrower = new FlashBorrower(pair, token1);
        uint256 borrowed = 1e18;
        uint256 repay = (borrowed * 1000) / 997 + 1; // 0.3% of the repayment
        token1.mint(address(borrower), repay);

        vm.expectRevert(bytes("UniswapV2: K"));
        borrower.borrow(borrowed, abi.encode(repay - 2, false));
        borrower.borrow(borrowed, abi.encode(repay, false));
        (, uint112 r1,) = pair.getReserves();
        assertEq(r1, 10e18 - borrowed + repay);
    }

    function test_FlashSwapCannotReenter() public {
        mintDirect(5e18, 10e18);
        FlashBorrower borrower = new FlashBorrower(pair, token1);
        token1.mint(address(borrower), 2e18);
        vm.expectRevert(bytes("UniswapV2: LOCKED"));
        borrower.borrow(1e18, abi.encode(2e18, true));
    }

    function test_SkimAndSync() public {
        mintDirect(5e18, 10e18);
        token0.mint(address(pair), 7); // a donation, or a rebase that raised the balance
        pair.skim(bob);
        assertEq(token0.balanceOf(bob), 7);
        token1.mint(address(pair), 9);
        pair.sync();
        (, uint112 r1,) = pair.getReserves();
        assertEq(r1, 10e18 + 9);
    }

    function test_FeeToOffByDefault() public {
        assertEq(factory.feeTo(), address(0));
        mintDirect(1000e18, 1000e18);
        token1.mint(address(pair), 1e18);
        pair.swap(996006981039903216, 0, address(this), "");
        assertTrue(pair.transfer(address(pair), 1000e18 - MINIMUM_LIQUIDITY));
        pair.burn(address(this));
        assertEq(pair.totalSupply(), MINIMUM_LIQUIDITY);
        assertEq(pair.kLast(), 0);
    }

    /// @dev v2-core's feeTo:on case: the protocol takes 1/6 of the growth in sqrt(k).
    function test_FeeToOnMintsOneSixthOfGrowth() public {
        vm.prank(feeToSetter);
        factory.setFeeTo(bob);
        mintDirect(1000e18, 1000e18);
        assertEq(pair.kLast(), 1000e18 * 1000e18);

        token1.mint(address(pair), 1e18);
        pair.swap(996006981039903216, 0, address(this), "");
        assertTrue(pair.transfer(address(pair), 1000e18 - MINIMUM_LIQUIDITY));
        pair.burn(address(this));

        assertEq(pair.totalSupply(), MINIMUM_LIQUIDITY + 249750499251388);
        assertEq(pair.balanceOf(bob), 249750499251388);
        assertEq(token0.balanceOf(address(pair)), 1000 + 249501683697445);
        assertEq(token1.balanceOf(address(pair)), 1000 + 250000187312969);
    }

    function test_FeeToOffAgainClearsKLast() public {
        vm.prank(feeToSetter);
        factory.setFeeTo(bob);
        mintDirect(1e18, 1e18);
        assertGt(pair.kLast(), 0);
        vm.prank(feeToSetter);
        factory.setFeeTo(address(0));
        mintDirect(1e18, 1e18);
        assertEq(pair.kLast(), 0);
        assertEq(pair.balanceOf(bob), 0);
    }
}
