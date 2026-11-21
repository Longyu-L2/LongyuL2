// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";
import {LongMiningToken} from "../src/LongMiningToken.sol";
import {MintingVault} from "../src/MintingVault.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";

/// @notice LONGYU mainnet: deploys LONG (supply 0, created only by mining, locked until the TGE), its
///         emission schedule, the minting vault and the distributor, and hands every admin power to the
///         timelock. The deploying key keeps nothing.
/// @dev Environment (amounts in wei; no defaults for the numbers the founders decide):
///      TIMELOCK            the timelock on LONGYU (HandoverMainnetLongyu.s.sol): admin of all four
///                          contracts and the only account that creates the TGE allocations
///      SAFE                the founders' Safe on LONGYU: guardian (pause and veto)
///      WATCH, WATCHTOWER   the API's watch key and the watchtower's guardian key: guardians too
///      PUBLISHER           the key that posts the daily roots
///      START_TIME          UTC midnight of mining day 0: today's, or one within the next 30 days
///      POOL                everything mining can ever create (the rest of the 10 billion is for the TGE)
///      DAILY_BUDGET, PERIOD_DAYS, DECAY_BPS   the emission schedule
///      UNLOCK_DEADLINE     the latest moment LONG unlocks by itself (at most three years ahead)
///      MAX_PER_DAY         per-account bound, default 90 LONG
///      MAX_DAILY_INCREASE  growth cap per day, default twice the daily budget
contract DeployMainnetMining is Script {
    uint256 public constant LONGYU_MAINNET = 668800;

    struct Params {
        address timelock;
        address safe;
        address watch;
        address watchtower;
        address publisher;
        uint256 start;
        uint256 pool;
        uint256 daily;
        uint256 periodDays;
        uint256 decayBps;
        uint64 unlockDeadline;
        uint256 maxPerDay;
        uint256 maxIncrease;
    }

    struct Deployment {
        LongMiningToken long;
        EmissionSchedule schedule;
        MintingVault vault;
        MiningDistributor distributor;
    }

    error NotLongyuMainnet();
    error SenderRequired();
    error StartTimeOutOfRange(uint256 start);
    error SameKey(string what);
    error NotHandedOver(string what);

    function run() external returns (Deployment memory d) {
        if (msg.sender == DEFAULT_SENDER) revert SenderRequired();
        uint256 daily = vm.envUint("DAILY_BUDGET");
        Params memory p = Params({
            timelock: vm.envAddress("TIMELOCK"),
            safe: vm.envAddress("SAFE"),
            watch: vm.envAddress("WATCH"),
            watchtower: vm.envAddress("WATCHTOWER"),
            publisher: vm.envAddress("PUBLISHER"),
            start: vm.envUint("START_TIME"),
            pool: vm.envUint("POOL"),
            daily: daily,
            periodDays: vm.envUint("PERIOD_DAYS"),
            decayBps: vm.envUint("DECAY_BPS"),
            unlockDeadline: SafeCast.toUint64(vm.envUint("UNLOCK_DEADLINE")),
            maxPerDay: vm.envOr("MAX_PER_DAY", uint256(90e18)),
            maxIncrease: vm.envOr("MAX_DAILY_INCREASE", 2 * daily)
        });
        vm.startBroadcast();
        d = deploy(msg.sender, p);
        vm.stopBroadcast();
        console2.log("LONG             ", address(d.long));
        console2.log("EmissionSchedule ", address(d.schedule));
        console2.log("MintingVault     ", address(d.vault));
        console2.log("MiningDistributor", address(d.distributor));
    }

    function deploy(address deployer, Params memory p) public returns (Deployment memory d) {
        if (block.chainid != LONGYU_MAINNET) revert NotLongyuMainnet();
        if (p.start > block.timestamp + 30 days || p.start + 1 days <= block.timestamp) revert StartTimeOutOfRange(p.start);
        // The timelock is one the Safe runs, with a delay of a day at least; none of the roles may be
        // the deploying key.
        if (p.timelock.code.length == 0) revert NotHandedOver("timelock has no code");
        if (p.safe.code.length == 0) revert NotHandedOver("Safe has no code");
        TimelockController t = TimelockController(payable(p.timelock));
        if (t.getMinDelay() < 1 days) revert NotHandedOver("timelock delay under a day");
        if (!t.hasRole(t.PROPOSER_ROLE(), p.safe) || t.hasRole(t.PROPOSER_ROLE(), deployer)) {
            revert NotHandedOver("timelock proposer");
        }
        address[5] memory keys = [p.timelock, p.safe, p.watch, p.watchtower, p.publisher];
        for (uint256 i = 0; i < keys.length; ++i) {
            if (keys[i] == deployer) revert SameKey("a role is the deploying key");
            for (uint256 j = 0; j < i; ++j) {
                if (keys[i] == keys[j]) revert SameKey("two roles share an address");
            }
        }

        d.schedule = new EmissionSchedule(p.start, p.daily, p.periodDays, p.decayBps, p.pool);
        d.long = new LongMiningToken(deployer, d.schedule, p.unlockDeadline);
        d.vault = new MintingVault(address(d.long), d.schedule, deployer);
        d.distributor = new MiningDistributor(
            address(d.long), d.schedule, p.maxPerDay, 12 hours, p.maxIncrease, deployer, p.publisher, p.safe, address(0)
        );

        d.long.setMiningMinter(address(d.vault));
        d.vault.setDistributor(address(d.distributor));
        d.distributor.setVault(d.vault);
        bytes32 guardianRole = d.distributor.GUARDIAN_ROLE();
        d.distributor.grantRole(guardianRole, p.watch);
        d.distributor.grantRole(guardianRole, p.watchtower);
        d.long.grantRole(d.long.ALLOCATOR_ROLE(), p.timelock);

        bytes32 admin = d.long.DEFAULT_ADMIN_ROLE();
        d.long.grantRole(admin, p.timelock);
        d.vault.grantRole(admin, p.timelock);
        d.distributor.grantRole(admin, p.timelock);
        d.long.renounceRole(admin, deployer);
        d.vault.renounceRole(admin, deployer);
        d.distributor.renounceRole(admin, deployer);
        check(d, p, deployer);
    }

    function check(Deployment memory d, Params memory p, address deployer) public view {
        bytes32 admin = d.long.DEFAULT_ADMIN_ROLE();
        if (d.long.totalSupply() != 0) revert NotHandedOver("LONG supply is not zero");
        if (d.long.miningCap() != d.schedule.totalCap()) revert NotHandedOver("mining cap is not the schedule's pool");
        if (d.long.miningMinter() != address(d.vault)) revert NotHandedOver("minter");
        if (!d.long.isMiningContract(address(d.vault)) || !d.long.isMiningContract(address(d.distributor))) {
            revert NotHandedOver("mining contracts");
        }
        if (d.long.unlockDeadline() != p.unlockDeadline || d.long.isUnlocked()) revert NotHandedOver("unlock date");
        if (address(d.long.schedule()) != address(d.schedule)) revert NotHandedOver("token schedule");
        if (address(d.vault.schedule()) != address(d.schedule) || address(d.distributor.schedule()) != address(d.schedule)) {
            revert NotHandedOver("schedule");
        }
        if (d.vault.distributor() != address(d.distributor) || address(d.distributor.vault()) != address(d.vault)) {
            revert NotHandedOver("vault wiring");
        }
        if (!d.long.hasRole(admin, p.timelock) || !d.vault.hasRole(admin, p.timelock) || !d.distributor.hasRole(admin, p.timelock)) {
            revert NotHandedOver("timelock admin");
        }
        if (d.long.hasRole(admin, deployer) || d.vault.hasRole(admin, deployer) || d.distributor.hasRole(admin, deployer)) {
            revert NotHandedOver("deployer still admin");
        }
        if (!d.long.hasRole(d.long.ALLOCATOR_ROLE(), p.timelock) || d.long.hasRole(d.long.ALLOCATOR_ROLE(), deployer)) {
            revert NotHandedOver("allocator");
        }
        bytes32 g = d.distributor.GUARDIAN_ROLE();
        if (!d.distributor.hasRole(g, p.safe) || !d.distributor.hasRole(g, p.watch) || !d.distributor.hasRole(g, p.watchtower)) {
            revert NotHandedOver("guardians");
        }
        if (d.distributor.hasRole(g, deployer)) revert NotHandedOver("deployer is a guardian");
        if (!d.distributor.hasRole(d.distributor.PUBLISHER_ROLE(), p.publisher)) revert NotHandedOver("publisher");
    }
}
