// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {LongToken} from "../src/LongToken.sol";

/// @notice Deploys tLONG, the testnet reward token, as a BEP-20 on BSC testnet. Run once.
/// @dev The whole supply goes to `HOLDER`, who bridges the 4 billion mining pool to LONGYU
///      (script/BridgeToL2.s.sol). The script only runs on BSC testnet, so it can never mint a
///      look-alike of $LONG on BSC. Environment: HOLDER, SUPPLY (wei, default 10 billion tLONG,
///      the size of $LONG's supply).
contract DeployTestToken is Script {
    uint256 public constant BSC_TESTNET = 97;

    error NotBscTestnet(uint256 chainId);

    function run() external returns (LongToken token) {
        address holder = vm.envAddress("HOLDER");
        uint256 supply = vm.envOr("SUPPLY", uint256(10_000_000_000e18));
        vm.startBroadcast();
        token = deploy(holder, supply);
        vm.stopBroadcast();
        console2.log("tLONG on BSC testnet", address(token));
    }

    function deploy(address holder, uint256 supply) public returns (LongToken) {
        if (block.chainid != BSC_TESTNET) revert NotBscTestnet(block.chainid);
        return new LongToken("LONGYU Testnet Token", "tLONG", supply, holder);
    }
}
