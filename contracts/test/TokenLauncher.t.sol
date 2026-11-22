// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LaunchedToken, TokenLauncher} from "../src/TokenLauncher.sol";

contract TokenLauncherTest is Test {
    TokenLauncher launcher;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 supply);

    function setUp() public {
        launcher = new TokenLauncher();
    }

    function test_launch_givesTheWholeSupplyToTheCaller() public {
        vm.prank(alice);
        address t = launcher.launch("Pearl Coin", "PEARL", 1_000_000);
        LaunchedToken token = LaunchedToken(t);
        assertEq(token.name(), "Pearl Coin");
        assertEq(token.symbol(), "PEARL");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1_000_000e18);
        assertEq(token.balanceOf(alice), 1_000_000e18);
        assertEq(token.creator(), alice);
        assertTrue(launcher.launched(t));
        assertEq(launcher.tokenCount(), 1);
        assertEq(launcher.tokens(0), t);

        // A plain token: transfers and approvals work for anyone, and nobody can mint more.
        vm.prank(alice);
        token.transfer(bob, 5e18);
        assertEq(token.balanceOf(bob), 5e18);
        vm.prank(bob);
        token.approve(alice, 1e18);
        vm.prank(alice);
        token.transferFrom(bob, alice, 1e18);
        assertEq(token.balanceOf(bob), 4e18);
        assertEq(token.totalSupply(), 1_000_000e18);
    }

    function test_launch_emitsTheEvent() public {
        vm.expectEmit(false, true, false, true, address(launcher));
        emit TokenLaunched(address(0), alice, "Pearl Coin", "PEARL", 7e18);
        vm.prank(alice);
        launcher.launch("Pearl Coin", "PEARL", 7);
    }

    function test_launch_supplyLimits() public {
        vm.expectRevert(TokenLauncher.BadSupply.selector);
        launcher.launch("A", "A", 0);
        vm.expectRevert(TokenLauncher.BadSupply.selector);
        launcher.launch("A", "A", 1e15 + 1);
        address t = launcher.launch("A", "A", 1e15);
        // The whole supply fits a pool's uint112 reserve.
        assertLe(LaunchedToken(t).totalSupply(), type(uint112).max);
        launcher.launch("B", "B", 1);
    }

    function test_launch_namesAndSymbols() public {
        string[6] memory badNames = ["", " Lead", "Trail ", "123456789012345678901234567890123", unicode"Café", "Tab\tName"];
        for (uint256 i = 0; i < badNames.length; i++) {
            vm.expectRevert(TokenLauncher.BadName.selector);
            launcher.launch(badNames[i], "OK", 1);
        }
        string[5] memory badSymbols = ["", "$PEPE", "TWELVECHARSX", "A B", unicode"ЛОНГ"];
        for (uint256 i = 0; i < badSymbols.length; i++) {
            vm.expectRevert(TokenLauncher.BadSymbol.selector);
            launcher.launch("Fine", badSymbols[i], 1);
        }
        launcher.launch("12345678901234567890123456789012", "ABCDEFGHIJ1", 1);
        launcher.launch("Pepe & Co. (v2)! #1", "pepe", 1);
    }

    function test_launch_refusesNamesThatPassForLongyu() public {
        string[2][10] memory reserved = [
            ["Long", "X"], ["X", "LONG"], ["X", "long"], ["X", "L0NG"], ["X", "tLONG"], ["X", "WLONG"],
            ["Longyu Coin", "LYC"], ["Long Yu", "LY"], ["L0NG-YU", "X"], ["X", "LONGYU2"]
        ];
        for (uint256 i = 0; i < reserved.length; i++) {
            vm.expectRevert(TokenLauncher.ReservedName.selector);
            launcher.launch(reserved[i][0], reserved[i][1], 1);
        }
        // Other names with LONG in them are fine.
        launcher.launch("Longevity", "LGV", 1);
        launcher.launch("Long Meme", "LMEME", 1);
        launcher.launch("Belong", "BLONG", 1);
    }

    function test_tokensFrom_pages() public {
        address[] memory made = new address[](5);
        for (uint256 i = 0; i < 5; i++) {
            made[i] = launcher.launch("T", "T", 1);
        }
        address[] memory page = launcher.tokensFrom(1, 3);
        assertEq(page.length, 3);
        assertEq(page[0], made[1]);
        assertEq(page[2], made[3]);
        assertEq(launcher.tokensFrom(3, 10).length, 2);
        assertEq(launcher.tokensFrom(5, 10).length, 0);
        assertEq(launcher.tokensFrom(99, 1).length, 0);
    }

    function testFuzz_launch_anyValidSupply(uint256 whole) public {
        whole = bound(whole, 1, 1e15);
        vm.prank(alice);
        address t = launcher.launch("Fuzz", "FZ", whole);
        assertEq(LaunchedToken(t).balanceOf(alice), whole * 1e18);
    }
}
