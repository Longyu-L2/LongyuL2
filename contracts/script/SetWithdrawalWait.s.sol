// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ISafe} from "./Safes.sol";

interface IRollupProxyAdmin {
    function owner() external view returns (address);
    function getProxyImplementation(address proxy) external view returns (address);
    function upgrade(address payable proxy, address implementation) external;
    function upgradeAndCall(address payable proxy, address implementation, bytes memory data) external payable;
}

interface IOutputOracle {
    function FINALIZATION_PERIOD_SECONDS() external view returns (uint256);
    function latestOutputIndex() external view returns (uint256);
    function version() external view returns (string memory);
}

interface IMultiSend {
    function multiSend(bytes memory transactions) external payable;
}

/// @notice Stands in as the output oracle's implementation for one call and writes the withdrawal wait.
/// @dev The wait is the oracle's storage slot 8 in version 1.8.0 and has no setter of its own. Called
///      directly, the function only writes this contract's own storage.
contract WithdrawalWaitSetter {
    uint256 public immutable WAIT;

    constructor(uint256 wait) {
        WAIT = wait;
    }

    function set() external {
        uint256 wait = WAIT;
        assembly {
            sstore(8, wait)
        }
    }
}

/// @notice BSC testnet: changes how long a withdrawal from LONGYU waits before it can be finalized.
///         One Safe transaction points the output oracle at a setter, writes the wait and points it back
///         at the same implementation, so the oracle is never left on the setter. Run with the admin key,
///         while that key is the Safe's only signer; a multisig sends the same batch with its own signatures.
/// @dev Environment: WITHDRAWAL_WAIT (seconds).
contract SetWithdrawalWait is Script {
    ISafe public constant SAFE = ISafe(0x7b47bB59dD70457d08C5c639Edd0f7647BA9A66D);
    IRollupProxyAdmin public constant PROXY_ADMIN =
        IRollupProxyAdmin(0xDd23a16C3EaedE494e3010692a1E35Ecd2b3E1a9);
    address payable public constant ORACLE = payable(0x2dC53f20F511Bf079167Ef013d6107787E620fE3);
    address public constant ORACLE_IMPLEMENTATION = 0x1A5d5551FD4dA52fbcF1944110991b7153F0Ca55;
    /// Safe's MultiSendCallOnly v1.3.0.
    address public constant MULTI_SEND = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    uint256 public constant WAIT_SLOT = 8;
    /// The oracle's storage ends at slot 8; the slots after it are read too, to see that nothing else moved.
    uint256 public constant SLOTS_CHECKED = 16;
    uint256 public constant MIN_WAIT = 5 minutes;
    uint256 public constant MAX_WAIT = 7 days;

    error NotBscTestnet();
    error WaitOutOfRange(uint256 wait);
    error UnexpectedOracle(string what);
    error NotOwnedBySafe();
    error NeedsMoreSignatures();
    error SafeCallFailed();
    error ChangedSlot(uint256 slot);
    error NotApplied(string what);

    function run() external {
        setWait(vm.envUint("WITHDRAWAL_WAIT"));
        console2.log("Withdrawal wait, seconds", IOutputOracle(ORACLE).FINALIZATION_PERIOD_SECONDS());
    }

    function setWait(uint256 wait) public {
        if (block.chainid != 97) revert NotBscTestnet();
        if (wait < MIN_WAIT || wait > MAX_WAIT) revert WaitOutOfRange(wait);
        if (PROXY_ADMIN.owner() != address(SAFE)) revert NotOwnedBySafe();
        address[] memory owners = SAFE.getOwners();
        if (owners.length != 1 || SAFE.getThreshold() != 1) revert NeedsMoreSignatures();
        address signer = owners[0];
        if (PROXY_ADMIN.getProxyImplementation(ORACLE) != ORACLE_IMPLEMENTATION) {
            revert UnexpectedOracle("implementation");
        }
        if (keccak256(bytes(IOutputOracle(ORACLE).version())) != keccak256("1.8.0")) {
            revert UnexpectedOracle("version");
        }
        uint256 current = IOutputOracle(ORACLE).FINALIZATION_PERIOD_SECONDS();
        if (uint256(vm.load(ORACLE, bytes32(WAIT_SLOT))) != current) {
            revert UnexpectedOracle("storage layout");
        }

        bytes32[] memory before = _slots();
        uint256 latest = IOutputOracle(ORACLE).latestOutputIndex();

        vm.startBroadcast(signer);
        WithdrawalWaitSetter setter = new WithdrawalWaitSetter(wait);
        bytes memory calls = bytes.concat(
            _call(
                abi.encodeCall(
                    IRollupProxyAdmin.upgradeAndCall,
                    (ORACLE, address(setter), abi.encodeCall(WithdrawalWaitSetter.set, ()))
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
            if (i != WAIT_SLOT && afterwards[i] != before[i]) revert ChangedSlot(i);
        }
        if (IOutputOracle(ORACLE).latestOutputIndex() != latest) revert NotApplied("outputs");
        check(wait);
    }

    /// @notice Reverts unless the oracle has this wait and its own implementation. Run it against the
    ///         chain after broadcasting:
    ///         WITHDRAWAL_WAIT=... forge script script/SetWithdrawalWait.s.sol:SetWithdrawalWait --sig "verify()" --rpc-url $BSC_TESTNET_RPC
    function verify() external view {
        check(vm.envUint("WITHDRAWAL_WAIT"));
    }

    function check(uint256 wait) public view {
        if (PROXY_ADMIN.getProxyImplementation(ORACLE) != ORACLE_IMPLEMENTATION) {
            revert NotApplied("implementation");
        }
        if (IOutputOracle(ORACLE).FINALIZATION_PERIOD_SECONDS() != wait) revert NotApplied("wait");
    }

    /// One entry of a MultiSend batch: a plain call to the ProxyAdmin with no value.
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
