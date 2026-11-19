// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AllocateLong} from "../script/AllocateLong.s.sol";

contract AllocateLongTest is Test {
    uint64 constant TGE = 1_900_000_000;
    uint64 constant MONTH = 30 days;

    AllocateLong script;
    AllocateLong.Recipients r;
    AllocateLong.Allocation a;

    function setUp() public {
        vm.chainId(56);
        vm.warp(TGE - 1 days);
        script = new AllocateLong();
        r = AllocateLong.Recipients({
            miningReserve: makeAddr("miningReserve"),
            migrationOps: makeAddr("migrationOps"),
            ecosystem: makeAddr("ecosystem"),
            team: makeAddr("team"),
            treasury: makeAddr("treasury"),
            backers: makeAddr("backers"),
            network: makeAddr("network"),
            liquidity: makeAddr("liquidity")
        });
        a = script.allocate(r, TGE, address(script));
    }

    function test_SupplyIsFixedAndFullyAllocated() public view {
        assertEq(a.token.totalSupply(), 10_000_000_000e18);
        assertEq(a.token.balanceOf(address(script)), 0);
        assertEq(a.token.balanceOf(r.migrationOps), 500_000_000e18);
        assertEq(a.token.balanceOf(r.miningReserve), 3_500_000_000e18);
        assertEq(a.token.balanceOf(r.ecosystem), 100_000_000e18);
        assertEq(a.token.balanceOf(r.liquidity), 200_000_000e18);
        assertEq(a.token.balanceOf(address(a.teamVesting)), 1_500_000_000e18);
        assertEq(a.token.balanceOf(address(a.treasuryVesting)), 1_200_000_000e18);
        assertEq(a.token.balanceOf(address(a.backersVesting)), 800_000_000e18);
        assertEq(a.token.balanceOf(address(a.networkVesting)), 500_000_000e18);
        assertEq(a.token.balanceOf(address(a.ecosystemVesting)), 1_400_000_000e18);
        assertEq(a.token.balanceOf(address(a.liquidityVesting)), 300_000_000e18);
    }

    function test_UnlockedAtLaunchMatchesModel() public view {
        // 125M of migration is vested inside the MigrationDistributor, not here; liquid at TGE from
        // this script: ecosystem 100M + liquidity 200M (mining buckets are released over time).
        address token = address(a.token);
        assertEq(a.teamVesting.vestedAmount(token, TGE), 0);
        assertEq(a.backersVesting.vestedAmount(token, TGE), 0);
        assertEq(a.treasuryVesting.vestedAmount(token, TGE), 0);
        assertEq(a.ecosystemVesting.vestedAmount(token, TGE), 0);
    }

    function test_TeamCliffThenLinear() public view {
        address token = address(a.token);
        assertEq(a.teamVesting.vestedAmount(token, TGE + 12 * MONTH - 1), 0);
        assertEq(a.teamVesting.vestedAmount(token, TGE + 12 * MONTH + 18 * MONTH), 750_000_000e18);
        assertEq(a.teamVesting.vestedAmount(token, TGE + 48 * MONTH), 1_500_000_000e18);
    }

    function test_BackersAndNetworkSchedules() public view {
        address token = address(a.token);
        assertEq(a.backersVesting.vestedAmount(token, TGE + 24 * MONTH), 400_000_000e18);
        assertEq(a.networkVesting.vestedAmount(token, TGE + 24 * MONTH), 0);
        assertEq(a.networkVesting.vestedAmount(token, TGE + 84 * MONTH), 500_000_000e18);
    }

    function test_BeneficiaryReleases() public {
        vm.warp(TGE + 24 * MONTH);
        a.liquidityVesting.release(address(a.token));
        assertEq(a.token.balanceOf(r.liquidity), 500_000_000e18);
    }

    function test_RefusesAnyChainButBnbSmartChain() public {
        uint256[3] memory others = [uint256(97), 668801, 31337];
        for (uint256 i = 0; i < others.length; i++) {
            vm.chainId(others[i]);
            vm.expectRevert(bytes("not BNB Smart Chain"));
            script.allocate(r, TGE, address(script));
        }
    }

    function test_TgeTimeFromADayAgoToTwoYearsAhead() public {
        uint256 time = block.timestamp;
        AllocateLong.Allocation memory b = script.allocate(r, time - 1 days, address(script));
        assertEq(b.liquidityVesting.start(), time - 1 days);
        b = script.allocate(r, time + 730 days, address(script));
        assertEq(b.teamVesting.start(), time + 730 days + 12 * MONTH);
    }

    function test_RefusesATgeTimeOutOfRange() public {
        uint256 time = block.timestamp;
        vm.expectRevert(bytes("TGE time more than a day ago"));
        script.allocate(r, time - 1 days - 1, address(script));
        vm.expectRevert(bytes("TGE time more than a day ago"));
        script.allocate(r, 0, address(script));
        vm.expectRevert(bytes("TGE time more than two years ahead"));
        script.allocate(r, time + 730 days + 1, address(script));
        // Cut to 64 bits this would be the launch time itself.
        vm.expectRevert(bytes("TGE time does not fit 64 bits"));
        script.allocate(r, (1 << 64) + uint256(TGE), address(script));
    }

    function test_RunTakesTgeTimeUncut() public {
        vm.setEnv("MINING_RESERVE", vm.toString(r.miningReserve));
        vm.setEnv("MIGRATION_OPS", vm.toString(r.migrationOps));
        vm.setEnv("ECOSYSTEM", vm.toString(r.ecosystem));
        vm.setEnv("TEAM", vm.toString(r.team));
        vm.setEnv("TREASURY", vm.toString(r.treasury));
        vm.setEnv("BACKERS", vm.toString(r.backers));
        vm.setEnv("NETWORK", vm.toString(r.network));
        vm.setEnv("LIQUIDITY", vm.toString(r.liquidity));
        vm.setEnv("TGE_TIME", vm.toString((1 << 64) + uint256(TGE)));
        vm.expectRevert(bytes("TGE time does not fit 64 bits"));
        script.run();
    }

    function test_RunRefusesForgesDefaultSender() public {
        // What msg.sender is when a hardware wallet signs and --sender is not given.
        vm.expectRevert(bytes("sender required"));
        vm.prank(DEFAULT_SENDER);
        script.run();
    }
}
