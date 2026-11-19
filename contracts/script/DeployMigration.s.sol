// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MigrationDistributor} from "../src/MigrationDistributor.sol";

/// @notice Deploys the testnet-to-mainnet MigrationDistributor.
/// @dev Environment: ADMIN, GUARDIAN, UNCLAIMED_RECIPIENT, CLAIM_START (unix time),
///      optional ASSET (0x0 = native $LONG on LONGYU mainnet, or the $LONG BEP-20 on BSC),
///      VESTING_SECONDS (default 360 days), CLAIM_WINDOW_SECONDS (default 720 days, counted from
///      CLAIM_START and longer than the vesting period), TGE_BPS (default 2500 = 25% at claim start).
///      CLAIM_START must be in the future by two years at most, the window ten years at most.
///      After deploying: run apps/api/scripts/migration-snapshot.ts with this address, publish the
///      data file, call setRoot from the admin multisig before CLAIM_START, then fund the contract.
contract DeployMigration is Script {
    function run() external returns (MigrationDistributor d) {
        address asset = vm.envOr("ASSET", address(0));
        uint256 start = vm.envUint("CLAIM_START");
        uint256 vesting = vm.envOr("VESTING_SECONDS", uint256(360 days));
        uint256 window = vm.envOr("CLAIM_WINDOW_SECONDS", uint256(720 days));
        uint256 tge = vm.envOr("TGE_BPS", uint256(2_500));
        vm.startBroadcast();
        d = deploy(
            asset,
            vm.envAddress("ADMIN"),
            vm.envAddress("GUARDIAN"),
            start,
            vesting,
            window,
            tge,
            vm.envAddress("UNCLAIMED_RECIPIENT")
        );
        vm.stopBroadcast();
        console2.log("MigrationDistributor", address(d));
    }

    function deploy(
        address asset,
        address admin,
        address guardian,
        uint256 start,
        uint256 vesting,
        uint256 window,
        uint256 tgeBps,
        address unclaimedRecipient
    ) public returns (MigrationDistributor) {
        // The contract keeps 64-bit times and a 16-bit share, all fixed for good. Cut to size, a
        // TGE_BPS of 75536 would read as 10000, so each value is held to its real range first.
        require(start <= type(uint64).max, "claim start does not fit 64 bits");
        require(start > block.timestamp, "claim start must be in the future");
        require(start <= block.timestamp + 730 days, "claim start must be within two years");
        require(vesting != 0, "vesting must not be zero");
        require(window <= 3650 days, "claim window must be ten years at most");
        require(tgeBps <= 10_000, "TGE share must be 10000 bps at most");
        // Claims stop when the window closes, so it must outlast vesting or the last part is lost.
        require(window > vesting, "claim window must be longer than vesting");
        return new MigrationDistributor(
            asset,
            admin,
            guardian,
            uint64(start),
            uint64(vesting),
            uint64(start) + uint64(window),
            uint16(tgeBps),
            unclaimedRecipient
        );
    }
}
