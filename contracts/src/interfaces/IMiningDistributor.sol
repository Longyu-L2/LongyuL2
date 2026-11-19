// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IMiningDistributor {
    /// @notice Total entitlement of the root that is claimable right now (0 if none).
    function activeTotalEntitled() external view returns (uint256);
}
