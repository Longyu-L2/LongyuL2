// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ISafe} from "../script/Safes.sol";
import {
    IOutputOracle,
    IRollupProxyAdmin,
    SetWithdrawalWait,
    WithdrawalWaitSetter
} from "../script/SetWithdrawalWait.s.sol";

interface IPortal {
    function l2Oracle() external view returns (address);
    function isOutputFinalized(uint256 l2OutputIndex) external view returns (bool);
}

interface IOutputs {
    struct OutputProposal {
        bytes32 outputRoot;
        uint128 timestamp;
        uint128 l2BlockNumber;
    }

    function getL2Output(uint256 l2OutputIndex) external view returns (OutputProposal memory);
    function SUBMISSION_INTERVAL() external view returns (uint256);
    function L2_BLOCK_TIME() external view returns (uint256);
    function CHALLENGER() external view returns (address);
    function PROPOSER() external view returns (address);
    function startingTimestamp() external view returns (uint256);
    function nextBlockNumber() external view returns (uint256);
}

/// Holds ten filled storage slots and runs a setter on them the way a proxy does.
contract TenSlots {
    constructor() {
        for (uint256 i = 0; i < 10; ++i) {
            assembly {
                sstore(i, add(i, 100))
            }
        }
    }

    function run(address implementation, bytes calldata data) external {
        (bool ok,) = implementation.delegatecall(data);
        require(ok);
    }
}

contract WithdrawalWaitTest is Test {
    address internal constant PORTAL = 0xB1ba2E8af7137c607987F1c8d89c0f8b0c7D2623;
    string internal bscRpc = vm.envOr("BSC_TESTNET_RPC", string(""));

    modifier onBsc() {
        if (bytes(bscRpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(bscRpc);
        _;
    }

    function test_TheSetterWritesOnlyTheWaitSlot() public {
        TenSlots proxy = new TenSlots();
        WithdrawalWaitSetter setter = new WithdrawalWaitSetter(600);
        proxy.run(address(setter), abi.encodeCall(WithdrawalWaitSetter.set, ()));
        for (uint256 i = 0; i < 12; ++i) {
            uint256 expected = i == 8 ? 600 : i < 10 ? i + 100 : 0;
            assertEq(uint256(vm.load(address(proxy), bytes32(i))), expected);
        }
        // Called directly it touches nothing but itself.
        setter.set();
        assertEq(uint256(vm.load(address(setter), bytes32(uint256(8)))), 600);
    }

    function test_RefusesAnotherChainAndAWaitOutOfRange() public {
        SetWithdrawalWait script = new SetWithdrawalWait();
        vm.expectRevert(SetWithdrawalWait.NotBscTestnet.selector);
        script.setWait(600);
        vm.chainId(97);
        vm.expectRevert(abi.encodeWithSelector(SetWithdrawalWait.WaitOutOfRange.selector, 299));
        script.setWait(299);
        vm.expectRevert(abi.encodeWithSelector(SetWithdrawalWait.WaitOutOfRange.selector, 7 days + 1));
        script.setWait(7 days + 1);
    }

    // ---- BSC testnet ----

    /// Rehearses the change on a copy of BSC testnet:
    ///   BSC_TESTNET_RPC=... forge test --match-contract WithdrawalWaitTest
    function test_Bsc_TheWaitChangesAndNothingElse() public onBsc {
        SetWithdrawalWait script = new SetWithdrawalWait();
        IOutputOracle oracle = IOutputOracle(script.ORACLE());
        IOutputs outputs = IOutputs(script.ORACLE());
        ISafe safe = script.SAFE();
        assertEq(IPortal(PORTAL).l2Oracle(), address(oracle));

        uint256 latest = oracle.latestOutputIndex();
        IOutputs.OutputProposal memory top = outputs.getL2Output(latest);
        IOutputs.OutputProposal memory old = outputs.getL2Output(latest - 8);
        bytes memory settings = _settings(outputs);
        uint256 safeNonce = safe.nonce();
        uint256 wait = oracle.FINALIZATION_PERIOD_SECONDS() == 600 ? 900 : 600;
        // An output two hours old still waits under the old setting.
        if (oracle.FINALIZATION_PERIOD_SECONDS() > 3 hours) {
            assertFalse(IPortal(PORTAL).isOutputFinalized(latest - 8));
        }

        script.setWait(wait);

        assertEq(oracle.FINALIZATION_PERIOD_SECONDS(), wait);
        assertEq(script.PROXY_ADMIN().getProxyImplementation(address(oracle)), script.ORACLE_IMPLEMENTATION());
        assertEq(oracle.version(), "1.8.0");
        assertEq(oracle.latestOutputIndex(), latest);
        assertEq(abi.encode(outputs.getL2Output(latest)), abi.encode(top));
        assertEq(abi.encode(outputs.getL2Output(latest - 8)), abi.encode(old));
        assertEq(_settings(outputs), settings);
        assertEq(safe.nonce(), safeNonce + 1);
        script.check(wait);

        // The portal follows at once: the old output is final, the newest one when its own wait is over.
        assertTrue(IPortal(PORTAL).isOutputFinalized(latest - 8));
        vm.warp(uint256(top.timestamp) + wait);
        assertFalse(IPortal(PORTAL).isOutputFinalized(latest));
        vm.warp(uint256(top.timestamp) + wait + 1);
        assertTrue(IPortal(PORTAL).isOutputFinalized(latest));

        // The proposer still posts the next output.
        uint256 next = outputs.nextBlockNumber();
        vm.warp(outputs.startingTimestamp() + next * outputs.L2_BLOCK_TIME() + 1);
        vm.prank(outputs.PROPOSER());
        (bool posted,) = address(oracle)
            .call(
                abi.encodeWithSignature(
                    "proposeL2Output(bytes32,uint256,bytes32,uint256)", keccak256("root"), next, bytes32(0), 0
                )
            );
        assertTrue(posted);
        assertEq(oracle.latestOutputIndex(), latest + 1);
    }

    function test_Bsc_OnlyTheSafeCanMoveTheOracle() public onBsc {
        SetWithdrawalWait script = new SetWithdrawalWait();
        address setter = address(new WithdrawalWaitSetter(600));
        IRollupProxyAdmin proxyAdmin = script.PROXY_ADMIN();
        address payable oracle = script.ORACLE();
        address adminKey = script.SAFE().getOwners()[0];
        vm.prank(adminKey);
        vm.expectRevert();
        proxyAdmin.upgrade(oracle, setter);
        // Anyone else calling the setter's function on the oracle reaches the oracle, which has no such function.
        vm.prank(makeAddr("stranger"));
        (bool ok,) = oracle.call(abi.encodeCall(WithdrawalWaitSetter.set, ()));
        assertFalse(ok);
        assertEq(proxyAdmin.getProxyImplementation(oracle), script.ORACLE_IMPLEMENTATION());
    }

    function _settings(IOutputs o) internal view returns (bytes memory) {
        return abi.encode(
            o.SUBMISSION_INTERVAL(), o.L2_BLOCK_TIME(), o.CHALLENGER(), o.PROPOSER(), o.startingTimestamp()
        );
    }
}
