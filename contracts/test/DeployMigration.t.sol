// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMigration} from "../script/DeployMigration.s.sol";
import {MigrationDistributor} from "../src/MigrationDistributor.sol";

contract DeployMigrationTest is Test {
    function test_DeploysWithTheProposedSchedule() public {
        vm.warp(1_900_000_000);
        DeployMigration script = new DeployMigration();
        address admin = makeAddr("admin");
        address guardian = makeAddr("guardian");
        address pool = makeAddr("pool");
        uint64 start = uint64(block.timestamp + 30 days);
        MigrationDistributor d =
            script.deploy(address(0), admin, guardian, start, 360 days, 720 days, 2_500, pool);
        assertEq(d.claimStart(), start);
        assertEq(d.vestingDuration(), 360 days);
        assertEq(d.claimEnd(), start + 720 days);
        assertEq(d.tgeBps(), 2_500);
        assertTrue(d.hasRole(d.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(d.hasRole(d.GUARDIAN_ROLE(), guardian));
        assertEq(d.unclaimedRecipient(), pool);
        vm.expectRevert(bytes("claim window must be longer than vesting"));
        script.deploy(address(0), admin, guardian, start, 360 days, 300 days, 2_500, pool);
    }

    function test_WindowMustOutlastVesting() public {
        vm.warp(1_900_000_000);
        DeployMigration script = new DeployMigration();
        address admin = makeAddr("admin");
        address guardian = makeAddr("guardian");
        address pool = makeAddr("pool");
        uint64 start = uint64(block.timestamp + 30 days);
        // A window equal to vesting would close at the very second the last part unlocks.
        vm.expectRevert(bytes("claim window must be longer than vesting"));
        script.deploy(address(0), admin, guardian, start, 360 days, 360 days, 2_500, pool);
        MigrationDistributor d =
            script.deploy(address(0), admin, guardian, start, 360 days, 360 days + 1, 2_500, pool);
        assertEq(d.claimEnd(), start + 360 days + 1);
    }

    function test_ClaimStartInTheFutureWithinTwoYears() public {
        vm.warp(1_900_000_000);
        DeployMigration script = new DeployMigration();
        address admin = makeAddr("admin");
        address guardian = makeAddr("guardian");
        address pool = makeAddr("pool");
        uint256 time = block.timestamp;
        MigrationDistributor d =
            script.deploy(address(0), admin, guardian, time + 1, 360 days, 720 days, 2_500, pool);
        assertEq(d.claimStart(), time + 1);
        d = script.deploy(address(0), admin, guardian, time + 730 days, 360 days, 720 days, 2_500, pool);
        assertEq(d.claimStart(), time + 730 days);

        vm.expectRevert(bytes("claim start must be in the future"));
        script.deploy(address(0), admin, guardian, time, 360 days, 720 days, 2_500, pool);
        vm.expectRevert(bytes("claim start must be within two years"));
        script.deploy(address(0), admin, guardian, time + 730 days + 1, 360 days, 720 days, 2_500, pool);
        // Cut to 64 bits this would be a start 30 days ahead.
        vm.expectRevert(bytes("claim start does not fit 64 bits"));
        script.deploy(
            address(0), admin, guardian, (1 << 64) + time + 30 days, 360 days, 720 days, 2_500, pool
        );
    }

    function test_DurationsAndTgeShareWithinRange() public {
        vm.warp(1_900_000_000);
        DeployMigration script = new DeployMigration();
        address admin = makeAddr("admin");
        address guardian = makeAddr("guardian");
        address pool = makeAddr("pool");
        uint256 start = block.timestamp + 30 days;
        MigrationDistributor d = script.deploy(address(0), admin, guardian, start, 1, 3650 days, 10_000, pool);
        assertEq(d.vestingDuration(), 1);
        assertEq(d.claimEnd(), start + 3650 days);
        assertEq(d.tgeBps(), 10_000);
        assertEq(script.deploy(address(0), admin, guardian, start, 360 days, 720 days, 0, pool).tgeBps(), 0);

        vm.expectRevert(bytes("vesting must not be zero"));
        script.deploy(address(0), admin, guardian, start, 0, 720 days, 2_500, pool);
        vm.expectRevert(bytes("claim window must be ten years at most"));
        script.deploy(address(0), admin, guardian, start, 360 days, 3650 days + 1, 2_500, pool);
        // Cut to 64 bits these would be 720 days and 360 days.
        vm.expectRevert(bytes("claim window must be ten years at most"));
        script.deploy(address(0), admin, guardian, start, 360 days, (1 << 64) + 720 days, 2_500, pool);
        vm.expectRevert(bytes("claim window must be longer than vesting"));
        script.deploy(address(0), admin, guardian, start, (1 << 64) + 360 days, 720 days, 2_500, pool);

        vm.expectRevert(bytes("TGE share must be 10000 bps at most"));
        script.deploy(address(0), admin, guardian, start, 360 days, 720 days, 10_001, pool);
        // Cut to 16 bits this would be 10000.
        vm.expectRevert(bytes("TGE share must be 10000 bps at most"));
        script.deploy(address(0), admin, guardian, start, 360 days, 720 days, 75_536, pool);
    }

    function test_RunTakesTgeBpsUncut() public {
        vm.warp(1_900_000_000);
        DeployMigration script = new DeployMigration();
        vm.setEnv("ADMIN", vm.toString(makeAddr("admin")));
        vm.setEnv("GUARDIAN", vm.toString(makeAddr("guardian")));
        vm.setEnv("UNCLAIMED_RECIPIENT", vm.toString(makeAddr("pool")));
        vm.setEnv("CLAIM_START", vm.toString(block.timestamp + 30 days));
        vm.setEnv("TGE_BPS", "75536");
        vm.expectRevert(bytes("TGE share must be 10000 bps at most"));
        script.run();
    }
}
