// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LongToken} from "../src/LongToken.sol";

contract LongTokenTest is Test {
    function test_FixedSupplyAndDecimals() public {
        address holder = makeAddr("holder");
        LongToken t = new LongToken("LONGYU", "LONG", 10_000_000_000e18, holder);
        assertEq(t.totalSupply(), 10_000_000_000e18);
        assertEq(t.balanceOf(holder), 10_000_000_000e18);
        assertEq(t.decimals(), 18);
        assertEq(t.symbol(), "LONG");
    }

    function test_TransfersMoveExactAmounts() public {
        address holder = makeAddr("holder");
        address to = makeAddr("to");
        LongToken t = new LongToken("LONGYU", "LONG", 1_000e18, holder);
        vm.prank(holder);
        t.transfer(to, 123e18);
        assertEq(t.balanceOf(to), 123e18);
        assertEq(t.balanceOf(holder), 877e18);
        assertEq(t.totalSupply(), 1_000e18);
    }

    function test_RejectsBadConstructorArgs() public {
        vm.expectRevert(LongToken.InvalidHolder.selector);
        new LongToken("LONGYU", "LONG", 1, address(0));
        vm.expectRevert(LongToken.ZeroSupply.selector);
        new LongToken("LONGYU", "LONG", 0, address(1));
        vm.expectRevert(LongToken.NameOrSymbolTooLong.selector);
        new LongToken("A name that is far longer than thirty-two bytes", "LONG", 1, address(1));
    }
}
