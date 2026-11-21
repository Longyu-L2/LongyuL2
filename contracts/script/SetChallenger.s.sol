// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ISafe} from "./Safes.sol";
import {IMultiSend, IRollupProxyAdmin} from "./SetWithdrawalWait.s.sol";

interface IChallengedOracle {
    function challenger() external view returns (address);
    function proposer() external view returns (address);
    function latestOutputIndex() external view returns (uint256);
    function version() external view returns (string memory);
}

/// @notice Stands in as the output oracle's implementation for one call and writes the challenger.
/// @dev The challenger is the oracle's storage slot 6 in version 1.8.0 and has no setter of its own.
///      Called directly, the function only writes this contract's own storage.
contract ChallengerSetter {
    address public immutable CHALLENGER;

    constructor(address challenger_) {
        CHALLENGER = challenger_;
    }

    function set() external {
        address challenger_ = CHALLENGER;
        assembly {
            sstore(6, challenger_)
        }
    }
}

/// @notice BSC testnet: gives the right to delete wrong state roots to the watchtower's own key, so it
///         happens without a person. One Safe transaction points the output oracle at a setter, writes
///         the challenger and points it back at the same implementation. Run with the admin key, while
///         that key is the Safe's only signer. Mainnet sets its challenger when the rollup is deployed.
/// @dev Environment: CHALLENGER (the watchtower's challenger address).
contract SetChallenger is Script {
    ISafe public constant SAFE = ISafe(0x7b47bB59dD70457d08C5c639Edd0f7647BA9A66D);
    IRollupProxyAdmin public constant PROXY_ADMIN =
        IRollupProxyAdmin(0xDd23a16C3EaedE494e3010692a1E35Ecd2b3E1a9);
    address payable public constant ORACLE = payable(0x2dC53f20F511Bf079167Ef013d6107787E620fE3);
    address public constant ORACLE_IMPLEMENTATION = 0x1A5d5551FD4dA52fbcF1944110991b7153F0Ca55;
    /// Safe's MultiSendCallOnly v1.3.0.
    address public constant MULTI_SEND = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    uint256 public constant CHALLENGER_SLOT = 6;
    uint256 public constant SLOTS_CHECKED = 16;

    error NotBscTestnet();
    error BadChallenger(address challenger);
    error UnexpectedOracle(string what);
    error NotOwnedBySafe();
    error NeedsMoreSignatures();
    error SafeCallFailed();
    error ChangedSlot(uint256 slot);
    error NotApplied(string what);

    function run() external {
        setChallenger(vm.envAddress("CHALLENGER"));
        console2.log("Challenger", IChallengedOracle(ORACLE).challenger());
    }

    function setChallenger(address challenger) public {
        if (block.chainid != 97) revert NotBscTestnet();
        IChallengedOracle oracle = IChallengedOracle(ORACLE);
        if (PROXY_ADMIN.owner() != address(SAFE)) revert NotOwnedBySafe();
        address[] memory owners = SAFE.getOwners();
        if (owners.length != 1 || SAFE.getThreshold() != 1) revert NeedsMoreSignatures();
        address signer = owners[0];
        // A key of its own: not empty, not the current one, not the proposer it checks, not the admin key.
        if (
            challenger == address(0) || challenger == oracle.challenger() || challenger == oracle.proposer()
                || challenger == signer || challenger.code.length != 0
        ) revert BadChallenger(challenger);
        if (PROXY_ADMIN.getProxyImplementation(ORACLE) != ORACLE_IMPLEMENTATION) {
            revert UnexpectedOracle("implementation");
        }
        if (keccak256(bytes(oracle.version())) != keccak256("1.8.0")) revert UnexpectedOracle("version");
        if (address(uint160(uint256(vm.load(ORACLE, bytes32(CHALLENGER_SLOT))))) != oracle.challenger()) {
            revert UnexpectedOracle("storage layout");
        }

        bytes32[] memory before = _slots();
        uint256 latest = oracle.latestOutputIndex();

        vm.startBroadcast(signer);
        ChallengerSetter setter = new ChallengerSetter(challenger);
        bytes memory calls = bytes.concat(
            _call(
                abi.encodeCall(
                    IRollupProxyAdmin.upgradeAndCall,
                    (ORACLE, address(setter), abi.encodeCall(ChallengerSetter.set, ()))
                )
            ),
            _call(abi.encodeCall(IRollupProxyAdmin.upgrade, (ORACLE, ORACLE_IMPLEMENTATION)))
        );
        // A Safe with one signer accepts a transaction that signer sends: r is the signer, v is 1.
        bytes memory approval = abi.encodePacked(uint256(uint160(signer)), uint256(0), uint8(1));
        bool done = SAFE.execTransaction(
            MULTI_SEND,
            0,
            abi.encodeCall(IMultiSend.multiSend, (calls)),
            1,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            approval
        );
        vm.stopBroadcast();
        if (!done) revert SafeCallFailed();

        bytes32[] memory afterwards = _slots();
        for (uint256 i = 0; i < SLOTS_CHECKED; ++i) {
            if (i != CHALLENGER_SLOT && afterwards[i] != before[i]) revert ChangedSlot(i);
        }
        if (oracle.latestOutputIndex() != latest) revert NotApplied("outputs");
        check(challenger);
    }

    /// @notice Reverts unless the oracle has this challenger and its own implementation:
    ///         CHALLENGER=... forge script script/SetChallenger.s.sol:SetChallenger --sig "verify()" --rpc-url $BSC_TESTNET_RPC
    function verify() external view {
        check(vm.envAddress("CHALLENGER"));
    }

    function check(address challenger) public view {
        if (PROXY_ADMIN.getProxyImplementation(ORACLE) != ORACLE_IMPLEMENTATION) {
            revert NotApplied("implementation");
        }
        if (IChallengedOracle(ORACLE).challenger() != challenger) revert NotApplied("challenger");
    }

    function _call(bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), address(PROXY_ADMIN), uint256(0), data.length, data);
    }

    function _slots() private view returns (bytes32[] memory words) {
        words = new bytes32[](SLOTS_CHECKED);
        for (uint256 i = 0; i < SLOTS_CHECKED; ++i) {
            words[i] = vm.load(ORACLE, bytes32(i));
        }
    }
}
