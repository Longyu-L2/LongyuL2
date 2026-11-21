// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EmissionSchedule} from "./EmissionSchedule.sol";
import {IMiningDistributor} from "./interfaces/IMiningDistributor.sol";
import {IMiningVault} from "./interfaces/IMiningVault.sol";
import {AssetTransfer} from "./libraries/AssetTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MiningVault
/// @notice Holds the mining pool and funds the distributor only as rewards become claimable.
/// @dev The distributor's float is limited to "entitled but not yet claimed". The vault never
///      releases more than the schedule's cumulative budget to date, even if the distributor
///      reports a larger entitlement. Anyone may call `release`.
///      The admin (a timelock) can point the vault at a new distributor, and can take back only the
///      part of the pool beyond every daily budget to date (`withdrawUnscheduled`): what no miner
///      can have earned yet, so funding the vault never locks tokens in it for good. Both powers are
///      listed in the public admin inventory.
contract MiningVault is IMiningVault, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable asset;
    EmissionSchedule public immutable schedule;

    address public distributor;
    /// Sent to distributors and not given back.
    uint256 public released;
    mapping(address account => bool) public wasDistributor;

    event DistributorSet(address indexed previous, address indexed current);
    event Released(address indexed distributor, uint256 amount, uint256 totalReleased);
    event Withdrawn(address indexed to, uint256 amount);
    event TakenBack(address indexed distributor, uint256 amount);

    error ZeroAddress();
    error NativeNotAccepted();
    error AboveUnscheduled(uint256 amount, uint256 available);
    error NotARetiredDistributor();

    constructor(address asset_, EmissionSchedule schedule_, address admin) {
        if (address(schedule_) == address(0) || admin == address(0)) revert ZeroAddress();
        asset = asset_;
        schedule = schedule_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    receive() external payable {
        if (asset != address(0)) revert NativeNotAccepted();
    }

    function setDistributor(address distributor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (distributor_ == address(0)) revert ZeroAddress();
        emit DistributorSet(distributor, distributor_);
        distributor = distributor_;
        wasDistributor[distributor_] = true;
    }

    /// @notice A replaced distributor gives back what it holds. It counts as never released, so the
    ///         distributor that replaced it receives it again as its claims need it.
    function takeBack(uint256 amount) external nonReentrant {
        if (asset == address(0)) revert NativeNotAccepted();
        if (!wasDistributor[msg.sender] || msg.sender == distributor) revert NotARetiredDistributor();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        released = amount > released ? 0 : released - amount;
        emit TakenBack(msg.sender, amount);
    }

    /// @notice Amount the vault would send to the distributor right now.
    function releasable() public view returns (uint256) {
        address d = distributor;
        if (d == address(0) || !schedule.started()) return 0;
        uint256 allowed = IMiningDistributor(d).activeTotalEntitled();
        uint256 scheduled = schedule.cumulativeBudget(schedule.currentDay());
        if (allowed > scheduled) allowed = scheduled;
        if (allowed <= released) return 0;
        uint256 amount = allowed - released;
        uint256 balance = AssetTransfer.balanceOf(asset, address(this));
        return amount > balance ? balance : amount;
    }

    /// @notice What the admin may take back now: the balance beyond every daily budget to date that
    ///         has not been released yet. Today's budget counts as owed, so nothing a miner can have
    ///         earned, in a root or not yet settled, is ever available.
    function unscheduled() public view returns (uint256) {
        uint256 owed = schedule.started() ? schedule.cumulativeBudget(schedule.currentDay()) : 0;
        owed = owed > released ? owed - released : 0;
        uint256 balance = AssetTransfer.balanceOf(asset, address(this));
        return balance > owed ? balance - owed : 0;
    }

    /// @notice Sends part of the unscheduled pool back, for example to the treasury. Admin only (a
    ///         timelock, so the withdrawal is announced on chain before it can run).
    function withdrawUnscheduled(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = unscheduled();
        if (amount > available) revert AboveUnscheduled(amount, available);
        emit Withdrawn(to, amount);
        AssetTransfer.send(asset, to, amount);
    }

    /// @notice Sends the releasable amount to the distributor. Callable by anyone.
    function release() external nonReentrant returns (uint256 amount) {
        amount = releasable();
        if (amount == 0) return 0;
        released += amount;
        address d = distributor;
        emit Released(d, amount, released);
        AssetTransfer.send(asset, d, amount);
    }
}
