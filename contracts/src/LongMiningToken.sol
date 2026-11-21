// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EmissionSchedule} from "./EmissionSchedule.sol";

interface IMiningVaultRegistry {
    function wasDistributor(address account) external view returns (bool);
}

/// @title LongMiningToken
/// @notice $LONG on LONGYU mainnet. The supply starts at zero and is created only by mining until the
///         TGE: the mining vault is the only minter, set once, and the token itself refuses to create
///         more than the emission schedule's budget to date or its pool. At the TGE the other
///         allocations are created once, within what the pool leaves of the 10 billion. No more can
///         ever exist.
///         Until the TGE, LONG cannot be moved or approved: miners see what they mined in their
///         wallets, but nobody can trade it, pool it, sell an approval of it or bridge it. Only the
///         mining vault and the distributors it has funded can send it (paying claims). The lock ends
///         when the admin unlocks it, or at `unlockDeadline` at the latest, by itself.
/// @dev The admin is the timelock on LONGYU, so `unlock` is announced on chain before it applies. On
///      BSC, LONG is the bridge's copy of this token, created after the TGE.
contract LongMiningToken is ERC20, ERC20Permit, AccessControl {
    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    uint256 public constant MAX_SUPPLY = 10_000_000_000e18;
    /// The lock may last at most this long from deployment.
    uint256 public constant MAX_LOCK = 3 * 365 days;

    /// The emission schedule: mined LONG never exceeds its budget to date, nor its pool.
    EmissionSchedule public immutable schedule;
    /// The most mining can ever create: the schedule's pool.
    uint256 public immutable miningCap;
    /// The latest moment LONG unlocks, set at deployment.
    uint64 public immutable unlockDeadline;

    /// The mining vault: the only account that can create mined LONG. Set once.
    address public miningMinter;
    uint256 public mined;
    uint256 public allocated;
    bool public unlockedEarly;

    event MiningMinterSet(address indexed minter);
    event Unlocked(uint256 at);

    error ZeroAddress();
    error CapOutOfRange(uint256 miningCap);
    error DeadlineOutOfRange(uint256 deadline);
    error MinterAlreadySet();
    error NotMiningMinter();
    error AboveSchedule(uint256 mined, uint256 budget);
    error AboveMiningCap(uint256 mined, uint256 cap);
    error AboveAllocationCap(uint256 allocated, uint256 cap);
    error Locked();
    error AlreadyUnlocked();

    constructor(address admin, EmissionSchedule schedule_, uint64 unlockDeadline_)
        ERC20("LONGYU", "LONG")
        ERC20Permit("LONGYU")
    {
        if (admin == address(0) || address(schedule_) == address(0)) revert ZeroAddress();
        uint256 cap = schedule_.totalCap();
        if (cap == 0 || cap > MAX_SUPPLY) revert CapOutOfRange(cap);
        if (unlockDeadline_ <= block.timestamp || unlockDeadline_ > block.timestamp + MAX_LOCK) {
            revert DeadlineOutOfRange(unlockDeadline_);
        }
        schedule = schedule_;
        miningCap = cap;
        unlockDeadline = unlockDeadline_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ minting

    /// @notice Creates mined LONG. Only the mining vault, never beyond the schedule's budget to date.
    function mintMined(address to, uint256 amount) external {
        if (msg.sender != miningMinter) revert NotMiningMinter();
        uint256 total = mined + amount;
        if (total > miningCap) revert AboveMiningCap(total, miningCap);
        uint256 budget = schedule.started() ? schedule.cumulativeBudget(schedule.currentDay()) : 0;
        if (total > budget) revert AboveSchedule(total, budget);
        mined = total;
        _mint(to, amount);
    }

    /// @notice Creates the allocations decided at the TGE (team, liquidity and the others), once LONG is
    ///         unlocked, within what the mining pool leaves of the 10 billion.
    function mintAllocation(address to, uint256 amount) external onlyRole(ALLOCATOR_ROLE) {
        if (!isUnlocked()) revert Locked();
        uint256 total = allocated + amount;
        uint256 cap = MAX_SUPPLY - miningCap;
        if (total > cap) revert AboveAllocationCap(total, cap);
        allocated = total;
        _mint(to, amount);
    }

    // ------------------------------------------------------------------ the lock

    function isUnlocked() public view returns (bool) {
        return unlockedEarly || block.timestamp >= unlockDeadline;
    }

    /// @notice The mining vault and every distributor it has funded: the only senders while locked.
    function isMiningContract(address account) public view returns (bool) {
        address v = miningMinter;
        return v != address(0) && (account == v || IMiningVaultRegistry(v).wasDistributor(account));
    }

    /// @notice Ends the lock now: the TGE. It cannot be locked again.
    function unlock() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isUnlocked()) revert AlreadyUnlocked();
        unlockedEarly = true;
        emit Unlocked(block.timestamp);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Creating is checked in the mint functions; moving waits for the TGE, except from the mining contracts.
        if (from != address(0) && !isUnlocked() && !isMiningContract(from)) revert Locked();
        super._update(from, to, value);
    }

    /// Approvals (and permits) wait for the TGE too, so no claim on locked LONG can be sold in advance.
    function _approve(address owner, address spender, uint256 value, bool emitEvent) internal override {
        if (!isUnlocked() && !isMiningContract(owner)) revert Locked();
        super._approve(owner, spender, value, emitEvent);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Names the mining vault, once.
    function setMiningMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (minter == address(0)) revert ZeroAddress();
        if (miningMinter != address(0)) revert MinterAlreadySet();
        miningMinter = minter;
        emit MiningMinterSet(minter);
    }
}
