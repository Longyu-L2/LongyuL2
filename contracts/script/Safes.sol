// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of Safe v1.3.0 the scripts use.
interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function removeOwner(address prevOwner, address owner, uint256 threshold) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
    function nonce() external view returns (uint256);
    function VERSION() external view returns (string memory);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory, address);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address);
    function proxyRuntimeCode() external pure returns (bytes memory);
}

interface IOwnable {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// @notice Safe v1.3.0 as deployed on BSC testnet and LONGYU testnet, and the checks every handover makes.
library Safes {
    struct Kit {
        address factory;
        address singleton;
        address singletonL2;
        address fallbackHandler;
    }

    address internal constant SENTINEL = address(1);
    bytes32 internal constant GUARD_SLOT = keccak256("guard_manager.guard.address");
    bytes32 internal constant HANDLER_SLOT = keccak256("fallback_manager.handler.address");

    error UnknownChain(uint256 chainId);
    error TooFewOwners();
    error ThresholdOutOfRange();
    error InvalidOwner(address owner);
    error DuplicateOwner(address owner);
    error NotASafe(address account);
    error UnknownSingleton(address singleton);
    error UnknownFallbackHandler(address handler);
    error HasGuard(address guard);
    error HasModules();
    error ThresholdTooLow(uint256 threshold);
    error SingleKeyIsOwner(address key);

    function kit() internal view returns (Kit memory) {
        // BSC testnet: Safe's canonical deployment.
        if (block.chainid == 97) {
            return Kit({
                factory: 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2,
                singleton: 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552,
                singletonL2: 0x3E5c63644E683549055b9Be8653de26E0B4CD36E,
                fallbackHandler: 0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4
            });
        }
        // LONGYU testnet: the singletons are in the genesis; the factory and the handler were deployed
        // through the genesis SafeSingletonFactory, at Safe's addresses for that deployer.
        if (block.chainid == 668801) {
            return Kit({
                factory: 0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC,
                singleton: 0x69f4D1788e39c87893C980c06EdF4b7f686e2938,
                singletonL2: 0xfb1bffC9d739B8D520DaF37dF666da4C687191EA,
                fallbackHandler: 0x017062a1dE2FE6b99BE3d9d37841FeD19F573804
            });
        }
        revert UnknownChain(block.chainid);
    }

    /// @notice A signer list fit for a multisig: at least two signers, at least two signatures, no
    ///         repeats, and `singleKey` (the key being replaced) not among them.
    function checkOwners(address[] memory owners, uint256 threshold, address singleKey) internal pure {
        if (owners.length < 2) revert TooFewOwners();
        if (threshold < 2 || threshold > owners.length) revert ThresholdOutOfRange();
        for (uint256 i = 0; i < owners.length; ++i) {
            if (owners[i] == address(0) || owners[i] == SENTINEL) revert InvalidOwner(owners[i]);
            if (owners[i] == singleKey) revert SingleKeyIsOwner(singleKey);
            for (uint256 j = 0; j < i; ++j) {
                if (owners[j] == owners[i]) revert DuplicateOwner(owners[i]);
            }
        }
    }

    /// @notice Reverts unless `safe` is a plain Safe v1.3.0 that needs at least two signatures and that
    ///         `singleKey` cannot sign for: the known proxy and singleton, no module, no guard, and no
    ///         fallback handler other than Safe's own.
    function requireMultisig(address safe, address singleKey) internal view {
        Kit memory k = kit();
        if (safe.codehash != keccak256(ISafeProxyFactory(k.factory).proxyRuntimeCode())) {
            revert NotASafe(safe);
        }
        address singleton = address(uint160(word(safe, 0)));
        if (singleton != k.singleton && singleton != k.singletonL2) revert UnknownSingleton(singleton);
        address handler = address(uint160(word(safe, uint256(HANDLER_SLOT))));
        if (handler != address(0) && handler != k.fallbackHandler) revert UnknownFallbackHandler(handler);
        address guard = address(uint160(word(safe, uint256(GUARD_SLOT))));
        if (guard != address(0)) revert HasGuard(guard);
        (address[] memory modules,) = ISafe(safe).getModulesPaginated(SENTINEL, 1);
        if (modules.length != 0) revert HasModules();
        uint256 threshold = ISafe(safe).getThreshold();
        if (threshold < 2) revert ThresholdTooLow(threshold);
        if (ISafe(safe).isOwner(singleKey)) revert SingleKeyIsOwner(singleKey);
    }

    function sameOwners(address safe, address[] memory owners, uint256 threshold)
        internal
        view
        returns (bool)
    {
        address[] memory current = ISafe(safe).getOwners();
        if (current.length != owners.length || ISafe(safe).getThreshold() != threshold) return false;
        for (uint256 i = 0; i < owners.length; ++i) {
            if (current[i] != owners[i]) return false;
        }
        return true;
    }

    function word(address safe, uint256 slot) private view returns (uint256) {
        return abi.decode(ISafe(safe).getStorageAt(slot, 1), (uint256));
    }
}
