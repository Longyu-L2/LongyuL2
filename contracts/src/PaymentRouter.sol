// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PaymentRouter
/// @notice Accepts real BNB or approved BEP-20 tokens (such as USDT) on BNB Smart Chain for
///         commercial orders, forwards them straight to the treasury multisig and emits one event
///         per order. The backend watches `OrderPaid` and activates the entitlement once.
/// @dev Holds no funds. An order ID commits to the order's reference, token and amount, and can be
///      paid only once: a payment of any other token or amount lands on a different ID, so nobody
///      can use up an order by paying dust under its reference. Tokens that deliver less than the
///      stated amount (fee-on-transfer) are rejected.
contract PaymentRouter is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    address public treasury;
    mapping(address token => bool accepted) public acceptedToken;
    mapping(bytes32 orderId => bool done) public paid;

    event OrderPaid(bytes32 indexed orderId, address indexed payer, address indexed token, uint256 amount);
    event TreasurySet(address treasury);
    event TokenAccepted(address indexed token, bool accepted);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroReference();
    error AlreadyPaid();
    error TokenNotAccepted();
    error NativeNotAccepted();
    error TransferShortfall(uint256 expected, uint256 received);
    error ForwardFailed();

    constructor(address admin, address guardian, address treasury_) {
        if (admin == address(0) || guardian == address(0) || treasury_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice The ID of the order with this reference, token (address(0) for BNB) and amount.
    function orderIdOf(bytes32 ref, address token, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), ref, token, amount));
    }

    /// @notice Pays an order in BNB. The value sent must be the order's exact amount.
    function payNative(bytes32 ref) external payable nonReentrant whenNotPaused {
        if (!acceptedToken[address(0)]) revert NativeNotAccepted();
        if (msg.value == 0) revert ZeroAmount();
        bytes32 orderId = _markPaid(ref, address(0), msg.value);
        emit OrderPaid(orderId, msg.sender, address(0), msg.value);
        (bool ok,) = treasury.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
    }

    /// @notice Pays an order in an accepted token. The payer must approve this contract first.
    function payToken(bytes32 ref, address token, uint256 amount) external nonReentrant whenNotPaused {
        if (token == address(0) || !acceptedToken[token]) revert TokenNotAccepted();
        if (amount == 0) revert ZeroAmount();
        bytes32 orderId = _markPaid(ref, token, amount);
        address t = treasury;
        uint256 before = IERC20(token).balanceOf(t);
        IERC20(token).safeTransferFrom(msg.sender, t, amount);
        uint256 received = IERC20(token).balanceOf(t) - before;
        if (received != amount) revert TransferShortfall(amount, received);
        emit OrderPaid(orderId, msg.sender, token, amount);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Accepts or rejects a payment token; address(0) means BNB.
    function setAcceptedToken(address token, bool accepted) external onlyRole(DEFAULT_ADMIN_ROLE) {
        acceptedToken[token] = accepted;
        emit TokenAccepted(token, accepted);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _markPaid(bytes32 ref, address token, uint256 amount) internal returns (bytes32 orderId) {
        if (ref == bytes32(0)) revert ZeroReference();
        orderId = orderIdOf(ref, token, amount);
        if (paid[orderId]) revert AlreadyPaid();
        paid[orderId] = true;
    }
}
