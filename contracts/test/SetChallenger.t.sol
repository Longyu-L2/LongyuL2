// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChallengerSetter, IChallengedOracle, SetChallenger} from "../script/SetChallenger.s.sol";

interface IOracleOutputs {
    function deleteL2Outputs(uint256 l2OutputIndex) external;
    function finalizationPeriodSeconds() external view returns (uint256);
    function SUBMISSION_INTERVAL() external view returns (uint256);
    function L2_BLOCK_TIME() external view returns (uint256);
    function startingTimestamp() external view returns (uint256);
    function nextBlockNumber() external view returns (uint256);
}

/// Holds ten filled storage slots and runs a setter on them the way a proxy does.
contract FilledSlots {
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

contract SetChallengerTest is Test {
    string internal bscRpc = vm.envOr("BSC_TESTNET_RPC", string(""));

    modifier onBsc() {
        if (bytes(bscRpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(bscRpc);
        _;
    }

    function test_TheSetterWritesOnlyTheChallengerSlot() public {
        FilledSlots proxy = new FilledSlots();
        address challenger = makeAddr("challenger");
        ChallengerSetter setter = new ChallengerSetter(challenger);
        proxy.run(address(setter), abi.encodeCall(ChallengerSetter.set, ()));
        for (uint256 i = 0; i < 12; ++i) {
            uint256 expected = i == 6 ? uint256(uint160(challenger)) : i < 10 ? i + 100 : 0;
            assertEq(uint256(vm.load(address(proxy), bytes32(i))), expected);
        }
    }

    function test_RefusesAnotherChain() public {
        SetChallenger script = new SetChallenger();
        vm.expectRevert(SetChallenger.NotBscTestnet.selector);
        script.setChallenger(makeAddr("challenger"));
    }

    // ---- BSC testnet ----

    /// Rehearses the change on a copy of BSC testnet:
    ///   BSC_TESTNET_RPC=... forge test --match-contract SetChallengerTest
    function test_Bsc_TheNewKeyDeletesAndNothingElseMoves() public onBsc {
        SetChallenger script = new SetChallenger();
        IChallengedOracle oracle = IChallengedOracle(script.ORACLE());
        IOracleOutputs outputs = IOracleOutputs(script.ORACLE());
        address adminKey = script.SAFE().getOwners()[0];
        address proposer = oracle.proposer();
        address watchtower = makeAddr("watchtower challenger");
        bytes memory settings = abi.encode(
            outputs.SUBMISSION_INTERVAL(), outputs.L2_BLOCK_TIME(), outputs.startingTimestamp(),
            outputs.finalizationPeriodSeconds(), proposer
        );
        uint256 latest = oracle.latestOutputIndex();

        script.setChallenger(watchtower);

        assertEq(oracle.challenger(), watchtower);
        assertEq(oracle.version(), "1.8.0");
        assertEq(oracle.latestOutputIndex(), latest);
        assertEq(
            abi.encode(
                outputs.SUBMISSION_INTERVAL(), outputs.L2_BLOCK_TIME(), outputs.startingTimestamp(),
                outputs.finalizationPeriodSeconds(), oracle.proposer()
            ),
            settings
        );
        script.check(watchtower);

        // A new root, posted now: the admin key can no longer delete it; the watchtower's key can.
        uint256 next = outputs.nextBlockNumber();
        vm.warp(outputs.startingTimestamp() + next * outputs.L2_BLOCK_TIME() + 1);
        _propose(proposer, next, keccak256("wrong"));
        assertEq(oracle.latestOutputIndex(), latest + 1);
        vm.prank(adminKey);
        vm.expectRevert(bytes("L2OutputOracle: only the challenger address can delete outputs"));
        outputs.deleteL2Outputs(latest + 1);
        vm.prank(watchtower);
        outputs.deleteL2Outputs(latest + 1);
        assertEq(oracle.latestOutputIndex(), latest);

        // The proposer posts the deleted block again.
        assertEq(outputs.nextBlockNumber(), next);
        _propose(proposer, next, keccak256("right"));
        assertEq(oracle.latestOutputIndex(), latest + 1);

        // Once final, a root can no longer be deleted.
        vm.warp(block.timestamp + outputs.finalizationPeriodSeconds());
        vm.prank(watchtower);
        vm.expectRevert(bytes("L2OutputOracle: cannot delete outputs that have already been finalized"));
        outputs.deleteL2Outputs(latest + 1);
    }

    function _propose(address proposer, uint256 l2Block, bytes32 root) internal {
        vm.prank(proposer);
        (bool posted,) = oracleAddress()
            .call(
                abi.encodeWithSignature(
                    "proposeL2Output(bytes32,uint256,bytes32,uint256)", root, l2Block, bytes32(0), 0
                )
            );
        assertTrue(posted);
    }

    function oracleAddress() internal pure returns (address) {
        return 0x2dC53f20F511Bf079167Ef013d6107787E620fE3;
    }

    function test_Bsc_RefusesTheProposerTheAdminAndAContract() public onBsc {
        SetChallenger script = new SetChallenger();
        IChallengedOracle oracle = IChallengedOracle(script.ORACLE());
        address proposer = oracle.proposer();
        address current = oracle.challenger();
        address adminKey = script.SAFE().getOwners()[0];
        address multiSend = script.MULTI_SEND();
        vm.expectRevert(abi.encodeWithSelector(SetChallenger.BadChallenger.selector, proposer));
        script.setChallenger(proposer);
        vm.expectRevert(abi.encodeWithSelector(SetChallenger.BadChallenger.selector, current));
        script.setChallenger(current);
        vm.expectRevert(abi.encodeWithSelector(SetChallenger.BadChallenger.selector, adminKey));
        script.setChallenger(adminKey);
        vm.expectRevert(abi.encodeWithSelector(SetChallenger.BadChallenger.selector, multiSend));
        script.setChallenger(multiSend);
    }
}
