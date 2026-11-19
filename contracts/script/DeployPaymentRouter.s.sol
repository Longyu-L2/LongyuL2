// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// @notice Deploys the PaymentRouter on BSC.
/// @dev Environment: ADMIN, GUARDIAN, TREASURY. The admin allows the payment tokens afterwards
///      with setAcceptedToken. The router is not upgradeable: after a redeploy, point the API at the
///      new address and its deployment block.
contract DeployPaymentRouter is Script {
    function run() external returns (PaymentRouter router) {
        vm.startBroadcast();
        router =
            new PaymentRouter(vm.envAddress("ADMIN"), vm.envAddress("GUARDIAN"), vm.envAddress("TREASURY"));
        vm.stopBroadcast();
        console2.log("PaymentRouter", address(router));
        console2.log("deployment block", block.number);
    }
}
