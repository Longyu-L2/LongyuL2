// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";
import {MintingVault} from "../src/MintingVault.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";
import {LongMiningToken} from "../src/LongMiningToken.sol";
import {Merkle} from "./utils/Merkle.sol";

/// LONG on mainnet: created only by mining, locked until the TGE, at most 10 billion.
contract LongMiningTest is Test {
    uint256 constant START = 20_000 days;
    uint256 constant DAILY = 12_000_000e18;
    uint256 constant POOL = 3_500_000_000e18;
    uint256 constant MAX_PER_DAY = 90e18;
    uint256 constant DELAY = 12 hours;

    address admin = makeAddr("timelock");
    address publisher = makeAddr("publisher");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    EmissionSchedule schedule;
    LongMiningToken long;
    MintingVault vault;
    MiningDistributor dist;
    uint64 deadline;

    function setUp() public {
        vm.warp(START + 2 days + 1 hours);
        deadline = uint64(block.timestamp + 365 days);
        schedule = new EmissionSchedule(START, DAILY, 30, 0, POOL);
        long = new LongMiningToken(admin, schedule, deadline);
        vault = new MintingVault(address(long), schedule, admin);
        dist = _distributor();
        vm.startPrank(admin);
        long.setMiningMinter(address(vault));
        long.grantRole(long.ALLOCATOR_ROLE(), admin);
        vault.setDistributor(address(dist));
        dist.setVault(vault);
        vm.stopPrank();
    }

    function _distributor() internal returns (MiningDistributor) {
        return new MiningDistributor(
            address(long), schedule, MAX_PER_DAY, DELAY, 2 * DAILY, admin, publisher, guardian, address(0)
        );
    }

    function _leaves(MiningDistributor d, uint256 a, uint256 b) internal view returns (bytes32[] memory l) {
        l = new bytes32[](2);
        l[0] = d.leaf(alice, a);
        l[1] = d.leaf(bob, b);
    }

    function _activate(MiningDistributor d, uint64 day, uint256 a, uint256 b) internal {
        bytes32 root = Merkle.root(_leaves(d, a, b));
        vm.prank(publisher);
        d.proposeRoot(day, root, a + b, bytes32(0), "");
        vm.warp(block.timestamp + DELAY);
    }

    function _claim(MiningDistributor d, address who, uint256 i) internal {
        bytes32[] memory p = Merkle.proof(_leaves(d, 40e18, 20e18), i);
        d.claim(who, i == 0 ? 40e18 : 20e18, p);
    }

    function test_SupplyStartsAtZeroAndGrowsOnlyByMining() public {
        assertEq(long.totalSupply(), 0);
        _activate(dist, 0, 40e18, 20e18);
        _claim(dist, alice, 0);
        // The first claim created the whole claimable total, and nothing more.
        assertEq(long.totalSupply(), 60e18);
        assertEq(long.mined(), 60e18);
        assertEq(long.balanceOf(alice), 40e18);
        assertEq(long.balanceOf(address(dist)), 20e18);
        _claim(dist, bob, 1);
        assertEq(long.balanceOf(bob), 20e18);
        assertEq(long.totalSupply(), 60e18);
    }

    function test_MinedLongIsLockedUntilTheTge() public {
        _activate(dist, 0, 40e18, 20e18);
        _claim(dist, alice, 0);
        vm.prank(alice);
        vm.expectRevert(LongMiningToken.Locked.selector);
        long.transfer(bob, 1);
        // Nor can it be approved, so no approval of locked LONG can be sold in advance.
        vm.prank(alice);
        vm.expectRevert(LongMiningToken.Locked.selector);
        long.approve(bob, 1);

        vm.prank(alice);
        vm.expectRevert();
        long.unlock();
        vm.prank(admin);
        long.unlock();
        assertTrue(long.isUnlocked());
        vm.prank(alice);
        long.transfer(bob, 1);
        assertEq(long.balanceOf(bob), 1);
        vm.prank(admin);
        vm.expectRevert(LongMiningToken.AlreadyUnlocked.selector);
        long.unlock();
    }

    function test_TheLockEndsByItselfAtTheDeadline() public {
        _activate(dist, 0, 40e18, 20e18);
        _claim(dist, alice, 0);
        vm.warp(deadline - 1);
        vm.prank(alice);
        vm.expectRevert(LongMiningToken.Locked.selector);
        long.transfer(bob, 1);
        vm.warp(deadline);
        vm.prank(alice);
        long.transfer(bob, 1);
    }

    function test_OnlyTheVaultMintsAndNeverBeyondThePool() public {
        vm.prank(admin);
        vm.expectRevert(LongMiningToken.NotMiningMinter.selector);
        long.mintMined(admin, 1);
        // The minter is named once and for good.
        vm.prank(admin);
        vm.expectRevert(LongMiningToken.MinterAlreadySet.selector);
        long.setMiningMinter(admin);
        // Even the vault cannot create more than the schedule's budget to date (three days of it).
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(LongMiningToken.AboveSchedule.selector, 3 * DAILY + 1, 3 * DAILY));
        long.mintMined(alice, 3 * DAILY + 1);
        vm.prank(address(vault));
        vm.expectRevert(abi.encodeWithSelector(LongMiningToken.AboveMiningCap.selector, POOL + 1, POOL));
        long.mintMined(alice, POOL + 1);
    }

    function test_AllocationsComeOnlyAfterTheTgeAndWithinTheTenBillion() public {
        vm.prank(admin);
        vm.expectRevert(LongMiningToken.Locked.selector);
        long.mintAllocation(admin, 1);
        vm.startPrank(admin);
        long.unlock();
        uint256 rest = 10_000_000_000e18 - POOL;
        vm.expectRevert(abi.encodeWithSelector(LongMiningToken.AboveAllocationCap.selector, rest + 1, rest));
        long.mintAllocation(admin, rest + 1);
        long.mintAllocation(admin, rest);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert();
        long.mintAllocation(alice, 0);
        // Mining can still fill its pool once the schedule reaches it; together never more than 10 billion.
        vm.warp(START + 300 days);
        vm.prank(address(vault));
        long.mintMined(alice, POOL);
        assertEq(long.totalSupply(), 10_000_000_000e18);
    }

    function test_TheVaultNeverCreatesMoreThanTheSchedule() public {
        // The distributor's claimable total is bounded by the budget to date, and so is what is created.
        uint256 budget = schedule.cumulativeBudget(schedule.currentDay());
        assertEq(budget, 3 * DAILY);
        _activate(dist, 1, 90e18, 90e18);
        assertEq(vault.releasable(), 180e18);
        vault.release();
        assertEq(long.totalSupply(), 180e18);
        assertEq(vault.release(), 0);
    }

    function test_AReplacedDistributorGivesBackAndTheSuccessorPaysIt() public {
        _activate(dist, 0, 40e18, 20e18);
        _claim(dist, alice, 0);
        assertEq(long.balanceOf(address(dist)), 20e18, "bob's 20 still owed");

        // The successor carries over alice's 40 claimed and owes bob his 20 (and anything new).
        vm.prank(guardian);
        dist.pause();
        MiningDistributor next = new MiningDistributor(
            address(long), schedule, MAX_PER_DAY, DELAY, 2 * DAILY, admin, publisher, guardian, address(dist)
        );
        vm.startPrank(admin);
        vault.setDistributor(address(next));
        next.setVault(vault);
        vm.stopPrank();
        address[] memory accounts = new address[](1);
        accounts[0] = alice;
        vm.startPrank(admin);
        next.carryOver(accounts);
        next.completeCarryOver();
        vm.stopPrank();
        assertEq(dist.returnToVault(), 20e18);
        assertEq(vault.released(), 40e18);

        _activate(next, 1, 40e18, 20e18);
        _claim(next, bob, 1);
        assertEq(long.balanceOf(bob), 20e18);
        // Bob was paid from what came back; nothing new was created for him.
        assertEq(long.totalSupply(), 60e18);
        assertEq(long.balanceOf(address(vault)), 0);
    }

    function test_ConstructorRefusesBadSettings() public {
        vm.expectRevert(LongMiningToken.ZeroAddress.selector);
        new LongMiningToken(address(0), schedule, deadline);
        EmissionSchedule huge = new EmissionSchedule(START, DAILY, 30, 0, 10_000_000_000e18 + 1);
        vm.expectRevert(abi.encodeWithSelector(LongMiningToken.CapOutOfRange.selector, 10_000_000_000e18 + 1));
        new LongMiningToken(admin, huge, deadline);
        uint64 late = uint64(block.timestamp + 3 * 365 days + 1);
        vm.expectRevert(abi.encodeWithSelector(LongMiningToken.DeadlineOutOfRange.selector, late));
        new LongMiningToken(admin, schedule, late);
        uint64 past = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(LongMiningToken.DeadlineOutOfRange.selector, past));
        new LongMiningToken(admin, schedule, past);
    }

    function test_ARetiredDistributorPaysNothingMore() public {
        _activate(dist, 0, 40e18, 20e18);
        MiningDistributor next = _distributor();
        vm.prank(admin);
        vault.setDistributor(address(next));
        bytes32[] memory p = Merkle.proof(_leaves(dist, 40e18, 20e18), 0);
        vm.expectRevert(MiningDistributor.Retired.selector);
        dist.claim(alice, 40e18, p);
        // Its vault is fixed, so what it holds can only go back there.
        vm.prank(admin);
        vm.expectRevert(MiningDistributor.VaultAlreadySet.selector);
        dist.setVault(vault);
    }
}
