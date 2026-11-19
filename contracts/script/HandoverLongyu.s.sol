// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IOwnable, Safes} from "./Safes.sol";

interface ISwapFactory {
    function feeToSetter() external view returns (address);
    function setFeeToSetter(address newSetter) external;
}

/// @notice LONGYU testnet: gives the founders' multisig what the testnet admin key controls there, the
///         LONGYU Swap fee setting and the upgrade rights over the chain's built-in contracts. Run once,
///         with the admin key, after CreateSafe has created the multisig on LONGYU.
/// @dev Environment: ADMIN_SAFE (the Safe on LONGYU).
contract HandoverLongyu is Script {
    ISwapFactory public constant SWAP_FACTORY = ISwapFactory(0xfE5372cA129113bf12EC70D1EE4A7cBB14f172B0);
    /// The ProxyAdmin built into the genesis: it can upgrade every predeploy.
    IOwnable public constant PROXY_ADMIN = IOwnable(0x4200000000000000000000000000000000000018);

    error NotLongyuTestnet();
    error AlreadyHandedOver();
    error NotOwnedByAdminKey(address target);
    error HandoverIncomplete(string what);

    function run() external {
        address safe = vm.envAddress("ADMIN_SAFE");
        handOver(safe);
        console2.log("Admin Safe on LONGYU", safe);
    }

    function handOver(address safe) public {
        if (block.chainid != 668801) revert NotLongyuTestnet();
        address adminKey = SWAP_FACTORY.feeToSetter();
        if (adminKey.code.length != 0) revert AlreadyHandedOver();
        if (PROXY_ADMIN.owner() != adminKey) revert NotOwnedByAdminKey(address(PROXY_ADMIN));
        Safes.requireMultisig(safe, adminKey);

        vm.startBroadcast(adminKey);
        SWAP_FACTORY.setFeeToSetter(safe);
        PROXY_ADMIN.transferOwnership(safe);
        vm.stopBroadcast();
        check(safe);
    }

    /// @notice Reverts unless the handover is complete. Run it against the chain after broadcasting:
    ///         forge script script/HandoverLongyu.s.sol --sig "verify()" --rpc-url $LONGYU_RPC
    function verify() external view {
        check(vm.envAddress("ADMIN_SAFE"));
    }

    function check(address safe) public view {
        if (SWAP_FACTORY.feeToSetter() != safe) revert HandoverIncomplete("fee setter");
        if (PROXY_ADMIN.owner() != safe) revert HandoverIncomplete("ProxyAdmin owner");
    }
}
