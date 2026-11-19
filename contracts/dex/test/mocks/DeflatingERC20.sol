// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {TestERC20} from "./TestERC20.sol";

/// @notice Test-only fee-on-transfer token: every transfer burns 1% (rounded down) of the amount, so the
///         recipient receives 99%. Same behaviour as DeflatingERC20 in v2-periphery's test suite.
contract DeflatingERC20 is TestERC20 {
    constructor() TestERC20("Deflating Test Token", "DTT") {}

    function _transfer(address from, address to, uint256 value) internal override {
        uint256 burnAmount = value / 100;
        balanceOf[from] -= burnAmount;
        totalSupply -= burnAmount;
        emit Transfer(from, address(0), burnAmount);
        super._transfer(from, to, value - burnAmount);
    }
}
