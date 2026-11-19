// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMining} from "../script/DeployMining.s.sol";
import {LongToken} from "../src/LongToken.sol";

contract DeployMiningTest is Test {
    address admin = makeAddr("multisig");
    address publisher = makeAddr("publisher");
    address guardian = makeAddr("guardian");

    function params(address asset) internal returns (DeployMining.Params memory) {
        return DeployMining.Params({
            admin: admin,
            publisher: publisher,
            guardian: guardian,
            faucetSigner: makeAddr("signer"),
            asset: asset,
            faucetAsset: address(0),
            start: 20_000 days,
            daily: 12_000_000e18,
            maxPerDay: 90e18,
            maxIncrease: 24_000_000e18,
            faucetMaxDrip: 0.001e18,
            faucetDailyCap: 0.05e18
        });
    }

    function test_DeployHandsAdminToMultisigAndRenounces() public {
        vm.warp(20_000 days + 1);
        // Stands in for the bridged tLONG on LONGYU.
        LongToken tlong = new LongToken("LONGYU Testnet Token", "tLONG", 1e27, address(this));
        DeployMining script = new DeployMining();
        DeployMining.Deployment memory d = script.deploy(address(script), params(address(tlong)));

        bytes32 adminRole = d.vault.DEFAULT_ADMIN_ROLE();
        assertTrue(d.vault.hasRole(adminRole, admin));
        assertTrue(d.distributor.hasRole(adminRole, admin));
        assertTrue(d.faucet.hasRole(adminRole, admin));
        assertFalse(d.vault.hasRole(adminRole, address(script)));
        assertFalse(d.distributor.hasRole(adminRole, address(script)));
        assertTrue(d.distributor.hasRole(d.distributor.PUBLISHER_ROLE(), publisher));
        assertTrue(d.distributor.hasRole(d.distributor.GUARDIAN_ROLE(), guardian));
        assertEq(d.vault.distributor(), address(d.distributor));
        assertEq(address(d.distributor.vault()), address(d.vault));

        // Rewards are paid in the token; the faucet drips native BNB for gas.
        assertEq(d.distributor.asset(), address(tlong));
        assertEq(d.vault.asset(), address(tlong));
        assertEq(d.faucet.asset(), address(0));
        assertEq(d.faucet.maxPerVoucher(), 0.001e18);
        assertEq(d.faucet.dailyCap(), 0.05e18);
    }

    function test_RunRefusesANativeOrMissingRewardToken() public {
        DeployMining script = new DeployMining();
        vm.setEnv("ADMIN", vm.toString(admin));
        vm.setEnv("PUBLISHER", vm.toString(publisher));
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("FAUCET_SIGNER", vm.toString(makeAddr("signer")));
        vm.setEnv("START_TIME", "1728000000");

        vm.setEnv("ASSET", vm.toString(address(0)));
        vm.expectRevert(DeployMining.RewardTokenRequired.selector);
        script.run();

        // An address without code: a typo, or a token that lives on another chain.
        vm.setEnv("ASSET", vm.toString(makeAddr("not a contract")));
        vm.expectRevert(DeployMining.RewardTokenRequired.selector);
        script.run();
    }

    function test_RunRefusesForgesDefaultSender() public {
        // What msg.sender is when a hardware wallet signs and --sender is not given.
        DeployMining script = new DeployMining();
        vm.expectRevert(DeployMining.SenderRequired.selector);
        vm.prank(DEFAULT_SENDER);
        script.run();
    }

    function test_DeployAcceptsDayZeroTodayOrWithinThirtyDays() public {
        LongToken tlong = new LongToken("LONGYU Testnet Token", "tLONG", 1e27, address(this));
        DeployMining script = new DeployMining();
        DeployMining.Params memory p = params(address(tlong));

        // The last second of day 0: deployed on the day mining starts, as the testnet was.
        vm.warp(p.start + 1 days - 1);
        DeployMining.Deployment memory d = script.deploy(address(script), p);
        assertEq(d.schedule.startTime(), p.start);
        assertEq(d.schedule.currentDay(), 0);

        // The next UTC midnight, and the furthest start allowed.
        vm.warp(p.start - 1 days + 1);
        script.deploy(address(script), p);
        vm.warp(p.start - 30 days);
        d = script.deploy(address(script), p);
        assertFalse(d.schedule.started());
    }

    function test_DeployRefusesAStartThatIsPastOrFarAhead() public {
        LongToken tlong = new LongToken("LONGYU Testnet Token", "tLONG", 1e27, address(this));
        DeployMining script = new DeployMining();
        DeployMining.Params memory p = params(address(tlong));
        bytes memory refused = abi.encodeWithSelector(DeployMining.StartTimeOutOfRange.selector, p.start);

        // Day 0 is over: the first root could already carry two days of budget.
        vm.warp(p.start + 1 days);
        vm.expectRevert(refused);
        script.deploy(address(script), p);

        vm.warp(p.start - 30 days - 1);
        vm.expectRevert(refused);
        script.deploy(address(script), p);

        // Zero is a UTC midnight too, and would open the whole pool on the first day.
        p.start = 0;
        vm.expectRevert(abi.encodeWithSelector(DeployMining.StartTimeOutOfRange.selector, 0));
        script.deploy(address(script), p);
    }
}
