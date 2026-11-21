// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ISafe, ISafeProxyFactory, Safes} from "./Safes.sol";

/// @notice Creates a Safe v1.3.0 multisig on BSC, BSC testnet or LONGYU (testnet or mainnet). Any funded key can send it:
///         the sender gets no rights over the Safe.
/// @dev Environment: OWNERS (signer addresses, comma-separated), THRESHOLD (signatures needed, at least
///      2), SALT_NONCE (default 0; change it to create a second Safe with the same signers).
///      With --ledger or --account, also pass --sender with the signing address.
contract CreateSafe is Script {
    error OwnersDiffer();
    error SenderRequired();

    function run() external returns (address safe) {
        // A hardware wallet or keystore signs the transaction but, without --sender, msg.sender here is
        // forge's default address: the check that the sending key is no signer would test that instead.
        if (msg.sender == DEFAULT_SENDER) revert SenderRequired();
        address[] memory owners = vm.envAddress("OWNERS", ",");
        uint256 threshold = vm.envUint("THRESHOLD");
        uint256 saltNonce = vm.envOr("SALT_NONCE", uint256(0));
        vm.startBroadcast();
        safe = create(owners, threshold, saltNonce, msg.sender);
        vm.stopBroadcast();
        console2.log("Safe", safe);
        console2.log("signatures needed", threshold, "of", owners.length);
    }

    /// @param sender The key that sends the transaction; it must not be one of the signers.
    function create(address[] memory owners, uint256 threshold, uint256 saltNonce, address sender)
        public
        returns (address safe)
    {
        Safes.Kit memory k = Safes.kit();
        Safes.checkOwners(owners, threshold, sender);
        bytes memory setup = abi.encodeCall(
            ISafe.setup,
            (owners, threshold, address(0), "", k.fallbackHandler, address(0), 0, payable(address(0)))
        );
        // The L2 singleton is the same Safe plus an event for every transaction, which LONGYU Scan can show.
        safe = ISafeProxyFactory(k.factory).createProxyWithNonce(k.singletonL2, setup, saltNonce);
        Safes.requireMultisig(safe, sender);
        if (!Safes.sameOwners(safe, owners, threshold)) revert OwnersDiffer();
    }
}
