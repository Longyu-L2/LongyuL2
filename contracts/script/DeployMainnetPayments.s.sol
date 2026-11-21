// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {Safes} from "./Safes.sol";

/// @notice BSC: deploys the PaymentRouter for capacity plans and partner orders. Every payment goes
///         straight to the treasury (the founders' Safe); the router holds nothing. It accepts BNB and
///         BSC's USDT, then hands its admin to the timelock the Safe runs: changing the treasury or the
///         accepted tokens is announced on chain first. The Safe is the guardian (pause). The deploying
///         key keeps nothing.
/// @dev Environment: SAFE (the founders' Safe on BSC), TIMELOCK (the timelock on BSC).
contract DeployMainnetPayments is Script {
    /// Binance-Peg BSC-USD (USDT) on BSC, 18 decimals.
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    error NotBsc();
    error SenderRequired();
    error NotHandedOver(string what);

    function run() external returns (PaymentRouter router) {
        if (msg.sender == DEFAULT_SENDER) revert SenderRequired();
        address safe = vm.envAddress("SAFE");
        address timelock = vm.envAddress("TIMELOCK");
        vm.startBroadcast();
        router = deploy(msg.sender, safe, timelock);
        vm.stopBroadcast();
        console2.log("PaymentRouter", address(router));
        console2.log("deployment block", block.number);
    }

    function deploy(address deployer, address safe, address timelock) public returns (PaymentRouter router) {
        if (block.chainid != 56) revert NotBsc();
        Safes.requireMultisig(safe, deployer);
        TimelockController t = TimelockController(payable(timelock));
        if (t.getMinDelay() < 1 days || !t.hasRole(t.PROPOSER_ROLE(), safe)) revert NotHandedOver("timelock");

        router = new PaymentRouter(deployer, safe, safe);
        router.setAcceptedToken(address(0), true);
        router.setAcceptedToken(USDT, true);
        bytes32 admin = router.DEFAULT_ADMIN_ROLE();
        router.grantRole(admin, timelock);
        router.renounceRole(admin, deployer);
        check(router, safe, timelock, deployer);
    }

    function check(PaymentRouter router, address safe, address timelock, address deployer) public view {
        bytes32 admin = router.DEFAULT_ADMIN_ROLE();
        if (router.treasury() != safe) revert NotHandedOver("treasury");
        if (!router.acceptedToken(address(0)) || !router.acceptedToken(USDT)) revert NotHandedOver("tokens");
        if (!router.hasRole(admin, timelock) || router.hasRole(admin, deployer)) revert NotHandedOver("admin");
        if (!router.hasRole(router.GUARDIAN_ROLE(), safe)) revert NotHandedOver("guardian");
    }
}
