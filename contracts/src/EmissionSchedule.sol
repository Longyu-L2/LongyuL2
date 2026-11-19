// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title EmissionSchedule
/// @notice The published mining budget: how much may be emitted on each day and in total.
/// @dev Day 0 starts at `startTime`, which must be a UTC midnight. The daily budget starts at
///      `initialDailyBudget` and is cut by `decayBps` at the start of every `periodDays` block of
///      days, using integer maths that the off-chain reward engine reproduces exactly. All
///      parameters are immutable: changing the schedule means deploying a new one, announced in
///      advance. The cumulative budget never exceeds `totalCap`, the size of the mining pool.
contract EmissionSchedule {
    uint256 public constant BPS = 10_000;
    /// @dev Decay stops after this many periods. With any real decay the budget is ~0 long before.
    uint256 public constant MAX_PERIODS = 2_000;

    uint256 public immutable startTime;
    uint256 public immutable initialDailyBudget;
    uint256 public immutable periodDays;
    uint256 public immutable decayBps;
    uint256 public immutable totalCap;

    error InvalidParameters();
    error BeforeStart();

    constructor(
        uint256 startTime_,
        uint256 initialDailyBudget_,
        uint256 periodDays_,
        uint256 decayBps_,
        uint256 totalCap_
    ) {
        if (
            startTime_ % 1 days != 0 || initialDailyBudget_ == 0 || periodDays_ == 0 || periodDays_ > 3650
                || decayBps_ >= BPS || totalCap_ == 0
        ) revert InvalidParameters();
        startTime = startTime_;
        initialDailyBudget = initialDailyBudget_;
        periodDays = periodDays_;
        decayBps = decayBps_;
        totalCap = totalCap_;
    }

    /// @notice Index of the current UTC day since the start. Reverts before the start.
    function currentDay() public view returns (uint256) {
        if (block.timestamp < startTime) revert BeforeStart();
        return (block.timestamp - startTime) / 1 days;
    }

    /// @notice True once day 0 has begun.
    function started() public view returns (bool) {
        return block.timestamp >= startTime;
    }

    /// @notice Budget of a single day, ignoring the total cap.
    function dailyBudget(uint256 day) public view returns (uint256 budget) {
        budget = initialDailyBudget;
        if (decayBps == 0) return budget;
        uint256 periods = day / periodDays;
        if (periods > MAX_PERIODS) periods = MAX_PERIODS;
        uint256 keep = BPS - decayBps;
        for (uint256 i; i < periods && budget != 0; ++i) {
            budget = budget * keep / BPS;
        }
    }

    /// @notice Sum of the daily budgets of days 0 to `day` inclusive, capped at `totalCap`.
    function cumulativeBudget(uint256 day) public view returns (uint256 sum) {
        uint256 cap = totalCap;
        uint256 numDays = day + 1;
        uint256 budget = initialDailyBudget;
        if (decayBps == 0) {
            if (numDays > cap / budget) return cap; // avoids overflow for very large days
            sum = budget * numDays;
            return sum > cap ? cap : sum;
        }
        uint256 full = numDays / periodDays;
        uint256 rem = numDays % periodDays;
        uint256 keep = BPS - decayBps;
        uint256 loops = full < MAX_PERIODS ? full : MAX_PERIODS;
        for (uint256 i; i < loops; ++i) {
            sum += budget * periodDays;
            if (sum >= cap) return cap;
            budget = budget * keep / BPS;
        }
        if (full > MAX_PERIODS) {
            // Every period after MAX_PERIODS keeps the last budget, matching dailyBudget().
            uint256 extraDays = (full - MAX_PERIODS) * periodDays;
            if (budget != 0 && extraDays > (cap - sum) / budget) return cap;
            sum += extraDays * budget;
        }
        sum += rem * budget;
        return sum > cap ? cap : sum;
    }
}
