// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IMiningVault {
    function release() external returns (uint256);
    function distributor() external view returns (address);
    /// @notice A replaced distributor gives back what it holds (it approves the vault first).
    function takeBack(uint256 amount) external;
}
