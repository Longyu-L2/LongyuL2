// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {HandoverMainnetLongyu} from "../script/HandoverMainnetLongyu.s.sol";
import {HandoverMainnetBsc} from "../script/HandoverMainnetBsc.s.sol";
import {CreateSafe} from "../script/CreateSafe.s.sol";
import {IOwnable, Safes} from "../script/Safes.sol";

/// The LONGYU handover, rehearsed on a fork of LONGYU testnet presented as mainnet: the genesis contracts
/// and Safe's contracts are at the same addresses on both. The BSC handover runs in chain/mainnet/rehearse.sh
/// against a full rollup deployment on a fork of BSC.
contract HandoverMainnetTest is Test {
    string internal longyuRpc = vm.envOr("LONGYU_TESTNET_RPC", string(""));
    IOwnable internal constant PROXY_ADMIN = IOwnable(0x4200000000000000000000000000000000000018);

    modifier onLongyu() {
        if (bytes(longyuRpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(longyuRpc);
        vm.chainId(668800);
        _;
    }

    function _safe(uint256 salt) internal returns (address) {
        address[] memory owners = new address[](3);
        owners[0] = makeAddr("signer 1");
        owners[1] = makeAddr("signer 2");
        owners[2] = makeAddr("signer 3");
        return new CreateSafe().create(owners, 2, salt, makeAddr("sender"));
    }

    function test_RefusesAnotherChainAndADelayOutOfRange() public {
        HandoverMainnetLongyu script = new HandoverMainnetLongyu();
        vm.expectRevert(HandoverMainnetLongyu.NotLongyuMainnet.selector);
        script.handOver(makeAddr("safe"), 2 days, address(this));
        vm.chainId(668800);
        vm.expectRevert(abi.encodeWithSelector(HandoverMainnetLongyu.DelayOutOfRange.selector, 1 hours));
        script.handOver(makeAddr("safe"), 1 hours, address(this));
        HandoverMainnetBsc bsc = new HandoverMainnetBsc();
        HandoverMainnetBsc.Rollup memory r;
        vm.expectRevert(HandoverMainnetBsc.NotBsc.selector);
        bsc.handOver(r, makeAddr("safe"), makeAddr("challenger"), 2 days);
    }

    function test_Longyu_UpgradesWaitForTheTimelockAndOnlyTheSafeMovesThem() public onLongyu {
        address safe = _safe(7);
        address deployer = PROXY_ADMIN.owner();
        HandoverMainnetLongyu script = new HandoverMainnetLongyu();
        TimelockController timelock = script.handOver(safe, 2 days, deployer);
        assertEq(PROXY_ADMIN.owner(), address(timelock));
        script.check(safe, timelock, 2 days, deployer);

        // The deploying key has nothing left.
        vm.prank(deployer);
        vm.expectRevert();
        PROXY_ADMIN.transferOwnership(deployer);
        bytes memory call = abi.encodeCall(IOwnable.transferOwnership, (makeAddr("next owner")));
        bytes32 proposer = timelock.PROPOSER_ROLE();
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, proposer));
        timelock.schedule(address(PROXY_ADMIN), 0, call, bytes32(0), bytes32(0), 2 days);

        // The Safe announces a change; it can run only after the delay.
        vm.prank(safe);
        timelock.schedule(address(PROXY_ADMIN), 0, call, bytes32(0), bytes32(0), 2 days);
        vm.warp(block.timestamp + 2 days - 1);
        vm.prank(safe);
        vm.expectRevert();
        timelock.execute(address(PROXY_ADMIN), 0, call, bytes32(0), bytes32(0));
        vm.warp(block.timestamp + 1);
        vm.prank(safe);
        timelock.execute(address(PROXY_ADMIN), 0, call, bytes32(0), bytes32(0));
        assertEq(PROXY_ADMIN.owner(), makeAddr("next owner"));
    }

    function test_Longyu_RefusesAPlainKeyAsTheSafe() public onLongyu {
        HandoverMainnetLongyu script = new HandoverMainnetLongyu();
        address deployer = PROXY_ADMIN.owner();
        address key = makeAddr("plain key");
        vm.expectRevert(abi.encodeWithSelector(Safes.NotASafe.selector, key));
        script.handOver(key, 2 days, deployer);
    }
}
