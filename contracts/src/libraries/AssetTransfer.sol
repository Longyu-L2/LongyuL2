// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AssetTransfer
/// @notice Moves either the chain's native token (asset == address(0)) or an ERC-20 token.
/// @dev Native $LONG is the gas token under Option A; an ERC-20 $LONG is used under Option C.
library AssetTransfer {
    using SafeERC20 for IERC20;

    error NativeTransferFailed(address to, uint256 amount);

    function balanceOf(address asset, address account) internal view returns (uint256) {
        return asset == address(0) ? account.balance : IERC20(asset).balanceOf(account);
    }

    function send(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed(to, amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
