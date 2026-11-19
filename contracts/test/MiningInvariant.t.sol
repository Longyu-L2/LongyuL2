// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";
import {MiningVault} from "../src/MiningVault.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";
import {Merkle} from "./utils/Merkle.sol";

/// @dev Drives the distributor through random sequences of roots, forfeitures, claims and time.
contract DistributorHandler is Test {
    uint256 constant N = 5;

    MiningDistributor public dist;
    EmissionSchedule public schedule;
    address public publisher;
    uint256 public maxPerDay;

    address[N] public accounts;
    uint256[N] public entitlement;
    uint64 public nextDay;
    uint256 public rootsPosted;
    uint256 public ghostPaid;

    constructor(MiningDistributor dist_, EmissionSchedule schedule_, address publisher_) {
        dist = dist_;
        schedule = schedule_;
        publisher = publisher_;
        maxPerDay = dist_.maxRewardPerDay();
        for (uint256 i; i < N; ++i) {
            accounts[i] = address(uint160(0xA11CE + i));
        }
    }

    function _leaves() internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](N);
        for (uint256 i; i < N; ++i) {
            leaves[i] = dist.leaf(accounts[i], entitlement[i]);
        }
    }

    /// Posts the next day's root with random increases and occasional forfeitures.
    function postRoot(uint256[N] calldata increments, uint256 forfeitMask) external {
        // Let any waiting root mature, and make sure the next day has closed.
        vm.warp(block.timestamp + dist.challengeDelay());
        while (schedule.currentDay() <= nextDay) {
            vm.warp(block.timestamp + 1 days);
        }
        dist.promote();

        uint256 dayCap = maxPerDay * (uint256(nextDay) + 1);
        uint256 total;
        for (uint256 i; i < N; ++i) {
            uint256 e = entitlement[i] + bound(increments[i], 0, maxPerDay);
            if ((forfeitMask >> i) & 1 == 1) {
                // Forfeiture: the engine freezes the leaf at what was already claimed.
                e = dist.claimed(accounts[i]);
            }
            if (e > dayCap) e = dayCap;
            if (e < dist.claimed(accounts[i])) e = dist.claimed(accounts[i]);
            entitlement[i] = e;
            total += e;
        }
        bytes32 root = Merkle.root(_leaves());
        vm.prank(publisher);
        dist.proposeRoot(nextDay, root, total, bytes32(0), "");
        nextDay++;
        rootsPosted++;
    }

    function activate() external {
        vm.warp(block.timestamp + dist.challengeDelay());
        dist.promote();
    }

    function claim(uint256 who) external {
        uint256 i = bound(who, 0, N - 1);
        if (dist.activeRoot().root == bytes32(0)) return;
        // The proof must match the active root, which may be an older root than the latest posted.
        if (dist.activeRoot().day + 1 != nextDay) return;
        uint256 owed = dist.claimable(accounts[i], entitlement[i]);
        if (owed == 0) return;
        uint256 before = accounts[i].balance;
        dist.claim(accounts[i], entitlement[i], Merkle.proof(_leaves(), i));
        assertEq(accounts[i].balance - before, owed);
        ghostPaid += owed;
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 3 days));
    }

    function sumClaimed() external view returns (uint256 s) {
        for (uint256 i; i < N; ++i) {
            s += dist.claimed(accounts[i]);
        }
    }

    function sumBalances() external view returns (uint256 s) {
        for (uint256 i; i < N; ++i) {
            s += accounts[i].balance;
        }
    }
}

contract MiningInvariantTest is StdInvariant, Test {
    uint256 constant START = 20_000 days;
    uint256 constant POOL = 4_000_000_000e18;

    EmissionSchedule schedule;
    MiningVault vault;
    MiningDistributor dist;
    DistributorHandler handler;

    function setUp() public {
        vm.warp(START + 1 days);
        address admin = makeAddr("admin");
        address publisher = makeAddr("publisher");
        schedule = new EmissionSchedule(START, 12_000_000e18, 30, 0, POOL);
        vault = new MiningVault(address(0), schedule, admin);
        dist = new MiningDistributor(
            address(0), schedule, 43e18, 12 hours, 24_000_000e18, admin, publisher, makeAddr("guardian")
        );
        vm.startPrank(admin);
        vault.setDistributor(address(dist));
        dist.setVault(vault);
        vm.stopPrank();
        vm.deal(address(vault), POOL);
        handler = new DistributorHandler(dist, schedule, publisher);
        targetContract(address(handler));
    }

    /// Bookkeeping: per-account claims add up to the contract's total.
    function invariant_ClaimsAddUp() public view {
        assertEq(handler.sumClaimed(), dist.totalClaimed());
        assertEq(handler.ghostPaid(), dist.totalClaimed());
    }

    /// No value is created or lost: vault + distributor + users always equals the pool.
    function invariant_Conservation() public view {
        assertEq(address(vault).balance + address(dist).balance + handler.sumBalances(), POOL);
        assertEq(vault.released(), dist.totalClaimed() + address(dist).balance);
    }

    /// Payouts never exceed the active root's declared total or the schedule to date.
    function invariant_WithinBudget() public view {
        MiningDistributor.RootData memory r = dist.activeRoot();
        assertLe(dist.totalClaimed(), r.totalEntitled);
        if (r.root != bytes32(0)) {
            assertLe(dist.totalClaimed(), schedule.cumulativeBudget(r.day));
        }
        assertLe(vault.released(), schedule.cumulativeBudget(schedule.currentDay()));
    }

    /// No account is ever paid more than the per-user bound allows.
    function invariant_PerUserBound() public view {
        MiningDistributor.RootData memory r = dist.activeRoot();
        for (uint256 i; i < 5; ++i) {
            assertLe(dist.claimed(handler.accounts(i)), dist.maxRewardPerDay() * (uint256(r.day) + 1));
        }
    }
}
