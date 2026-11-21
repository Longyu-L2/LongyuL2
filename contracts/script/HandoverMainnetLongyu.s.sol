// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IOwnable, Safes} from "./Safes.sol";

/// @notice LONGYU mainnet: hands the upgrade rights over the chain's built-in contracts (the genesis
///         ProxyAdmin) from the deploying key to a timelock that only the founders' Safe on LONGYU can
///         use, so every upgrade is announced on chain and waits TIMELOCK_DELAY. Run once, with the
///         deploying key, after CreateSafe has created the founders' Safe on LONGYU. The mining
///         contracts and LONGYU Swap are deployed with that timelock and Safe as their admins.
/// @dev Environment: SAFE (the founders' Safe on LONGYU), TIMELOCK_DELAY (seconds, default 2 days).
contract HandoverMainnetLongyu is Script {
    /// The ProxyAdmin built into the genesis: it can upgrade every predeploy.
    IOwnable public constant PROXY_ADMIN = IOwnable(0x4200000000000000000000000000000000000018);
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant MAX_DELAY = 30 days;

    error NotLongyuMainnet();
    error DelayOutOfRange(uint256 delay);
    error NotOwnedByDeployer();
    error HandoverIncomplete(string what);

    function run() external returns (TimelockController timelock) {
        address deployer = PROXY_ADMIN.owner();
        timelock = handOver(vm.envAddress("SAFE"), vm.envOr("TIMELOCK_DELAY", uint256(2 days)), deployer);
        console2.log("Timelock on LONGYU", address(timelock));
    }

    function handOver(address safe, uint256 delay, address deployer) public returns (TimelockController timelock) {
        if (block.chainid != 668800) revert NotLongyuMainnet();
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert DelayOutOfRange(delay);
        if (PROXY_ADMIN.owner() != deployer || deployer.code.length != 0) revert NotOwnedByDeployer();
        Safes.requireMultisig(safe, deployer);

        address[] memory founders = new address[](1);
        founders[0] = safe;
        vm.startBroadcast(deployer);
        // No admin: only the timelock itself, through a delayed proposal, can change its own roles.
        timelock = new TimelockController(delay, founders, founders, address(0));
        PROXY_ADMIN.transferOwnership(address(timelock));
        vm.stopBroadcast();
        check(safe, timelock, delay, deployer);
    }

    /// @notice Reverts unless the handover is complete. Run it against LONGYU after broadcasting:
    ///         SAFE=.. TIMELOCK=.. DEPLOYER=.. forge script script/HandoverMainnetLongyu.s.sol --sig "verify()" --rpc-url $LONGYU_RPC
    function verify() external view {
        check(
            vm.envAddress("SAFE"),
            TimelockController(payable(vm.envAddress("TIMELOCK"))),
            vm.envOr("TIMELOCK_DELAY", uint256(2 days)),
            vm.envAddress("DEPLOYER")
        );
    }

    function check(address safe, TimelockController timelock, uint256 delay, address deployer) public view {
        if (PROXY_ADMIN.owner() != address(timelock)) revert HandoverIncomplete("ProxyAdmin owner");
        if (timelock.getMinDelay() != delay) revert HandoverIncomplete("timelock delay");
        bytes32[3] memory roles = [timelock.PROPOSER_ROLE(), timelock.EXECUTOR_ROLE(), timelock.CANCELLER_ROLE()];
        for (uint256 i = 0; i < roles.length; ++i) {
            if (!timelock.hasRole(roles[i], safe)) revert HandoverIncomplete("Safe's timelock role");
            if (timelock.hasRole(roles[i], deployer)) revert HandoverIncomplete("deployer holds a timelock role");
            if (timelock.hasRole(roles[i], address(0))) revert HandoverIncomplete("open timelock role");
        }
        bytes32 admin = timelock.DEFAULT_ADMIN_ROLE();
        if (!timelock.hasRole(admin, address(timelock))) revert HandoverIncomplete("timelock self-administration");
        if (timelock.hasRole(admin, deployer) || timelock.hasRole(admin, safe)) {
            revert HandoverIncomplete("timelock has an admin");
        }
    }
}
