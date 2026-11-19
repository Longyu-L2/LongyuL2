// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AssetTransfer} from "./libraries/AssetTransfer.sol";

/// @title MigrationDistributor
/// @notice Pays mainnet $LONG to eligible testnet miners, with vesting, from one fixed Merkle root.
/// @dev Each leaf holds an account's total allocation. A share (`tgeBps`) unlocks at `claimStart` and
///      the rest unlocks linearly over `vestingDuration`. Claims track the amount already paid, so a
///      user can claim many times as tokens vest and is never paid twice. The root can be set or
///      replaced only before `claimStart`. Tokens unclaimed at `claimEnd` go to a fixed recipient.
///      Claims stop at `claimEnd`, so it must come after the end of vesting: the last part unlocks
///      at `claimStart + vestingDuration` and needs at least one second in which to be claimed.
contract MigrationDistributor is AccessControl, Pausable, ReentrancyGuard, EIP712, Nonces {
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant CLAIM_TO_TYPEHASH =
        keccak256("ClaimTo(address account,address recipient,uint256 nonce,uint256 deadline)");
    uint256 public constant BPS = 10_000;

    address public immutable asset;
    uint64 public immutable claimStart;
    uint64 public immutable vestingDuration;
    uint64 public immutable claimEnd;
    uint16 public immutable tgeBps;
    address public immutable unclaimedRecipient;

    bytes32 public merkleRoot;
    uint256 public totalAllocation;
    uint256 public totalClaimed;
    bool public swept;
    mapping(address account => uint256 amount) public claimed;

    event RootSet(bytes32 root, uint256 totalAllocation, bytes32 dataHash);
    event Claimed(
        address indexed account, address indexed recipient, uint256 amount, uint256 totalClaimedByAccount
    );
    event Swept(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error InvalidSchedule();
    error ClaimsAlreadyStarted();
    error ClaimsNotOpen();
    error ClaimsNotEnded();
    error AlreadySwept();
    error InvalidRoot();
    error InvalidProof();
    error NothingToClaim();
    error AboveTotalAllocation();
    error SignatureExpired();
    error InvalidSignature();
    error NativeNotAccepted();

    constructor(
        address asset_,
        address admin,
        address guardian,
        uint64 claimStart_,
        uint64 vestingDuration_,
        uint64 claimEnd_,
        uint16 tgeBps_,
        address unclaimedRecipient_
    ) EIP712("LONGYU Migration", "1") {
        if (admin == address(0) || guardian == address(0) || unclaimedRecipient_ == address(0)) revert ZeroAddress();
        if (
            claimStart_ <= block.timestamp || tgeBps_ > BPS
                || uint256(claimEnd_) <= uint256(claimStart_) + vestingDuration_ || claimEnd_ <= claimStart_
        ) revert InvalidSchedule();
        asset = asset_;
        claimStart = claimStart_;
        vestingDuration = vestingDuration_;
        claimEnd = claimEnd_;
        tgeBps = tgeBps_;
        unclaimedRecipient = unclaimedRecipient_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    receive() external payable {
        if (asset != address(0)) revert NativeNotAccepted();
    }

    /// @notice Sets the allocation root. Only possible before claims open.
    function setRoot(bytes32 root, uint256 totalAllocation_, bytes32 dataHash)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (block.timestamp >= claimStart) revert ClaimsAlreadyStarted();
        if (root == bytes32(0) || totalAllocation_ == 0) revert InvalidRoot();
        merkleRoot = root;
        totalAllocation = totalAllocation_;
        emit RootSet(root, totalAllocation_, dataHash);
    }

    /// @notice Leaf hash, identical to OpenZeppelin StandardMerkleTree with
    ///         types ["uint256", "address", "address", "uint256"].
    function leaf(address account, uint256 allocation) public view returns (bytes32) {
        return
            keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), account, allocation))));
    }

    /// @notice Amount of `allocation` vested at time `t`.
    function vestedAmount(uint256 allocation, uint256 t) public view returns (uint256) {
        if (t < claimStart) return 0;
        uint256 elapsed = t - claimStart;
        if (elapsed >= vestingDuration) return allocation;
        uint256 atStart = allocation * tgeBps / BPS;
        return atStart + (allocation - atStart) * elapsed / vestingDuration;
    }

    /// @notice Amount `account` can claim now, given its allocation.
    function claimable(address account, uint256 allocation) public view returns (uint256) {
        uint256 vested = vestedAmount(allocation, block.timestamp);
        uint256 already = claimed[account];
        return vested > already ? vested - already : 0;
    }

    /// @notice Pays the vested, unclaimed part of `account`'s allocation to `account`. Anyone may call.
    function claim(address account, uint256 allocation, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        return _claim(account, allocation, proof, account);
    }

    /// @notice Same as `claim`, but pays `recipient`, authorised by an EIP-712 signature from `account`.
    function claimTo(
        address account,
        uint256 allocation,
        bytes32[] calldata proof,
        address recipient,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused returns (uint256) {
        if (recipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CLAIM_TO_TYPEHASH, account, recipient, _useNonce(account), deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(account, digest, signature)) revert InvalidSignature();
        return _claim(account, allocation, proof, recipient);
    }

    /// @notice After `claimEnd`, sends everything left to `unclaimedRecipient`. Anyone may call.
    function sweepUnclaimed() external nonReentrant {
        if (block.timestamp < claimEnd) revert ClaimsNotEnded();
        if (swept) revert AlreadySwept();
        swept = true;
        uint256 amount = AssetTransfer.balanceOf(asset, address(this));
        emit Swept(unclaimedRecipient, amount);
        AssetTransfer.send(asset, unclaimedRecipient, amount);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _claim(address account, uint256 allocation, bytes32[] calldata proof, address recipient)
        internal
        returns (uint256 amount)
    {
        if (block.timestamp < claimStart || block.timestamp >= claimEnd || swept) {
            revert ClaimsNotOpen();
        }
        if (merkleRoot == bytes32(0)) revert InvalidRoot();
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf(account, allocation))) revert InvalidProof();
        amount = claimable(account, allocation);
        if (amount == 0) revert NothingToClaim();
        if (totalClaimed + amount > totalAllocation) revert AboveTotalAllocation();
        claimed[account] += amount;
        totalClaimed += amount;
        emit Claimed(account, recipient, amount, claimed[account]);
        AssetTransfer.send(asset, recipient, amount);
    }
}
