// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ISafe, IOwnable, Safes} from "./Safes.sol";
import {IMultiSend} from "./SetWithdrawalWait.s.sol";

interface IGuarded {
    function guardian() external view returns (address);
}

interface IMainnetOracle {
    function challenger() external view returns (address);
    function proposer() external view returns (address);
    function finalizationPeriodSeconds() external view returns (uint256);
}

/// @notice BSC: hands the rollup's upgrade rights from the deploying key to a timelock that only the
///         founders' Safe can use. Run once, right after chain/testnet/deploy-rollup.sh (MODE=bsc), with
///         the deploying key, the only signer of the SystemOwnerSafe that deployment created.
///         The founders' Safe already owns the system config and the protocol versions and holds the
///         guardian's pause (set at deployment). The rights that change contract code (ProxyAdmin), and
///         the two unused fault-proof contracts the deployment also created, move to the timelock: every
///         upgrade is announced on chain and waits TIMELOCK_DELAY before it can run, so users can leave
///         first. The SystemOwnerSafe owns nothing afterwards.
/// @dev Environment: SAFE (the founders' Safe on BSC), CHALLENGER (the watchtower's key), TIMELOCK_DELAY
///      (seconds, default 2 days), DEPLOYMENTS (default ../chain/mainnet/l1-deployments.json).
contract HandoverMainnetBsc is Script {
    /// Safe's MultiSendCallOnly v1.3.0, the same on BSC as on BSC testnet.
    address public constant MULTI_SEND = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant MAX_DELAY = 30 days;
    uint256 public constant WITHDRAWAL_WAIT = 1 hours;

    struct Rollup {
        address proxyAdmin;
        address systemOwnerSafe;
        address systemConfig;
        address protocolVersions;
        address superchainConfig;
        address oracle;
        address disputeGameFactory;
        address delayedWeth;
        address addressManager;
    }

    error NotBsc();
    error DelayOutOfRange(uint256 delay);
    error NotAsDeployed(string what);
    error HandoverIncomplete(string what);

    function run() external returns (TimelockController timelock) {
        Rollup memory r = load(vm.envOr("DEPLOYMENTS", string("../chain/mainnet/l1-deployments.json")));
        timelock = handOver(r, vm.envAddress("SAFE"), vm.envAddress("CHALLENGER"), vm.envOr("TIMELOCK_DELAY", uint256(2 days)));
        console2.log("Timelock", address(timelock));
    }

    function load(string memory path) public view returns (Rollup memory r) {
        string memory json = vm.readFile(path);
        r.proxyAdmin = vm.parseJsonAddress(json, ".ProxyAdmin");
        r.systemOwnerSafe = vm.parseJsonAddress(json, ".SystemOwnerSafe");
        r.systemConfig = vm.parseJsonAddress(json, ".SystemConfigProxy");
        r.protocolVersions = vm.parseJsonAddress(json, ".ProtocolVersionsProxy");
        r.superchainConfig = vm.parseJsonAddress(json, ".SuperchainConfigProxy");
        r.oracle = vm.parseJsonAddress(json, ".L2OutputOracleProxy");
        r.disputeGameFactory = vm.parseJsonAddress(json, ".DisputeGameFactoryProxy");
        r.delayedWeth = vm.parseJsonAddress(json, ".DelayedWETHProxy");
        r.addressManager = vm.parseJsonAddress(json, ".AddressManager");
    }

    function handOver(Rollup memory r, address safe, address challenger, uint256 delay)
        public
        returns (TimelockController timelock)
    {
        if (block.chainid != 56) revert NotBsc();
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert DelayOutOfRange(delay);
        ISafe owner = ISafe(r.systemOwnerSafe);
        address[] memory signers = owner.getOwners();
        if (signers.length != 1 || owner.getThreshold() != 1) revert NotAsDeployed("SystemOwnerSafe signers");
        address deployer = signers[0];
        Safes.requireMultisig(safe, deployer);
        _requireDeployed(r, safe, challenger, deployer);
        if (IOwnable(r.proxyAdmin).owner() != r.systemOwnerSafe) revert NotAsDeployed("ProxyAdmin owner");
        if (IOwnable(r.disputeGameFactory).owner() != r.systemOwnerSafe) revert NotAsDeployed("DisputeGameFactory owner");
        if (IOwnable(r.delayedWeth).owner() != r.systemOwnerSafe) revert NotAsDeployed("DelayedWETH owner");

        address[] memory founders = new address[](1);
        founders[0] = safe;
        vm.startBroadcast(deployer);
        // No admin: only the timelock itself, through a delayed proposal, can change its own roles.
        timelock = new TimelockController(delay, founders, founders, address(0));
        bytes memory calls = bytes.concat(
            _call(r.proxyAdmin, abi.encodeCall(IOwnable.transferOwnership, (address(timelock)))),
            _call(r.disputeGameFactory, abi.encodeCall(IOwnable.transferOwnership, (address(timelock)))),
            _call(r.delayedWeth, abi.encodeCall(IOwnable.transferOwnership, (address(timelock))))
        );
        // A Safe with one signer accepts a transaction that signer sends: r is the signer, v is 1.
        bool done = owner.execTransaction(
            MULTI_SEND,
            0,
            abi.encodeCall(IMultiSend.multiSend, (calls)),
            1,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            abi.encodePacked(uint256(uint160(deployer)), uint256(0), uint8(1))
        );
        vm.stopBroadcast();
        if (!done) revert HandoverIncomplete("Safe transaction");
        check(r, safe, challenger, timelock, delay, deployer);
    }

    /// @notice Reverts unless the handover is complete. Run it against BSC after broadcasting:
    ///         SAFE=.. CHALLENGER=.. TIMELOCK=.. forge script script/HandoverMainnetBsc.s.sol --sig "verify()" --rpc-url $BSC_RPC
    function verify() external view {
        Rollup memory r = load(vm.envOr("DEPLOYMENTS", string("../chain/mainnet/l1-deployments.json")));
        address deployer = ISafe(r.systemOwnerSafe).getOwners()[0];
        check(
            r,
            vm.envAddress("SAFE"),
            vm.envAddress("CHALLENGER"),
            TimelockController(payable(vm.envAddress("TIMELOCK"))),
            vm.envOr("TIMELOCK_DELAY", uint256(2 days)),
            deployer
        );
    }

    function check(
        Rollup memory r,
        address safe,
        address challenger,
        TimelockController timelock,
        uint256 delay,
        address deployer
    ) public view {
        _requireDeployed(r, safe, challenger, deployer);
        if (IOwnable(r.proxyAdmin).owner() != address(timelock)) revert HandoverIncomplete("ProxyAdmin owner");
        if (IOwnable(r.disputeGameFactory).owner() != address(timelock)) {
            revert HandoverIncomplete("DisputeGameFactory owner");
        }
        if (IOwnable(r.delayedWeth).owner() != address(timelock)) revert HandoverIncomplete("DelayedWETH owner");
        if (timelock.getMinDelay() != delay) revert HandoverIncomplete("timelock delay");
        bytes32[3] memory roles = [timelock.PROPOSER_ROLE(), timelock.EXECUTOR_ROLE(), timelock.CANCELLER_ROLE()];
        for (uint256 i = 0; i < roles.length; ++i) {
            if (!timelock.hasRole(roles[i], safe)) revert HandoverIncomplete("Safe's timelock role");
            if (timelock.hasRole(roles[i], deployer)) revert HandoverIncomplete("deployer holds a timelock role");
            // address(0) holding the executor role would let anyone run a proposal once it is ready.
            if (timelock.hasRole(roles[i], address(0))) revert HandoverIncomplete("open timelock role");
        }
        bytes32 admin = timelock.DEFAULT_ADMIN_ROLE();
        if (!timelock.hasRole(admin, address(timelock))) revert HandoverIncomplete("timelock self-administration");
        if (timelock.hasRole(admin, deployer) || timelock.hasRole(admin, safe)) {
            revert HandoverIncomplete("timelock has an admin");
        }
    }

    /// What the deployment itself set: the founders' Safe owns and guards, the challenger is the
    /// watchtower's own key, and withdrawals wait one hour.
    function _requireDeployed(Rollup memory r, address safe, address challenger, address deployer) internal view {
        // The messenger's address book: owned by the ProxyAdmin, so it changes only through the timelock.
        if (IOwnable(r.addressManager).owner() != r.proxyAdmin) revert NotAsDeployed("AddressManager owner");
        if (IOwnable(r.systemConfig).owner() != safe) revert NotAsDeployed("SystemConfig owner");
        if (IOwnable(r.protocolVersions).owner() != safe) revert NotAsDeployed("ProtocolVersions owner");
        if (IGuarded(r.superchainConfig).guardian() != safe) revert NotAsDeployed("guardian");
        IMainnetOracle oracle = IMainnetOracle(r.oracle);
        if (oracle.challenger() != challenger || challenger == deployer || challenger == oracle.proposer()) {
            revert NotAsDeployed("challenger");
        }
        if (oracle.finalizationPeriodSeconds() != WITHDRAWAL_WAIT) revert NotAsDeployed("withdrawal wait");
    }

    /// One call in MultiSend's packed format: operation (0 = call), target, value, data length, data.
    function _call(address to, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, uint256(0), data.length, data);
    }
}
