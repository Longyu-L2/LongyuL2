// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISafe, IOwnable, Safes} from "./Safes.sol";

/// @notice BSC testnet: takes everything the testnet admin key controls and gives it to the founders'
///         multisig. Run once, with the admin key.
/// @dev The rollup's SystemOwnerSafe already owns the upgrade rights (ProxyAdmin) but has the admin key
///      as its only signer. This script makes the founders its signers and removes the admin key in one
///      Safe transaction, then moves tLONG's supply and the ownership of SystemConfig and
///      ProtocolVersions to it. The guardian (pause) and challenger roles are fixed in the rollup
///      contracts at deployment and stay with the admin key; neither can move funds.
///      Environment: OWNERS (signer addresses, comma-separated), THRESHOLD (signatures needed, at least 2).
contract HandoverBsc is Script {
    ISafe public constant SYSTEM_OWNER_SAFE = ISafe(0x7b47bB59dD70457d08C5c639Edd0f7647BA9A66D);
    IERC20 public constant TLONG = IERC20(0x88d5B1946BaB654e31Fbf0bcc3D022e995aB129C);
    IOwnable public constant SYSTEM_CONFIG = IOwnable(0xeED847eE4D4Bef1ee078A4299b6289E9Cc3Fe8a5);
    IOwnable public constant PROTOCOL_VERSIONS = IOwnable(0x44a50f644d265100A178f8071681fC7Bd65B36a2);
    IOwnable public constant PROXY_ADMIN = IOwnable(0xDd23a16C3EaedE494e3010692a1E35Ecd2b3E1a9);
    /// Safe's MultiSendCallOnly v1.3.0.
    address public constant MULTI_SEND = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;

    error NotBscTestnet();
    error AlreadyHandedOver();
    error NotOwnedByAdminKey(address target);
    error HandoverIncomplete(string what);

    function run() external {
        address[] memory owners = vm.envAddress("OWNERS", ",");
        uint256 threshold = vm.envUint("THRESHOLD");
        handOver(owners, threshold);
        console2.log("Admin Safe", address(SYSTEM_OWNER_SAFE));
        console2.log("tLONG held by the Safe", TLONG.balanceOf(address(SYSTEM_OWNER_SAFE)));
    }

    function handOver(address[] memory owners, uint256 threshold) public {
        if (block.chainid != 97) revert NotBscTestnet();
        address safe = address(SYSTEM_OWNER_SAFE);
        address[] memory current = SYSTEM_OWNER_SAFE.getOwners();
        if (current.length != 1 || SYSTEM_OWNER_SAFE.getThreshold() != 1) revert AlreadyHandedOver();
        address adminKey = current[0];
        Safes.checkOwners(owners, threshold, adminKey);
        if (PROXY_ADMIN.owner() != safe) revert NotOwnedByAdminKey(address(PROXY_ADMIN));
        if (SYSTEM_CONFIG.owner() != adminKey) revert NotOwnedByAdminKey(address(SYSTEM_CONFIG));
        if (PROTOCOL_VERSIONS.owner() != adminKey) revert NotOwnedByAdminKey(address(PROTOCOL_VERSIONS));
        uint256 supply = TLONG.balanceOf(adminKey);
        uint256 held = TLONG.balanceOf(safe);

        // Signers are added from the last to the first, so the Safe lists them in the order given and
        // the admin key ends up right after the last one, which removeOwner needs to know.
        bytes memory calls;
        for (uint256 i = owners.length; i > 0; --i) {
            calls = bytes.concat(
                calls, _call(safe, abi.encodeCall(ISafe.addOwnerWithThreshold, (owners[i - 1], 1)))
            );
        }
        calls = bytes.concat(
            calls,
            _call(safe, abi.encodeCall(ISafe.removeOwner, (owners[owners.length - 1], adminKey, threshold)))
        );

        vm.startBroadcast(adminKey);
        // The admin key sends the transaction itself, which counts as its signature (v = 1).
        SYSTEM_OWNER_SAFE.execTransaction(
            MULTI_SEND,
            0,
            abi.encodeWithSignature("multiSend(bytes)", calls),
            1,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            abi.encodePacked(uint256(uint160(adminKey)), uint256(0), uint8(1))
        );
        // Nothing is sent to the Safe before it is known to be the founders'.
        Safes.requireMultisig(safe, adminKey);
        if (!Safes.sameOwners(safe, owners, threshold)) revert HandoverIncomplete("signers");
        if (!TLONG.transfer(safe, supply)) revert HandoverIncomplete("tLONG transfer");
        SYSTEM_CONFIG.transferOwnership(safe);
        PROTOCOL_VERSIONS.transferOwnership(safe);
        vm.stopBroadcast();

        if (TLONG.balanceOf(adminKey) != 0 || TLONG.balanceOf(safe) != held + supply) {
            revert HandoverIncomplete("tLONG balance");
        }
        check(owners, threshold);
    }

    /// @notice Reverts unless the handover is complete. Run it against the chain after broadcasting:
    ///         forge script script/HandoverBsc.s.sol --sig "verify()" --rpc-url $BSC_TESTNET_RPC
    function verify() external view {
        check(vm.envAddress("OWNERS", ","), vm.envUint("THRESHOLD"));
    }

    function check(address[] memory owners, uint256 threshold) public view {
        address safe = address(SYSTEM_OWNER_SAFE);
        if (!Safes.sameOwners(safe, owners, threshold)) revert HandoverIncomplete("signers");
        if (PROXY_ADMIN.owner() != safe) revert HandoverIncomplete("ProxyAdmin owner");
        if (SYSTEM_CONFIG.owner() != safe) revert HandoverIncomplete("SystemConfig owner");
        if (PROTOCOL_VERSIONS.owner() != safe) revert HandoverIncomplete("ProtocolVersions owner");
    }

    /// One call in MultiSend's packed format: operation (0 = call), target, value, data length, data.
    function _call(address to, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), data.length, data);
    }
}
