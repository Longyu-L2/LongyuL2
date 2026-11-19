// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {EmissionSchedule} from "./EmissionSchedule.sol";
import {IMiningDistributor} from "./interfaces/IMiningDistributor.sol";
import {IMiningVault} from "./interfaces/IMiningVault.sol";
import {AssetTransfer} from "./libraries/AssetTransfer.sol";

/// @title MiningDistributor
/// @notice Pays mining rewards from a daily Merkle root of every user's cumulative entitlement.
/// @dev Rules enforced on-chain:
///      - One root per closed UTC day, strictly increasing days, at most one root waiting.
///      - A root becomes claimable only after `challengeDelay`; the guardian can veto it before.
///      - Running budget cap: a root's total entitlement never exceeds the schedule's cumulative
///        budget up to its day. Total payouts never exceed the active root's total entitlement.
///      - Growth cap: a root's total may grow by at most `maxDailyIncrease` per day since the
///        active root, which limits what a stolen publisher key can grab from unused budget.
///      - While paused, no root matures, so the guardian can still veto a waiting root.
///      - Per-user sanity bound: no leaf above `maxRewardPerDay` x (day + 1).
///      - A leaf may shrink (forfeiture), but claims only ever pay `cumulative - claimed`, so
///        nothing already paid is clawed back and nothing is paid twice.
///      - Leaves commit to chain ID and this contract's address, so they cannot be replayed on
///        another chain or contract. Anyone may submit a claim; funds always go to the leaf owner.
contract MiningDistributor is IMiningDistributor, AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    uint256 public constant MIN_CHALLENGE_DELAY = 1 hours;
    uint256 public constant MAX_CHALLENGE_DELAY = 7 days;

    struct RootData {
        bytes32 root;
        uint64 day;
        uint64 postedAt;
        uint256 totalEntitled;
        bytes32 dataHash;
    }

    enum SkipReason {
        None,
        NoActiveRoot,
        InvalidProof,
        AboveUserBound,
        NothingToClaim,
        AboveTotalEntitled
    }

    address public immutable asset;
    EmissionSchedule public immutable schedule;
    uint256 public immutable maxRewardPerDay;

    IMiningVault public vault;
    uint256 public challengeDelay;
    uint256 public maxDailyIncrease;
    uint256 public totalClaimed;
    mapping(address account => uint256 amount) public claimed;

    RootData internal _active;
    RootData internal _pending;

    event RootProposed(
        uint64 indexed day,
        bytes32 root,
        uint256 totalEntitled,
        bytes32 dataHash,
        string dataURI,
        uint256 claimableAt
    );
    event RootActivated(uint64 indexed day, bytes32 root, uint256 totalEntitled);
    event RootVetoed(uint64 indexed day, bytes32 root, address indexed guardian);
    event Claimed(address indexed account, uint256 amount, uint256 cumulativeAmount, uint64 indexed day);
    event ClaimSkipped(address indexed account, uint256 cumulativeAmount, SkipReason reason);
    event VaultSet(address indexed vault);
    event ChallengeDelaySet(uint256 delay);
    event MaxDailyIncreaseSet(uint256 maxDailyIncrease);

    error ZeroAddress();
    error ZeroBound();
    error InvalidRoot();
    error RootPending();
    error NoPendingRoot();
    error RootAlreadyClaimable();
    error DayNotIncreasing(uint64 day, uint64 activeDay);
    error DayNotClosed(uint64 day, uint256 currentDay);
    error BudgetExceeded(uint256 totalEntitled, uint256 cumulativeBudget);
    error TotalBelowClaimed(uint256 totalEntitled, uint256 totalClaimed);
    error IncreaseTooLarge(uint256 increase, uint256 allowed);
    error InvalidDelay();
    error InvalidIncrease();
    error LengthMismatch();
    error NativeNotAccepted();
    error ClaimRejected(SkipReason reason);

    constructor(
        address asset_,
        EmissionSchedule schedule_,
        uint256 maxRewardPerDay_,
        uint256 challengeDelay_,
        uint256 maxDailyIncrease_,
        address admin,
        address publisher,
        address guardian
    ) {
        if (
            address(schedule_) == address(0) || admin == address(0) || publisher == address(0)
                || guardian == address(0)
        ) revert ZeroAddress();
        if (maxRewardPerDay_ == 0) revert ZeroBound();
        if (challengeDelay_ < MIN_CHALLENGE_DELAY || challengeDelay_ > MAX_CHALLENGE_DELAY) {
            revert InvalidDelay();
        }
        if (maxDailyIncrease_ == 0 || maxDailyIncrease_ > type(uint128).max) revert InvalidIncrease();
        asset = asset_;
        schedule = schedule_;
        maxRewardPerDay = maxRewardPerDay_;
        challengeDelay = challengeDelay_;
        maxDailyIncrease = maxDailyIncrease_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PUBLISHER_ROLE, publisher);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    receive() external payable {
        if (asset != address(0)) revert NativeNotAccepted();
    }

    // ------------------------------------------------------------------ roots

    /// @notice Posts the root for a closed UTC day. It becomes claimable after `challengeDelay`.
    function proposeRoot(
        uint64 day,
        bytes32 root,
        uint256 totalEntitled,
        bytes32 dataHash,
        string calldata dataURI
    ) external onlyRole(PUBLISHER_ROLE) whenNotPaused {
        if (root == bytes32(0)) revert InvalidRoot();
        _promoteIfMatured();
        if (_pending.root != bytes32(0)) revert RootPending();
        if (_active.root != bytes32(0) && day <= _active.day) revert DayNotIncreasing(day, _active.day);
        uint256 today = schedule.currentDay();
        if (day >= today) revert DayNotClosed(day, today);
        uint256 budget = schedule.cumulativeBudget(day);
        if (totalEntitled > budget) revert BudgetExceeded(totalEntitled, budget);
        if (totalEntitled < totalClaimed) revert TotalBelowClaimed(totalEntitled, totalClaimed);
        uint256 previous = _active.root == bytes32(0) ? 0 : _active.totalEntitled;
        if (totalEntitled > previous) {
            uint256 elapsed = _active.root == bytes32(0) ? uint256(day) + 1 : uint256(day - _active.day);
            uint256 allowed = maxDailyIncrease * elapsed;
            if (totalEntitled - previous > allowed) {
                revert IncreaseTooLarge(totalEntitled - previous, allowed);
            }
        }

        _pending = RootData({
            root: root,
            day: day,
            postedAt: uint64(block.timestamp),
            totalEntitled: totalEntitled,
            dataHash: dataHash
        });
        emit RootProposed(day, root, totalEntitled, dataHash, dataURI, block.timestamp + challengeDelay);
    }

    /// @notice Guardian veto of a root that is not yet claimable. While the contract is paused no
    ///         root matures, so a waiting root can be vetoed for as long as the pause lasts.
    function vetoPendingRoot() external onlyRole(GUARDIAN_ROLE) {
        RootData memory p = _pending;
        if (p.root == bytes32(0)) revert NoPendingRoot();
        if (_isMatured()) revert RootAlreadyClaimable();
        delete _pending;
        emit RootVetoed(p.day, p.root, msg.sender);
    }

    /// @notice Makes a matured pending root the active one. Anyone may call it.
    function promote() external whenNotPaused {
        _promoteIfMatured();
    }

    /// @notice The root that is claimable right now.
    function activeRoot() public view returns (RootData memory) {
        if (_isMatured()) return _pending;
        return _active;
    }

    /// @notice The root waiting out its challenge delay, if any.
    function pendingRoot() external view returns (RootData memory empty) {
        if (_isMatured()) return empty;
        return _pending;
    }

    function activeTotalEntitled() external view returns (uint256) {
        return activeRoot().totalEntitled;
    }

    // ----------------------------------------------------------------- claims

    /// @notice Pays `account` everything it is owed under the active root. Callable by anyone.
    function claim(address account, uint256 cumulativeAmount, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amount)
    {
        _promoteIfMatured();
        SkipReason reason;
        (reason, amount) = _check(account, cumulativeAmount, proof);
        if (reason != SkipReason.None) revert ClaimRejected(reason);
        _pay(account, cumulativeAmount, amount);
    }

    /// @notice Batch claim for relayers. Entries that cannot be paid are skipped, not reverted.
    function claimMany(address[] calldata accounts, uint256[] calldata amounts, bytes32[][] calldata proofs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 totalPaid)
    {
        if (accounts.length != amounts.length || accounts.length != proofs.length) revert LengthMismatch();
        _promoteIfMatured();
        for (uint256 i; i < accounts.length; ++i) {
            (SkipReason reason, uint256 amount) = _check(accounts[i], amounts[i], proofs[i]);
            if (reason != SkipReason.None) {
                emit ClaimSkipped(accounts[i], amounts[i], reason);
                continue;
            }
            _pay(accounts[i], amounts[i], amount);
            totalPaid += amount;
        }
    }

    /// @notice Leaf hash, identical to OpenZeppelin StandardMerkleTree with
    ///         types ["uint256", "address", "address", "uint256"].
    function leaf(address account, uint256 cumulativeAmount) public view returns (bytes32) {
        return keccak256(
            bytes.concat(keccak256(abi.encode(block.chainid, address(this), account, cumulativeAmount)))
        );
    }

    /// @notice Amount `account` could claim now with a valid proof for `cumulativeAmount`.
    function claimable(address account, uint256 cumulativeAmount) external view returns (uint256) {
        uint256 already = claimed[account];
        return cumulativeAmount > already ? cumulativeAmount - already : 0;
    }

    // ------------------------------------------------------------------ admin

    function setVault(IMiningVault vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(vault_) == address(0)) revert ZeroAddress();
        vault = vault_;
        emit VaultSet(address(vault_));
    }

    function setChallengeDelay(uint256 delay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (delay < MIN_CHALLENGE_DELAY || delay > MAX_CHALLENGE_DELAY) revert InvalidDelay();
        challengeDelay = delay;
        emit ChallengeDelaySet(delay);
    }

    function setMaxDailyIncrease(uint256 maxDailyIncrease_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maxDailyIncrease_ == 0 || maxDailyIncrease_ > type(uint128).max) revert InvalidIncrease();
        maxDailyIncrease = maxDailyIncrease_;
        emit MaxDailyIncreaseSet(maxDailyIncrease_);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // --------------------------------------------------------------- internal

    function _isMatured() internal view returns (bool) {
        return !paused() && _pending.root != bytes32(0)
            && block.timestamp >= uint256(_pending.postedAt) + challengeDelay;
    }

    function _promoteIfMatured() internal {
        if (!_isMatured()) return;
        _active = _pending;
        delete _pending;
        emit RootActivated(_active.day, _active.root, _active.totalEntitled);
    }

    function _check(address account, uint256 cumulativeAmount, bytes32[] calldata proof)
        internal
        view
        returns (SkipReason, uint256)
    {
        RootData storage r = _active;
        if (r.root == bytes32(0)) return (SkipReason.NoActiveRoot, 0);
        if (!MerkleProof.verifyCalldata(proof, r.root, leaf(account, cumulativeAmount))) {
            return (SkipReason.InvalidProof, 0);
        }
        if (cumulativeAmount > maxRewardPerDay * (uint256(r.day) + 1)) return (SkipReason.AboveUserBound, 0);
        uint256 already = claimed[account];
        if (cumulativeAmount <= already) return (SkipReason.NothingToClaim, 0);
        uint256 amount = cumulativeAmount - already;
        if (totalClaimed + amount > r.totalEntitled) return (SkipReason.AboveTotalEntitled, 0);
        return (SkipReason.None, amount);
    }

    function _pay(address account, uint256 cumulativeAmount, uint256 amount) internal {
        claimed[account] = cumulativeAmount;
        totalClaimed += amount;
        emit Claimed(account, amount, cumulativeAmount, _active.day);
        if (AssetTransfer.balanceOf(asset, address(this)) < amount && address(vault) != address(0)) {
            // The amount released is not needed here; the transfer below fails if funds are short.
            // slither-disable-next-line unused-return
            vault.release();
        }
        AssetTransfer.send(asset, account, amount);
    }
}
