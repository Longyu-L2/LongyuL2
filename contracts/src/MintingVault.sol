// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EmissionSchedule} from "./EmissionSchedule.sol";
import {IMiningDistributor} from "./interfaces/IMiningDistributor.sol";
import {IMiningVault} from "./interfaces/IMiningVault.sol";

interface IMintedLong {
    function mintMined(address to, uint256 amount) external;
}

/// @title MintingVault
/// @notice The mining vault of LONGYU mainnet: it holds no pool. As rewards become claimable it creates
///         them (LongMiningToken.mintMined) and sends them to the distributor, never more than the
///         distributor's claimable total and never more than the emission schedule's budget to date.
///         So every LONG in existence before the TGE was mined.
/// @dev Anyone may call `release`. A distributor that has been replaced gives back what it still holds
///      (`takeBack`); that is sent on again before anything new is created. The admin (a timelock) can
///      point the vault at a new distributor.
contract MintingVault is IMiningVault, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable asset;
    EmissionSchedule public immutable schedule;

    address public distributor;
    /// Sent to distributors and not given back.
    uint256 public released;
    mapping(address account => bool) public wasDistributor;

    event DistributorSet(address indexed previous, address indexed current);
    event Released(address indexed distributor, uint256 amount, uint256 created, uint256 totalReleased);
    event TakenBack(address indexed distributor, uint256 amount);

    error ZeroAddress();
    error NotARetiredDistributor();

    constructor(address asset_, EmissionSchedule schedule_, address admin) {
        if (asset_ == address(0) || address(schedule_) == address(0) || admin == address(0)) revert ZeroAddress();
        asset = asset_;
        schedule = schedule_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setDistributor(address distributor_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (distributor_ == address(0)) revert ZeroAddress();
        emit DistributorSet(distributor, distributor_);
        distributor = distributor_;
        wasDistributor[distributor_] = true;
    }

    /// @notice Amount the vault would send to the distributor right now.
    function releasable() public view returns (uint256) {
        address d = distributor;
        if (d == address(0) || !schedule.started()) return 0;
        uint256 allowed = IMiningDistributor(d).activeTotalEntitled();
        uint256 scheduled = schedule.cumulativeBudget(schedule.currentDay());
        if (allowed > scheduled) allowed = scheduled;
        return allowed > released ? allowed - released : 0;
    }

    /// @notice Sends the releasable amount to the distributor: first what it holds (given back by a
    ///         replaced distributor), then newly created LONG. Callable by anyone.
    function release() external nonReentrant returns (uint256 amount) {
        amount = releasable();
        if (amount == 0) return 0;
        released += amount;
        address d = distributor;
        uint256 held = IERC20(asset).balanceOf(address(this));
        uint256 fromHeld = held < amount ? held : amount;
        uint256 created = amount - fromHeld;
        emit Released(d, amount, created, released);
        if (fromHeld > 0) IERC20(asset).safeTransfer(d, fromHeld);
        if (created > 0) IMintedLong(asset).mintMined(d, created);
    }

    /// @notice A replaced distributor gives back what it holds. It counts as never released, so the
    ///         distributor that replaced it receives it again as its claims need it.
    function takeBack(uint256 amount) external nonReentrant {
        if (!wasDistributor[msg.sender] || msg.sender == distributor) revert NotARetiredDistributor();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        released = amount > released ? 0 : released - amount;
        emit TakenBack(msg.sender, amount);
    }
}
