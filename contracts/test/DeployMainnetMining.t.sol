// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {DeployMainnetMining} from "../script/DeployMainnetMining.s.sol";

contract DeployMainnetMiningTest is Test {
    DeployMainnetMining script;
    address deployer = makeAddr("deployer");

    function setUp() public {
        vm.warp(20_000 days + 3 hours);
        script = new DeployMainnetMining();
    }

    function _params() internal returns (DeployMainnetMining.Params memory p) {
        address safe = makeAddr("safe");
        vm.etch(safe, hex"00");
        address[] memory founders = new address[](1);
        founders[0] = safe;
        TimelockController timelock = new TimelockController(2 days, founders, founders, address(0));
        p = DeployMainnetMining.Params({
            timelock: address(timelock),
            safe: safe,
            watch: makeAddr("watch"),
            watchtower: makeAddr("watchtower"),
            publisher: makeAddr("publisher"),
            start: 20_000 days,
            pool: 3_500_000_000e18,
            daily: 5_000_000e18,
            periodDays: 30,
            decayBps: 0,
            unlockDeadline: uint64(block.timestamp + 365 days),
            maxPerDay: 90e18,
            maxIncrease: 10_000_000e18
        });
    }

    function test_EverythingEndsWithTheTimelockAndNothingWithTheDeployer() public {
        vm.chainId(668800);
        DeployMainnetMining.Params memory p = _params();
        // In a test the script contract itself sends the calls, as the broadcasting key does in a run.
        DeployMainnetMining.Deployment memory d = script.deploy(address(script), p);
        script.check(d, p, address(script));
        assertEq(d.long.totalSupply(), 0);
        assertEq(d.long.miningCap(), 3_500_000_000e18);
        assertFalse(d.long.isUnlocked());
    }

    function test_RefusesAnotherChainSharedKeysAndPlainAddresses() public {
        DeployMainnetMining.Params memory p = _params();
        vm.expectRevert(DeployMainnetMining.NotLongyuMainnet.selector);
        script.deploy(deployer, p);
        vm.chainId(668800);
        p.watch = p.watchtower;
        vm.expectRevert(abi.encodeWithSelector(DeployMainnetMining.SameKey.selector, "two roles share an address"));
        script.deploy(deployer, p);
        p = _params();
        p.publisher = deployer;
        vm.expectRevert(abi.encodeWithSelector(DeployMainnetMining.SameKey.selector, "a role is the deploying key"));
        script.deploy(deployer, p);
        p = _params();
        p.timelock = makeAddr("plain key");
        vm.expectRevert(abi.encodeWithSelector(DeployMainnetMining.NotHandedOver.selector, "timelock has no code"));
        script.deploy(deployer, p);
        // A timelock someone else runs, or one with a short delay, is refused.
        p = _params();
        address[] memory others = new address[](1);
        others[0] = makeAddr("someone");
        p.timelock = address(new TimelockController(2 days, others, others, address(0)));
        vm.expectRevert(abi.encodeWithSelector(DeployMainnetMining.NotHandedOver.selector, "timelock proposer"));
        script.deploy(deployer, p);
        p = _params();
        others[0] = p.safe;
        p.timelock = address(new TimelockController(1 hours, others, others, address(0)));
        vm.expectRevert(abi.encodeWithSelector(DeployMainnetMining.NotHandedOver.selector, "timelock delay under a day"));
        script.deploy(deployer, p);
    }
}
