// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AssetTransfer} from "./libraries/AssetTransfer.sol";

/// @title Faucet
/// @notice Gives developers and external-wallet users a small amount of testnet gas.
/// @dev The backend signs a voucher after a captcha. The contract enforces the limits itself, so a
///      leaked signer key can drain at most `dailyCap` per day before the guardian pauses it.
contract Faucet is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address recipient,uint256 amount,uint256 nonce,uint256 deadline)");

    address public immutable asset;
    uint256 public maxPerVoucher;
    uint256 public cooldown;
    uint256 public dailyCap;

    mapping(address recipient => uint256 timestamp) public lastDripAt;
    mapping(uint256 nonce => bool used) public nonceUsed;
    uint256 public currentDay;
    uint256 public dispensedToday;

    event Dripped(address indexed recipient, uint256 amount, uint256 indexed nonce);
    event LimitsSet(uint256 maxPerVoucher, uint256 cooldown, uint256 dailyCap);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error VoucherExpired();
    error NonceUsed();
    error InvalidAmount();
    error CoolingDown(uint256 availableAt);
    error DailyCapReached();
    error InvalidSigner();
    error NativeNotAccepted();

    constructor(
        address asset_,
        address admin,
        address signer,
        address guardian,
        uint256 maxPerVoucher_,
        uint256 cooldown_,
        uint256 dailyCap_
    ) EIP712("LONGYU Faucet", "1") {
        if (admin == address(0) || signer == address(0) || guardian == address(0)) {
            revert ZeroAddress();
        }
        asset = asset_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SIGNER_ROLE, signer);
        _grantRole(GUARDIAN_ROLE, guardian);
        _setLimits(maxPerVoucher_, cooldown_, dailyCap_);
    }

    receive() external payable {
        if (asset != address(0)) revert NativeNotAccepted();
    }

    /// @notice Sends `amount` to `recipient` against a voucher signed by a faucet signer.
    function drip(
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert VoucherExpired();
        if (nonceUsed[nonce]) revert NonceUsed();
        if (amount == 0 || amount > maxPerVoucher) revert InvalidAmount();
        uint256 availableAt = lastDripAt[recipient] + cooldown;
        if (lastDripAt[recipient] != 0 && block.timestamp < availableAt) revert CoolingDown(availableAt);

        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, recipient, amount, nonce, deadline)));
        if (!hasRole(SIGNER_ROLE, ECDSA.recover(digest, signature))) revert InvalidSigner();

        uint256 day = block.timestamp / 1 days;
        if (day != currentDay) {
            currentDay = day;
            dispensedToday = 0;
        }
        if (dispensedToday + amount > dailyCap) revert DailyCapReached();

        nonceUsed[nonce] = true;
        lastDripAt[recipient] = block.timestamp;
        dispensedToday += amount;
        emit Dripped(recipient, amount, nonce);
        AssetTransfer.send(asset, recipient, amount);
    }

    function setLimits(uint256 maxPerVoucher_, uint256 cooldown_, uint256 dailyCap_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setLimits(maxPerVoucher_, cooldown_, dailyCap_);
    }

    function withdraw(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to, amount);
        AssetTransfer.send(asset, to, amount);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _setLimits(uint256 maxPerVoucher_, uint256 cooldown_, uint256 dailyCap_) internal {
        if (maxPerVoucher_ == 0 || dailyCap_ < maxPerVoucher_) revert InvalidAmount();
        maxPerVoucher = maxPerVoucher_;
        cooldown = cooldown_;
        dailyCap = dailyCap_;
        emit LimitsSet(maxPerVoucher_, cooldown_, dailyCap_);
    }
}
