// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";
import {MiningVault} from "../src/MiningVault.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";
import {LongToken} from "../src/LongToken.sol";
import {AssetTransfer} from "../src/libraries/AssetTransfer.sol";
import {Merkle} from "./utils/Merkle.sol";

/// @dev Shared tests, run once with native tLONG (Option A) and once with an ERC-20 (Option C).
abstract contract MiningDistributorTestBase is Test {
    uint256 constant START = 20_000 days;
    uint256 constant DAILY = 12_000_000e18;
    uint256 constant POOL = 4_000_000_000e18;
    uint256 constant MAX_PER_DAY = 43e18;
    uint256 constant DELAY = 12 hours;

    address admin = makeAddr("admin");
    address publisher = makeAddr("publisher");
    address guardian = makeAddr("guardian");
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    EmissionSchedule schedule;
    MiningVault vault;
    MiningDistributor dist;

    address[] accts;
    uint256[] amts;

    function _asset() internal virtual returns (address);
    function _fund(address to, uint256 amount) internal virtual;
    function _balanceOf(address who) internal view virtual returns (uint256);

    function setUp() public virtual {
        vm.warp(START + 10 days + 1 hours);
        schedule = new EmissionSchedule(START, DAILY, 30, 0, POOL);
        address asset = _asset();
        vault = new MiningVault(asset, schedule, admin);
        dist =
            new MiningDistributor(asset, schedule, MAX_PER_DAY, DELAY, 2 * DAILY, admin, publisher, guardian);
        vm.startPrank(admin);
        vault.setDistributor(address(dist));
        dist.setVault(vault);
        vm.stopPrank();
        _fund(address(vault), POOL);
    }

    // --------------------------------------------------------------- helpers

    function _set3(uint256 a, uint256 b, uint256 c) internal {
        delete accts;
        delete amts;
        accts.push(alice);
        accts.push(bob);
        accts.push(carol);
        amts.push(a);
        amts.push(b);
        amts.push(c);
    }

    function _leaves() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](accts.length);
        for (uint256 i; i < accts.length; ++i) {
            leaves[i] = dist.leaf(accts[i], amts[i]);
        }
    }

    function _sum() internal view returns (uint256 s) {
        for (uint256 i; i < amts.length; ++i) {
            s += amts[i];
        }
    }

    function _post(uint64 day) internal returns (bytes32 root) {
        root = Merkle.root(_leaves());
        vm.prank(publisher);
        dist.proposeRoot(day, root, _sum(), keccak256("data"), "ipfs://data");
    }

    function _postAndActivate(uint64 day) internal returns (bytes32 root) {
        root = _post(day);
        vm.warp(block.timestamp + DELAY);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) {
        return Merkle.proof(_leaves(), i);
    }

    // ------------------------------------------------------------------ roots

    function test_RootClaimableOnlyAfterDelay() public {
        _set3(24e18, 30e18, 12e18);
        _post(0);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                MiningDistributor.ClaimRejected.selector, MiningDistributor.SkipReason.NoActiveRoot
            )
        );
        dist.claim(alice, 24e18, p);

        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        dist.claim(alice, 24e18, p);

        vm.warp(block.timestamp + 1);
        assertEq(dist.claim(alice, 24e18, p), 24e18);
        assertEq(_balanceOf(alice), 24e18);
        assertEq(dist.claimed(alice), 24e18);
        assertEq(dist.totalClaimed(), 24e18);
    }

    function test_GuardianCanVetoPendingRoot() public {
        _set3(24e18, 30e18, 12e18);
        bytes32 root = _post(0);
        vm.prank(guardian);
        dist.vetoPendingRoot();
        assertEq(dist.pendingRoot().root, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        assertEq(dist.activeRoot().root, bytes32(0));
        // A corrected root for the same day can be posted after a veto.
        _set3(20e18, 30e18, 12e18);
        bytes32 root2 = _postAndActivate(0);
        assertTrue(root2 != root);
        assertEq(dist.activeRoot().root, root2);
    }

    function test_VetoAfterMaturityReverts() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        vm.prank(guardian);
        vm.expectRevert(MiningDistributor.RootAlreadyClaimable.selector);
        dist.vetoPendingRoot();
    }

    function test_OnlyRolesCanPostVetoPause() public {
        _set3(24e18, 30e18, 12e18);
        bytes32 root = Merkle.root(_leaves());
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, dist.PUBLISHER_ROLE()
            )
        );
        vm.prank(alice);
        dist.proposeRoot(0, root, 66e18, bytes32(0), "");

        _post(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, publisher, dist.GUARDIAN_ROLE()
            )
        );
        vm.prank(publisher);
        dist.vetoPendingRoot();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, dist.GUARDIAN_ROLE()
            )
        );
        vm.prank(alice);
        dist.pause();
    }

    function test_RevertWhen_DayNotIncreasing() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(3);
        _set3(48e18, 60e18, 24e18);
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MiningDistributor.DayNotIncreasing.selector, 3, 3));
        dist.proposeRoot(3, root, _sum(), bytes32(0), "");
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MiningDistributor.DayNotIncreasing.selector, 2, 3));
        dist.proposeRoot(2, root, _sum(), bytes32(0), "");
    }

    function test_RevertWhen_DayNotClosed() public {
        _set3(24e18, 30e18, 12e18);
        bytes32 root = Merkle.root(_leaves());
        uint256 today = schedule.currentDay();
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MiningDistributor.DayNotClosed.selector, today, today));
        dist.proposeRoot(uint64(today), root, _sum(), bytes32(0), "");
    }

    function test_RevertWhen_BudgetExceeded() public {
        _set3(24e18, 30e18, 12e18);
        bytes32 root = Merkle.root(_leaves());
        uint256 budget = schedule.cumulativeBudget(0);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MiningDistributor.BudgetExceeded.selector, budget + 1, budget));
        dist.proposeRoot(0, root, budget + 1, bytes32(0), "");
    }

    function test_RunningCapAllowsBacklogWithinCumulativeBudget() public {
        // Day 0 used little budget; a later day may release a verified user's backlog as long as
        // the running total stays within the cumulative budget.
        _set3(24e18, 0, 0);
        _postAndActivate(0);
        uint256 budget = schedule.cumulativeBudget(1);
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        dist.proposeRoot(1, root, budget, bytes32(0), "");
    }

    function test_RevertWhen_SecondRootWhilePending() public {
        _set3(24e18, 30e18, 12e18);
        _post(0);
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        vm.expectRevert(MiningDistributor.RootPending.selector);
        dist.proposeRoot(1, root, _sum(), bytes32(0), "");
    }

    function test_RevertWhen_TotalBelowClaimed() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        dist.claim(alice, 24e18, _proof(0));
        _set3(24e18, 30e18, 12e18);
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MiningDistributor.TotalBelowClaimed.selector, 1e18, 24e18));
        dist.proposeRoot(1, root, 1e18, bytes32(0), "");
    }

    function test_RevertWhen_ZeroRoot() public {
        vm.prank(publisher);
        vm.expectRevert(MiningDistributor.InvalidRoot.selector);
        dist.proposeRoot(0, bytes32(0), 0, bytes32(0), "");
    }

    // ----------------------------------------------------------------- claims

    function test_SecondRootPaysOnlyTheDifference() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        dist.claim(alice, 24e18, _proof(0));

        _set3(50e18, 60e18, 24e18);
        _postAndActivate(1);
        assertEq(dist.claim(alice, 50e18, _proof(0)), 26e18);
        assertEq(_balanceOf(alice), 50e18);

        bytes32[] memory p = _proof(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                MiningDistributor.ClaimRejected.selector, MiningDistributor.SkipReason.NothingToClaim
            )
        );
        dist.claim(alice, 50e18, p);
    }

    function test_ForfeitureNeverClawsBack() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        dist.claim(alice, 24e18, _proof(0));
        // Alice is caught; her leaf is frozen at what she already claimed. Bob is unaffected.
        _set3(24e18, 60e18, 24e18);
        _postAndActivate(1);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                MiningDistributor.ClaimRejected.selector, MiningDistributor.SkipReason.NothingToClaim
            )
        );
        dist.claim(alice, 24e18, p);
        assertEq(_balanceOf(alice), 24e18);
        assertEq(dist.claim(bob, 60e18, _proof(1)), 60e18);
    }

    function test_RelayerCannotRedirectFunds() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        bytes32[] memory p = _proof(1);
        vm.prank(relayer);
        dist.claim(bob, 30e18, p);
        assertEq(_balanceOf(bob), 30e18);
        assertEq(_balanceOf(relayer), 0);
    }

    function test_RevertWhen_ProofInvalid() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        bytes32[] memory pAlice = _proof(0);
        bytes memory err = abi.encodeWithSelector(
            MiningDistributor.ClaimRejected.selector, MiningDistributor.SkipReason.InvalidProof
        );
        vm.expectRevert(err);
        dist.claim(alice, 25e18, pAlice); // inflated amount
        vm.expectRevert(err);
        dist.claim(bob, 24e18, pAlice); // someone else's proof
    }

    function test_LeafIsBoundToChainAndContract() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        bytes32[] memory p = _proof(0);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                MiningDistributor.ClaimRejected.selector, MiningDistributor.SkipReason.InvalidProof
            )
        );
        dist.claim(alice, 24e18, p);
    }

    function test_RevertWhen_AboveUserBound() public {
        // On day 0, nobody may be owed more than MAX_PER_DAY, even with a valid proof.
        _set3(MAX_PER_DAY + 1, 30e18, 12e18);
        _postAndActivate(0);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                MiningDistributor.ClaimRejected.selector, MiningDistributor.SkipReason.AboveUserBound
            )
        );
        dist.claim(alice, MAX_PER_DAY + 1, p);
    }

    function test_PayoutsNeverExceedDeclaredTotal() public {
        // A buggy or malicious root whose leaves add up to more than its declared total.
        _set3(30e18, 30e18, 30e18);
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        dist.proposeRoot(0, root, 50e18, bytes32(0), "");
        vm.warp(block.timestamp + DELAY);
        dist.claim(alice, 30e18, _proof(0));
        bytes32[] memory p = _proof(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                MiningDistributor.ClaimRejected.selector, MiningDistributor.SkipReason.AboveTotalEntitled
            )
        );
        dist.claim(bob, 30e18, p);
        assertEq(dist.totalClaimed(), 30e18);
    }

    function test_PauseStopsClaimsAndOnlyAdminUnpauses() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        vm.prank(guardian);
        dist.pause();
        bytes32[] memory p = _proof(0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dist.claim(alice, 24e18, p);
        bytes32 adminRole = dist.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole
            )
        );
        vm.prank(guardian);
        dist.unpause();
        vm.prank(admin);
        dist.unpause();
        dist.claim(alice, 24e18, p);
    }

    function test_ClaimManySkipsBadEntries() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        dist.claim(carol, 12e18, _proof(2)); // carol already claimed

        address[] memory a = new address[](4);
        uint256[] memory m = new uint256[](4);
        bytes32[][] memory p = new bytes32[][](4);
        (a[0], m[0], p[0]) = (alice, 24e18, _proof(0));
        (a[1], m[1], p[1]) = (bob, 99e18, _proof(1)); // wrong amount
        (a[2], m[2], p[2]) = (carol, 12e18, _proof(2)); // nothing left
        (a[3], m[3], p[3]) = (bob, 30e18, _proof(1));

        vm.prank(relayer);
        uint256 paid = dist.claimMany(a, m, p);
        assertEq(paid, 54e18);
        assertEq(_balanceOf(alice), 24e18);
        assertEq(_balanceOf(bob), 30e18);
        assertEq(_balanceOf(carol), 12e18);
    }

    function test_ClaimManyLengthMismatch() public {
        address[] memory a = new address[](2);
        uint256[] memory m = new uint256[](1);
        bytes32[][] memory p = new bytes32[][](2);
        vm.expectRevert(MiningDistributor.LengthMismatch.selector);
        dist.claimMany(a, m, p);
    }

    function test_RevertWhen_IncreaseTooLarge() public {
        vm.prank(admin);
        dist.setMaxDailyIncrease(50e18);
        _set3(24e18, 30e18, 12e18); // 66 > 50 allowed for one day
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MiningDistributor.IncreaseTooLarge.selector, 66e18, 50e18));
        dist.proposeRoot(0, root, 66e18, bytes32(0), "");
        // Two days of allowance covers it.
        vm.prank(publisher);
        dist.proposeRoot(1, root, 66e18, bytes32(0), "");
    }

    function test_IncreaseCapCountsDaysSinceActiveRoot() public {
        vm.prank(admin);
        dist.setMaxDailyIncrease(70e18);
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        _set3(100e18, 60e18, 40e18); // +134 over 66
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MiningDistributor.IncreaseTooLarge.selector, 134e18, 70e18));
        dist.proposeRoot(1, root, 200e18, bytes32(0), "");
        vm.prank(publisher);
        dist.proposeRoot(2, root, 200e18, bytes32(0), ""); // two days since day 0
    }

    function test_DecreaseAlwaysAllowedByIncreaseCap() public {
        vm.prank(admin);
        dist.setMaxDailyIncrease(70e18);
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        _set3(0, 30e18, 12e18);
        _postAndActivate(1);
        assertEq(dist.activeRoot().totalEntitled, 42e18);
    }

    function test_PauseFreezesMaturitySoGuardianCanVeto() public {
        _set3(24e18, 30e18, 12e18);
        _post(0);
        vm.prank(guardian);
        dist.pause();
        vm.warp(block.timestamp + 5 days);
        // Nothing matures while paused: no active root, and the vault releases nothing.
        assertEq(dist.activeRoot().root, bytes32(0));
        assertEq(vault.releasable(), 0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dist.promote();
        vm.prank(guardian);
        dist.vetoPendingRoot();
        vm.prank(admin);
        dist.unpause();
        assertEq(dist.activeRoot().root, bytes32(0));
    }

    function test_PendingRootMaturesRightAfterUnpause() public {
        _set3(24e18, 30e18, 12e18);
        bytes32 root = _post(0);
        vm.prank(guardian);
        dist.pause();
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(admin);
        dist.unpause();
        assertEq(dist.activeRoot().root, root);
    }

    function test_VetoWithoutPendingReverts() public {
        vm.prank(guardian);
        vm.expectRevert(MiningDistributor.NoPendingRoot.selector);
        dist.vetoPendingRoot();
    }

    function test_ConstructorRejectsBadArguments() public {
        address a = dist.asset();
        vm.expectRevert(MiningDistributor.ZeroAddress.selector);
        new MiningDistributor(a, EmissionSchedule(address(0)), 1, DELAY, 1, admin, publisher, guardian);
        vm.expectRevert(MiningDistributor.ZeroAddress.selector);
        new MiningDistributor(a, schedule, 1, DELAY, 1, address(0), publisher, guardian);
        vm.expectRevert(MiningDistributor.ZeroAddress.selector);
        new MiningDistributor(a, schedule, 1, DELAY, 1, admin, address(0), guardian);
        vm.expectRevert(MiningDistributor.ZeroAddress.selector);
        new MiningDistributor(a, schedule, 1, DELAY, 1, admin, publisher, address(0));
        vm.expectRevert(MiningDistributor.ZeroBound.selector);
        new MiningDistributor(a, schedule, 0, DELAY, 1, admin, publisher, guardian);
        vm.expectRevert(MiningDistributor.InvalidDelay.selector);
        new MiningDistributor(a, schedule, 1, 1, 1, admin, publisher, guardian);
        vm.expectRevert(MiningDistributor.InvalidIncrease.selector);
        new MiningDistributor(a, schedule, 1, DELAY, 0, admin, publisher, guardian);
        vm.expectRevert(MiningDistributor.InvalidIncrease.selector);
        new MiningDistributor(
            a, schedule, 1, DELAY, uint256(type(uint128).max) + 1, admin, publisher, guardian
        );
    }

    function test_AdminSetterValidation() public {
        vm.startPrank(admin);
        vm.expectRevert(MiningDistributor.ZeroAddress.selector);
        dist.setVault(MiningVault(payable(address(0))));
        vm.expectRevert(MiningDistributor.InvalidIncrease.selector);
        dist.setMaxDailyIncrease(0);
        vm.expectRevert(MiningVault.ZeroAddress.selector);
        vault.setDistributor(address(0));
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert();
        dist.setMaxDailyIncrease(1);
    }

    function test_VaultReleasesNothingBeforeStartOrWithoutDistributor() public {
        MiningVault fresh = new MiningVault(dist.asset(), schedule, admin);
        assertEq(fresh.releasable(), 0);
        EmissionSchedule later = new EmissionSchedule(START + 100 days, DAILY, 30, 0, POOL);
        MiningVault early = new MiningVault(dist.asset(), later, admin);
        vm.prank(admin);
        early.setDistributor(address(dist));
        assertEq(early.releasable(), 0);
        address a = dist.asset();
        vm.expectRevert(MiningVault.ZeroAddress.selector);
        new MiningVault(a, EmissionSchedule(address(0)), admin);
        vm.expectRevert(MiningVault.ZeroAddress.selector);
        new MiningVault(a, schedule, address(0));
    }

    function test_VaultReleasesOnlyWhatItHolds() public {
        // A vault holding less than the entitlement sends what it has, and the claim then fails.
        MiningVault small = new MiningVault(dist.asset(), schedule, admin);
        MiningDistributor d2 = new MiningDistributor(
            dist.asset(), schedule, MAX_PER_DAY, DELAY, 2 * DAILY, admin, publisher, guardian
        );
        vm.startPrank(admin);
        small.setDistributor(address(d2));
        d2.setVault(small);
        vm.stopPrank();
        _fund(address(small), 10e18);
        delete accts;
        delete amts;
        accts.push(alice);
        amts.push(24e18);
        bytes32 root = Merkle.root(_leavesFor(d2));
        vm.prank(publisher);
        d2.proposeRoot(0, root, 24e18, bytes32(0), "");
        vm.warp(block.timestamp + DELAY);
        assertEq(small.releasable(), 10e18);
        bytes32[] memory p = new bytes32[](0);
        vm.expectRevert();
        d2.claim(alice, 24e18, p);
    }

    function _leavesFor(MiningDistributor d) internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](accts.length);
        for (uint256 i; i < accts.length; ++i) {
            leaves[i] = d.leaf(accts[i], amts[i]);
        }
    }

    function test_VaultFundsOnlyWhatIsEntitled() public {
        _set3(24e18, 30e18, 12e18);
        _postAndActivate(0);
        assertEq(vault.releasable(), 66e18);
        dist.claim(alice, 24e18, _proof(0));
        // The first claim pulled the whole entitlement; the float equals what is still owed.
        assertEq(vault.released(), 66e18);
        assertEq(_balanceOf(address(dist)), 42e18);
        assertEq(vault.releasable(), 0);
        assertEq(vault.release(), 0);
    }

    function test_VaultNeverExceedsSchedule() public {
        // A distributor that lies about its entitlement still cannot pull more than the schedule.
        LyingDistributor liar = new LyingDistributor();
        vm.prank(admin);
        vault.setDistributor(address(liar));
        uint256 expected = schedule.cumulativeBudget(schedule.currentDay());
        assertEq(vault.releasable(), expected);
        vault.release();
        assertEq(vault.released(), expected);
        assertEq(vault.release(), 0);
    }

    function test_OnlyAdminSetsVaultDistributorAndDelay() public {
        vm.startPrank(alice);
        vm.expectRevert();
        vault.setDistributor(alice);
        vm.expectRevert();
        dist.setVault(MiningVault(payable(alice)));
        vm.expectRevert();
        dist.setChallengeDelay(2 hours);
        vm.stopPrank();
        vm.startPrank(admin);
        vm.expectRevert(MiningDistributor.InvalidDelay.selector);
        dist.setChallengeDelay(59 minutes);
        vm.expectRevert(MiningDistributor.InvalidDelay.selector);
        dist.setChallengeDelay(7 days + 1);
        dist.setChallengeDelay(2 hours);
        vm.stopPrank();
        assertEq(dist.challengeDelay(), 2 hours);
    }

    /// Any set of entitlements within the per-user bound pays each user exactly their amount.
    function testFuzz_ClaimsPayExactAmounts(uint96 a, uint96 b, uint96 c, uint8 dayRaw) public {
        uint64 day = uint64(bound(dayRaw, 0, 9));
        uint256 cap = MAX_PER_DAY * (uint256(day) + 1);
        _set3(bound(a, 1, cap), bound(b, 1, cap), bound(c, 1, cap));
        _postAndActivate(day);
        for (uint256 i; i < 3; ++i) {
            dist.claim(accts[i], amts[i], _proof(i));
            assertEq(_balanceOf(accts[i]), amts[i]);
        }
        assertEq(dist.totalClaimed(), _sum());
        assertEq(vault.released(), _sum());
        assertEq(_balanceOf(address(dist)), 0);
    }
}

