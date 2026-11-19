// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";

contract EmissionScheduleTest is Test {
    uint256 constant START = 20_000 days;
    uint256 constant MAINNET_DAILY = 2_139_733e18;
    uint256 constant MAINNET_POOL = 3_500_000_000e18;

    EmissionSchedule flat;
    EmissionSchedule decaying;

    function setUp() public {
        flat = new EmissionSchedule(START, 12_000_000e18, 30, 0, 4_000_000_000e18);
        // 30-day steps of 1.82% approximate a 20% yearly decline.
        decaying = new EmissionSchedule(START, MAINNET_DAILY, 30, 182, MAINNET_POOL);
    }

    function test_RejectsBadParameters() public {
        vm.expectRevert(EmissionSchedule.InvalidParameters.selector);
        new EmissionSchedule(START + 1, 1, 30, 0, 1);
        vm.expectRevert(EmissionSchedule.InvalidParameters.selector);
        new EmissionSchedule(START, 0, 30, 0, 1);
        vm.expectRevert(EmissionSchedule.InvalidParameters.selector);
        new EmissionSchedule(START, 1, 0, 0, 1);
        vm.expectRevert(EmissionSchedule.InvalidParameters.selector);
        new EmissionSchedule(START, 1, 30, 10_000, 1);
        vm.expectRevert(EmissionSchedule.InvalidParameters.selector);
        new EmissionSchedule(START, 1, 30, 0, 0);
    }

    function test_CurrentDay() public {
        vm.warp(START - 1);
        assertFalse(flat.started());
        vm.expectRevert(EmissionSchedule.BeforeStart.selector);
        flat.currentDay();
        vm.warp(START);
        assertEq(flat.currentDay(), 0);
        vm.warp(START + 1 days - 1);
        assertEq(flat.currentDay(), 0);
        vm.warp(START + 1 days);
        assertEq(flat.currentDay(), 1);
    }

    function test_FlatBudget() public view {
        assertEq(flat.dailyBudget(0), 12_000_000e18);
        assertEq(flat.dailyBudget(5000), 12_000_000e18);
        assertEq(flat.cumulativeBudget(0), 12_000_000e18);
        assertEq(flat.cumulativeBudget(9), 120_000_000e18);
    }

    function test_FlatBudgetCapped() public view {
        // 4 billion / 12 million = 333.33 days.
        assertEq(flat.cumulativeBudget(332), 333 * 12_000_000e18);
        assertEq(flat.cumulativeBudget(333), 4_000_000_000e18);
        assertEq(flat.cumulativeBudget(type(uint64).max), 4_000_000_000e18);
    }

    function test_DecayingBudgetSteps() public view {
        assertEq(decaying.dailyBudget(29), MAINNET_DAILY);
        assertEq(decaying.dailyBudget(30), MAINNET_DAILY * 9818 / 10_000);
        uint256 yearOne;
        for (uint256 d; d < 365; ++d) {
            yearOne += decaying.dailyBudget(d);
        }
        // Close to the 700 million modelled for year one.
        assertApproxEqRel(yearOne, 700_000_000e18, 0.03e18);
    }

    function test_DecayingNeverExceedsPool() public view {
        assertLe(decaying.cumulativeBudget(365 * 200), MAINNET_POOL);
    }

    /// Cumulative budget must equal the sum of daily budgets (capped), for any day.
    /// forge-config: default.fuzz.runs = 300
    function testFuzz_CumulativeMatchesDailySum(uint16 dayRaw) public view {
        uint256 day = bound(uint256(dayRaw), 0, 800);
        uint256 sum;
        for (uint256 d; d <= day; ++d) {
            sum += decaying.dailyBudget(d);
        }
        if (sum > MAINNET_POOL) sum = MAINNET_POOL;
        assertEq(decaying.cumulativeBudget(day), sum);
    }

    /// Same check past MAX_PERIODS, using one-day periods so the boundary is reachable.
    function test_CumulativeMatchesPastMaxPeriods() public {
        EmissionSchedule s = new EmissionSchedule(START, 1e30, 1, 1, type(uint256).max);
        uint256 maxP = s.MAX_PERIODS();
        // Independent replica of the integer maths: the budget of day d is the start budget cut
        // min(d, MAX_PERIODS) times by 1 bps, each cut rounded down.
        uint256 budget = 1e30;
        uint256 sum;
        for (uint256 d; d <= maxP + 50; ++d) {
            if (d > 0 && d <= maxP) budget = budget * 9999 / 10_000;
            sum += budget;
            if (d == maxP - 1 || d == maxP || d == maxP + 1 || d == maxP + 50) {
                assertEq(s.dailyBudget(d), budget);
                assertEq(s.cumulativeBudget(d), sum);
            }
        }
    }

    function testFuzz_CumulativeIsMonotonic(uint32 a, uint32 b) public view {
        (uint256 lo, uint256 hi) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        lo = bound(lo, 0, 100_000);
        hi = bound(hi, lo, 100_000);
        assertLe(decaying.cumulativeBudget(lo), decaying.cumulativeBudget(hi));
        assertLe(flat.cumulativeBudget(lo), flat.cumulativeBudget(hi));
    }
}
