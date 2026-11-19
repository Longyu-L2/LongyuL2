// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice The token factory built into every LONGYU genesis (OP Stack predeploy).
interface IOptimismMintableERC20Factory {
    function createOptimismMintableERC20(address remoteToken, string memory name, string memory symbol)
        external
        returns (address);
}

/// @notice Creates tLONG's copy on LONGYU, linked to the BEP-20 on BSC. Run once against LONGYU.
/// @dev The copy is minted only by LONGYU's standard bridge when tLONG is deposited on BSC, and
///      burned when it is withdrawn, so its supply always equals what the bridge holds on BSC.
///      Environment: L1_TOKEN (tLONG on BSC testnet), NAME and SYMBOL (default the testnet token's).
contract CreateL2Token is Script {
    address public constant FACTORY = 0x4200000000000000000000000000000000000012;

    error NotOnLongyu();
    error InvalidL1Token();

    function run() external returns (address token) {
        address l1Token = vm.envAddress("L1_TOKEN");
        string memory name = vm.envOr("NAME", string("LONGYU Testnet Token"));
        string memory symbol = vm.envOr("SYMBOL", string("tLONG"));
        vm.startBroadcast();
        token = create(l1Token, name, symbol);
        vm.stopBroadcast();
        console2.log("tLONG on LONGYU", token);
    }

    function create(address l1Token, string memory name, string memory symbol) public returns (address) {
        if (l1Token == address(0)) revert InvalidL1Token();
        // Without the factory this is not a LONGYU (OP Stack) chain: refuse rather than fail later.
        if (FACTORY.code.length == 0) revert NotOnLongyu();
        return IOptimismMintableERC20Factory(FACTORY).createOptimismMintableERC20(l1Token, name, symbol);
    }
}
