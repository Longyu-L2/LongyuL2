// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

contract MockUSDT is ERC20 {
    constructor() ERC20("Tether USD", "USDT") {
        _mint(msg.sender, 1_000_000e18);
    }
}

/// Takes a 1% fee on every transfer, like some deflationary tokens.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {
        _mint(msg.sender, 1_000_000e18);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract RejectingTreasury {}

contract PaymentRouterTest is Test {
    PaymentRouter router;
    MockUSDT usdt;
    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address treasury = makeAddr("treasury");
    address buyer = makeAddr("buyer");

    function setUp() public {
        router = new PaymentRouter(admin, guardian, treasury);
        usdt = new MockUSDT();
        usdt.transfer(buyer, 1_000e18);
        vm.startPrank(admin);
        router.setAcceptedToken(address(usdt), true);
        router.setAcceptedToken(address(0), true);
        vm.stopPrank();
        vm.deal(buyer, 10 ether);
    }

    function test_PayTokenForwardsToTreasury() public {
        vm.startPrank(buyer);
        usdt.approve(address(router), 25e18);
        vm.expectEmit(true, true, true, true);
        emit PaymentRouter.OrderPaid(
            router.orderIdOf(keccak256("order-1"), address(usdt), 25e18), buyer, address(usdt), 25e18
        );
        router.payToken(keccak256("order-1"), address(usdt), 25e18);
        vm.stopPrank();
        assertEq(usdt.balanceOf(treasury), 25e18);
        assertEq(usdt.balanceOf(address(router)), 0);
        assertTrue(router.paid(router.orderIdOf(keccak256("order-1"), address(usdt), 25e18)));
        assertFalse(router.paid(keccak256("order-1")));
    }

    function test_PayNativeForwardsToTreasury() public {
        bytes32 id = router.orderIdOf(keccak256("order-2"), address(0), 1 ether);
        vm.expectEmit(true, true, true, true);
        emit PaymentRouter.OrderPaid(id, buyer, address(0), 1 ether);
        vm.prank(buyer);
        router.payNative{value: 1 ether}(keccak256("order-2"));
        assertTrue(router.paid(id));
        assertEq(treasury.balance, 1 ether);
        assertEq(address(router).balance, 0);
    }

    function test_OrderIdCommitsToChainRouterReferenceTokenAndAmount() public {
        bytes32 ref = keccak256("order-3");
        bytes32 id = router.orderIdOf(ref, address(usdt), 25e18);
        assertEq(
            id, keccak256(abi.encode(block.chainid, address(router), ref, address(usdt), uint256(25e18)))
        );
        assertTrue(id != router.orderIdOf(ref, address(usdt), 25e18 + 1));
        assertTrue(id != router.orderIdOf(ref, address(0), 25e18));
        assertTrue(id != router.orderIdOf(keccak256("order-4"), address(usdt), 25e18));
        PaymentRouter other = new PaymentRouter(admin, guardian, treasury);
        assertTrue(id != other.orderIdOf(ref, address(usdt), 25e18));
        vm.chainId(block.chainid + 1);
        assertTrue(id != router.orderIdOf(ref, address(usdt), 25e18));
    }

    /// Paying dust, or another token, under an order's reference does not use the order up.
    function test_DustUnderAnOrdersReferenceDoesNotBlockIt() public {
        bytes32 ref = keccak256("order-5");
        bytes32 id = router.orderIdOf(ref, address(usdt), 25e18);
        address stranger = makeAddr("stranger");
        usdt.transfer(stranger, 1e18);
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        usdt.approve(address(router), 1);
        router.payToken(ref, address(usdt), 1);
        router.payNative{value: 1}(ref);
        vm.stopPrank();
        assertFalse(router.paid(id));

        vm.startPrank(buyer);
        usdt.approve(address(router), 25e18);
        vm.expectEmit(true, true, true, true);
        emit PaymentRouter.OrderPaid(id, buyer, address(usdt), 25e18);
        router.payToken(ref, address(usdt), 25e18);
        vm.stopPrank();
        assertTrue(router.paid(id));
    }

    function test_RevertWhen_OrderPaidTwice() public {
        vm.startPrank(buyer);
        usdt.approve(address(router), 50e18);
        router.payToken(keccak256("order-1"), address(usdt), 25e18);
        vm.expectRevert(PaymentRouter.AlreadyPaid.selector);
        router.payToken(keccak256("order-1"), address(usdt), 25e18);
        router.payNative{value: 1 ether}(keccak256("order-6"));
        vm.expectRevert(PaymentRouter.AlreadyPaid.selector);
        router.payNative{value: 1 ether}(keccak256("order-6"));
        vm.stopPrank();
    }

    function test_RevertWhen_TokenNotAccepted() public {
        MockUSDT other = new MockUSDT();
        vm.expectRevert(PaymentRouter.TokenNotAccepted.selector);
        router.payToken(keccak256("o"), address(other), 1);
        vm.expectRevert(PaymentRouter.TokenNotAccepted.selector);
        router.payToken(keccak256("o"), address(0), 1);
        vm.prank(admin);
        router.setAcceptedToken(address(0), false);
        vm.prank(buyer);
        vm.expectRevert(PaymentRouter.NativeNotAccepted.selector);
        router.payNative{value: 1}(keccak256("o"));
    }

    function test_RevertWhen_FeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        vm.prank(admin);
        router.setAcceptedToken(address(fee), true);
        fee.approve(address(router), 100e18);
        vm.expectRevert(abi.encodeWithSelector(PaymentRouter.TransferShortfall.selector, 100e18, 99e18));
        router.payToken(keccak256("o"), address(fee), 100e18);
    }

    function test_RevertWhen_ZeroAmountOrZeroReference() public {
        vm.startPrank(buyer);
        vm.expectRevert(PaymentRouter.ZeroAmount.selector);
        router.payNative{value: 0}(keccak256("o"));
        vm.expectRevert(PaymentRouter.ZeroAmount.selector);
        router.payToken(keccak256("o"), address(usdt), 0);
        vm.expectRevert(PaymentRouter.ZeroReference.selector);
        router.payNative{value: 1}(bytes32(0));
        usdt.approve(address(router), 1);
        vm.expectRevert(PaymentRouter.ZeroReference.selector);
        router.payToken(bytes32(0), address(usdt), 1);
        vm.stopPrank();
    }

    function test_RevertWhen_TreasuryRejectsNative() public {
        RejectingTreasury bad = new RejectingTreasury();
        vm.prank(admin);
        router.setTreasury(address(bad));
        vm.prank(buyer);
        vm.expectRevert(PaymentRouter.ForwardFailed.selector);
        router.payNative{value: 1}(keccak256("o"));
    }

    function test_PauseAndAdminControls() public {
        vm.prank(guardian);
        router.pause();
        vm.prank(buyer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.payNative{value: 1}(keccak256("o"));
        vm.prank(admin);
        router.unpause();
        vm.prank(buyer);
        vm.expectRevert();
        router.setTreasury(buyer);
        vm.prank(admin);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        router.setTreasury(address(0));
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        new PaymentRouter(address(0), guardian, treasury);
    }
}
