// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Faucet} from "../src/Faucet.sol";

contract FaucetTest is Test {
    Faucet faucet;
    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 signerKey = 0xA11CE;
    address signer;

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        vm.warp(1_800_000_000);
        signer = vm.addr(signerKey);
        faucet = new Faucet(address(0), admin, signer, guardian, 1e18, 1 days, 3e18);
        vm.deal(address(faucet), 100e18);
    }

    function _sign(uint256 key, address recipient, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("LONGYU Faucet"), keccak256("1"), block.chainid, address(faucet)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(faucet.VOUCHER_TYPEHASH(), recipient, amount, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_DripWithValidVoucher() public {
        bytes memory sig = _sign(signerKey, alice, 1e18, 1, block.timestamp + 1 hours);
        vm.prank(bob); // anyone may submit; funds go to the voucher's recipient
        faucet.drip(alice, 1e18, 1, block.timestamp + 1 hours, sig);
        assertEq(alice.balance, 1e18);
    }

    function test_RevertWhen_WrongSigner() public {
        bytes memory sig = _sign(0xB0B, alice, 1e18, 1, block.timestamp + 1 hours);
        vm.expectRevert(Faucet.InvalidSigner.selector);
        faucet.drip(alice, 1e18, 1, block.timestamp + 1 hours, sig);
    }

    function test_RevertWhen_VoucherAltered() public {
        bytes memory sig = _sign(signerKey, alice, 1e18, 1, block.timestamp + 1 hours);
        vm.expectRevert(Faucet.InvalidSigner.selector);
        faucet.drip(bob, 1e18, 1, block.timestamp + 1 hours, sig);
    }

    function test_RevertWhen_Expired() public {
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _sign(signerKey, alice, 1e18, 1, deadline);
        vm.expectRevert(Faucet.VoucherExpired.selector);
        faucet.drip(alice, 1e18, 1, deadline, sig);
    }

    function test_RevertWhen_NonceReused() public {
        uint256 deadline = block.timestamp + 10 days;
        faucet.drip(alice, 1e18, 7, deadline, _sign(signerKey, alice, 1e18, 7, deadline));
        bytes memory sig = _sign(signerKey, bob, 1e18, 7, deadline);
        vm.expectRevert(Faucet.NonceUsed.selector);
        faucet.drip(bob, 1e18, 7, deadline, sig);
    }

    function test_CooldownPerRecipient() public {
        uint256 deadline = block.timestamp + 10 days;
        faucet.drip(alice, 1e18, 1, deadline, _sign(signerKey, alice, 1e18, 1, deadline));
        bytes memory sig = _sign(signerKey, alice, 1e18, 2, deadline);
        vm.expectRevert(abi.encodeWithSelector(Faucet.CoolingDown.selector, block.timestamp + 1 days));
        faucet.drip(alice, 1e18, 2, deadline, sig);
        vm.warp(block.timestamp + 1 days);
        faucet.drip(alice, 1e18, 2, deadline, sig);
        assertEq(alice.balance, 2e18);
    }

    function test_DailyCap() public {
        uint256 deadline = block.timestamp + 10 days;
        for (uint256 i; i < 3; ++i) {
            address r = address(uint160(0x1000 + i));
            faucet.drip(r, 1e18, i, deadline, _sign(signerKey, r, 1e18, i, deadline));
        }
        address d = address(0x2000);
        bytes memory sig = _sign(signerKey, d, 1e18, 99, deadline);
        vm.expectRevert(Faucet.DailyCapReached.selector);
        faucet.drip(d, 1e18, 99, deadline, sig);
        vm.warp(block.timestamp + 1 days);
        faucet.drip(d, 1e18, 99, deadline, sig);
    }

    function test_RevertWhen_AmountAboveMax() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(signerKey, alice, 2e18, 1, deadline);
        vm.expectRevert(Faucet.InvalidAmount.selector);
        faucet.drip(alice, 2e18, 1, deadline, sig);
    }

    function test_Pause() public {
        vm.prank(guardian);
        faucet.pause();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(signerKey, alice, 1e18, 1, deadline);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        faucet.drip(alice, 1e18, 1, deadline, sig);
    }

    function test_ConstructorAndSetterValidation() public {
        vm.expectRevert(Faucet.ZeroAddress.selector);
        new Faucet(address(0), address(0), signer, guardian, 1, 0, 1);
        vm.expectRevert(Faucet.ZeroAddress.selector);
        new Faucet(address(0), admin, address(0), guardian, 1, 0, 1);
        vm.expectRevert(Faucet.ZeroAddress.selector);
        new Faucet(address(0), admin, signer, address(0), 1, 0, 1);
        vm.expectRevert(Faucet.InvalidAmount.selector);
        new Faucet(address(0), admin, signer, guardian, 0, 0, 1);
        vm.expectRevert(Faucet.InvalidAmount.selector);
        new Faucet(address(0), admin, signer, guardian, 2, 0, 1);
        vm.startPrank(admin);
        vm.expectRevert(Faucet.ZeroAddress.selector);
        faucet.withdraw(address(0), 1);
        faucet.setLimits(2e18, 0, 2e18);
        vm.stopPrank();
        assertEq(faucet.maxPerVoucher(), 2e18);
    }

    function test_RevertWhen_RecipientZero() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(signerKey, address(0), 1e18, 1, deadline);
        vm.expectRevert(Faucet.ZeroAddress.selector);
        faucet.drip(address(0), 1e18, 1, deadline, sig);
    }

    function test_Erc20FaucetRejectsNative() public {
        Faucet f = new Faucet(address(0xBEEF), admin, signer, guardian, 1, 0, 1);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(f).call{value: 1}("");
        assertFalse(ok);
    }

    function test_AdminUnpauses() public {
        vm.prank(guardian);
        faucet.pause();
        vm.prank(guardian);
        vm.expectRevert();
        faucet.unpause();
        vm.prank(admin);
        faucet.unpause();
        assertFalse(faucet.paused());
    }

    function test_OnlyAdminWithdrawsAndSetsLimits() public {
        vm.prank(alice);
        vm.expectRevert();
        faucet.withdraw(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert();
        faucet.setLimits(5e18, 0, 5e18);
        vm.prank(admin);
        faucet.withdraw(admin, 10e18);
        assertEq(admin.balance, 10e18);
    }
}