contract LyingDistributor {
    function activeTotalEntitled() external pure returns (uint256) {
        return type(uint256).max;
    }

    receive() external payable {}
}

contract MiningDistributorNativeTest is MiningDistributorTestBase {
    function _asset() internal pure override returns (address) {
        return address(0);
    }

    function _fund(address to, uint256 amount) internal override {
        vm.deal(to, amount);
    }

    function _balanceOf(address who) internal view override returns (uint256) {
        return who.balance;
    }

    function test_RevertWhen_RecipientRejectsNative() public {
        Rejecter r = new Rejecter();
        delete accts;
        delete amts;
        accts.push(address(r));
        amts.push(10e18);
        accts.push(alice);
        amts.push(10e18);
        _postAndActivate(0);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(
            abi.encodeWithSelector(AssetTransfer.NativeTransferFailed.selector, address(r), 10e18)
        );
        dist.claim(address(r), 10e18, p);
        // The failed claim changed nothing.
        assertEq(dist.claimed(address(r)), 0);
        assertEq(dist.totalClaimed(), 0);
    }

    function test_RejectsNativeWhenErc20() public view {
        assertEq(dist.asset(), address(0));
    }
}

contract Rejecter {}

contract MiningDistributorErc20Test is MiningDistributorTestBase {
    LongToken token;

    function _asset() internal override returns (address) {
        token = new LongToken("LONGYU Testnet Token", "tLONG", 2 * POOL, address(this));
        return address(token);
    }

    function _fund(address to, uint256 amount) internal override {
        token.transfer(to, amount);
    }

    function _balanceOf(address who) internal view override returns (uint256) {
        return token.balanceOf(who);
    }

    function test_RevertWhen_NativeSentToErc20Contracts() public {
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        (bool ok,) = address(dist).call{value: 1}("");
        assertFalse(ok);
        (ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
        vm.stopPrank();
    }
}
