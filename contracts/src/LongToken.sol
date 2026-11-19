// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title LongToken
/// @notice Fixed-supply BEP-20 / ERC-20 used for $LONG on BSC and for tLONG on BSC testnet.
/// @dev Built to meet the OP Stack custom gas token rules: exactly 18 decimals, name and symbol
///      of at most 32 bytes, no transfer fees, no rebasing, no transfer hooks and no mint after
///      construction. The whole supply is minted once to `holder`.
contract LongToken is ERC20, ERC20Permit {
    error InvalidHolder();
    error NameOrSymbolTooLong();
    error ZeroSupply();

    constructor(string memory name_, string memory symbol_, uint256 supply, address holder)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        if (holder == address(0)) revert InvalidHolder();
        if (bytes(name_).length > 32 || bytes(symbol_).length > 32) revert NameOrSymbolTooLong();
        if (supply == 0) revert ZeroSupply();
        _mint(holder, supply);
    }
}
