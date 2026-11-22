// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TokenLauncher} from "../src/TokenLauncher.sol";

/// @notice Deploys TokenLauncher on LONGYU. It has no owner and no settings, so nothing follows the deploy.
///         Run: forge script script/DeployTokenLauncher.s.sol --rpc-url $LONGYU_RPC --broadcast [signer flags]
contract DeployTokenLauncher is Script {
    function run() external returns (TokenLauncher launcher) {
        vm.startBroadcast();
        launcher = new TokenLauncher();
        vm.stopBroadcast();
        verify(launcher);
        console2.log("chain id      ", block.chainid);
        console2.log("TokenLauncher ", address(launcher));
    }

    /// @dev The launcher works and refuses LONGYU's names (local calls, not broadcast).
    function verify(TokenLauncher launcher) public view {
        require(address(launcher).code.length > 0, "no code");
        require(launcher.tokenCount() == 0, "not empty");
        require(launcher.passesForLongyu("X", "LONG") && !launcher.passesForLongyu("Pearl", "PEARL"), "name rule");
    }
}
