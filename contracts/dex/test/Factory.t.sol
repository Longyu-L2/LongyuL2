// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {DexFixture} from "./utils/DexFixture.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";

contract FactoryTest is DexFixture {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    function test_ConstructorSetsFeeToSetterAndLeavesFeeOff() public view {
        assertEq(factory.feeToSetter(), feeToSetter);
        assertEq(factory.feeTo(), address(0));
        assertEq(factory.allPairsLength(), 0);
        assertEq(router.factory(), address(factory));
        assertEq(router.WETH(), address(weth));
    }

    function test_CreatePair() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        address expected = pairAddress(address(factory), t0, t1);

        vm.expectEmit(address(factory));
        emit PairCreated(t0, t1, expected, 1);
        address pair = factory.createPair(address(tokenB), address(tokenA));

        assertEq(pair, expected);
        assertEq(factory.getPair(t0, t1), pair);
        assertEq(factory.getPair(t1, t0), pair);
        assertEq(factory.allPairs(0), pair);
        assertEq(factory.allPairsLength(), 1);
        assertEq(IUniswapV2Pair(pair).factory(), address(factory));
        assertEq(IUniswapV2Pair(pair).token0(), t0);
        assertEq(IUniswapV2Pair(pair).token1(), t1);
        assertEq(IUniswapV2Pair(pair).totalSupply(), 0);
    }

    function test_CreatePairReverts() public {
        address a = address(tokenA);
        address b = address(tokenB);
        vm.expectRevert(bytes("UniswapV2: IDENTICAL_ADDRESSES"));
        factory.createPair(a, a);
        vm.expectRevert(bytes("UniswapV2: ZERO_ADDRESS"));
        factory.createPair(address(0), a);
        vm.expectRevert(bytes("UniswapV2: ZERO_ADDRESS"));
        factory.createPair(a, address(0));

        factory.createPair(a, b);
        vm.expectRevert(bytes("UniswapV2: PAIR_EXISTS"));
        factory.createPair(a, b);
        vm.expectRevert(bytes("UniswapV2: PAIR_EXISTS"));
        factory.createPair(b, a);
    }

    /// @dev Factory (CREATE2 with the real creation code) and library formula agree for any token pair.
    function testFuzz_PairAddressMatchesLibraryFormula(address a, address b) public {
        vm.assume(a != b && a != address(0) && b != address(0));
        address pair = factory.createPair(a, b);
        assertEq(pair, pairAddress(address(factory), a, b));
        assertEq(pair, pairAddress(address(factory), b, a));
        assertGt(pair.code.length, 0);
    }

    function test_PairInitializeIsFactoryOnly() public {
        IUniswapV2Pair pair = IUniswapV2Pair(factory.createPair(address(tokenA), address(tokenB)));
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        pair.initialize(address(tokenB), address(tokenA));
    }

    function test_SetFeeToIsFeeToSetterOnly() public {
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeTo(bob);
        vm.prank(alice);
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeTo(alice);

        vm.prank(feeToSetter);
        factory.setFeeTo(bob);
        assertEq(factory.feeTo(), bob);
        vm.prank(feeToSetter);
        factory.setFeeTo(address(0));
        assertEq(factory.feeTo(), address(0));
    }

    function test_SetFeeToSetterIsFeeToSetterOnly() public {
        vm.prank(alice);
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeToSetter(alice);

        vm.prank(feeToSetter);
        factory.setFeeToSetter(bob);
        assertEq(factory.feeToSetter(), bob);

        // The old setter has lost both powers; the new one has them.
        vm.startPrank(feeToSetter);
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeTo(feeToSetter);
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeToSetter(feeToSetter);
        vm.stopPrank();

        vm.prank(bob);
        factory.setFeeTo(alice);
        assertEq(factory.feeTo(), alice);
    }

    function testFuzz_OnlyFeeToSetterCanChangeFees(address caller, address target) public {
        vm.assume(caller != feeToSetter);
        vm.startPrank(caller);
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeTo(target);
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeToSetter(target);
        vm.stopPrank();
    }
}
