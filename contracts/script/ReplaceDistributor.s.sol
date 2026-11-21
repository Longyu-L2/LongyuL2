// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";
import {MiningVault} from "../src/MiningVault.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";

/// @notice LONGYU testnet: replaces the mining distributor with a new one, keeping every account's
///         claimed amount, the vault and the pool. Run once with the admin key, which holds the admin
///         and guardian roles of the distributor and the admin role of the vault.
///         1. Pauses the old distributor for good: no claim or root goes through it again.
///         2. Deploys the new one with the old one's settings and publisher, and the old one as predecessor.
///         3. Copies the claimed amounts of `ACCOUNTS` (every account that has claimed); the new
///            distributor reads them from the old one and refuses to start unless they add up.
///         4. Points the vault and the new distributor at each other.
///         5. Sends the new distributor, from the admin key, what the old one still holds: the vault
///            released it to the old one, and the new one owes it.
/// @dev Environment: ACCOUNTS (comma-separated), PUBLISHER.
contract ReplaceDistributor is Script {
    MiningDistributor public constant OLD =
        MiningDistributor(payable(0x096ca64cB06f555c56F67FD618684D5C2b7F9e06));
    MiningVault public constant VAULT = MiningVault(payable(0x5c8630c2210943aF91F01774cC1CafdAf61ff097));

    error NotLongyuTestnet();
    error AlreadyReplaced(address distributor);
    error MissingRole(string role, address account);
    error NotApplied(string what);

    function run() external returns (MiningDistributor next) {
        next = replace(vm.envAddress("ACCOUNTS", ","), vm.envAddress("PUBLISHER"), msg.sender);
        console2.log("New distributor", address(next));
    }

    function replace(address[] memory accounts, address publisher, address admin)
        public
        returns (MiningDistributor next)
    {
        if (block.chainid != 668801) revert NotLongyuTestnet();
        if (VAULT.distributor() != address(OLD)) revert AlreadyReplaced(VAULT.distributor());
        if (!OLD.hasRole(OLD.DEFAULT_ADMIN_ROLE(), admin)) revert MissingRole("distributor admin", admin);
        if (!OLD.hasRole(OLD.GUARDIAN_ROLE(), admin)) revert MissingRole("distributor guardian", admin);
        if (!OLD.hasRole(OLD.PUBLISHER_ROLE(), publisher)) revert MissingRole("publisher", publisher);
        if (!VAULT.hasRole(VAULT.DEFAULT_ADMIN_ROLE(), admin)) revert MissingRole("vault admin", admin);
        IERC20 asset = IERC20(OLD.asset());
        EmissionSchedule schedule = OLD.schedule();

        vm.startBroadcast(admin);
        if (!OLD.paused()) OLD.pause();
        // The float is read after the pause, once nothing can move it.
        uint256 float = asset.balanceOf(address(OLD));
        next = new MiningDistributor(
            address(asset),
            schedule,
            OLD.maxRewardPerDay(),
            OLD.challengeDelay(),
            OLD.maxDailyIncrease(),
            admin,
            publisher,
            admin,
            address(OLD)
        );
        next.carryOver(accounts);
        next.completeCarryOver();
        next.setVault(VAULT);
        VAULT.setDistributor(address(next));
        if (float > 0) require(asset.transfer(address(next), float), "transfer");
        vm.stopBroadcast();

        check(next, accounts, float);
    }

    function check(MiningDistributor next, address[] memory accounts, uint256 float) public view {
        if (!OLD.paused()) revert NotApplied("old distributor paused");
        if (VAULT.distributor() != address(next) || address(next.vault()) != address(VAULT)) {
            revert NotApplied("vault");
        }
        if (!next.carryOverComplete() || next.totalClaimed() != OLD.totalClaimed()) {
            revert NotApplied("claims");
        }
        for (uint256 i; i < accounts.length; ++i) {
            if (next.claimed(accounts[i]) != OLD.claimed(accounts[i])) revert NotApplied("claimed amount");
        }
        if (IERC20(next.asset()).balanceOf(address(next)) != float) revert NotApplied("float");
        if (next.paused() || next.activeRoot().root != bytes32(0) || next.pendingRoot().root != bytes32(0)) {
            revert NotApplied("fresh state");
        }
        if (
            next.schedule() != OLD.schedule() || next.maxRewardPerDay() != OLD.maxRewardPerDay()
                || next.challengeDelay() != OLD.challengeDelay()
                || next.maxDailyIncrease() != OLD.maxDailyIncrease()
        ) revert NotApplied("settings");
    }
}
