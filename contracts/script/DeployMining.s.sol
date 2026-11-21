// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";
import {MiningVault} from "../src/MiningVault.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";
import {Faucet} from "../src/Faucet.sol";

/// @notice Deploys the mining contract set and hands every admin power to `ADMIN`.
/// @dev On LONGYU the gas token is BNB and rewards are paid in tLONG, the bridged copy of the BEP-20
///      on BSC (created on LONGYU by script/CreateL2Token.s.sol). Environment variables (addresses
///      must be set; amounts are in wei):
///      ADMIN            multisig or timelock that will own the contracts
///      PUBLISHER        backend key (KMS) that posts daily roots
///      GUARDIAN         multisig that can pause and veto
///      FAUCET_SIGNER    backend key (KMS) that signs faucet vouchers
///      ASSET            the reward token on LONGYU (bridged tLONG); must be a deployed contract
///      FAUCET_ASSET     what the faucet drips, default 0x0: native BNB for gas
///      START_TIME       UTC midnight of mining day 0: today's, or one within the next 30 days
///      DAILY_BUDGET     default 12,000,000 tLONG
///      MAX_PER_DAY      per-user bound, default 90 tLONG (every bonus and the +100% boost at cap: 85.56)
///      MAX_DAILY_INCREASE  growth cap per day, default 24,000,000 tLONG
///      FAUCET_MAX_DRIP  largest single drip, default 0.001 BNB
///      FAUCET_DAILY_CAP all drips in one day, default 0.05 BNB
///      The deployer is a temporary admin only long enough to wire the contracts, then renounces.
///      With --ledger or --account, also pass --sender with the signing address.
contract DeployMining is Script {
    error RewardTokenRequired();
    error SenderRequired();
    error StartTimeOutOfRange(uint256 start);

    struct Params {
        address admin;
        address publisher;
        address guardian;
        address faucetSigner;
        address asset;
        address faucetAsset;
        uint256 start;
        uint256 daily;
        uint256 maxPerDay;
        uint256 maxIncrease;
        uint256 faucetMaxDrip;
        uint256 faucetDailyCap;
    }

    struct Deployment {
        EmissionSchedule schedule;
        MiningVault vault;
        MiningDistributor distributor;
        Faucet faucet;
    }

    function run() external returns (Deployment memory d) {
        // A hardware wallet or keystore signs the transactions but, without --sender, msg.sender here
        // is forge's default address: the admin roles would go to an address that is not the deployer.
        if (msg.sender == DEFAULT_SENDER) revert SenderRequired();
        Params memory p = Params({
            admin: vm.envAddress("ADMIN"),
            publisher: vm.envAddress("PUBLISHER"),
            guardian: vm.envAddress("GUARDIAN"),
            faucetSigner: vm.envAddress("FAUCET_SIGNER"),
            asset: vm.envAddress("ASSET"),
            faucetAsset: vm.envOr("FAUCET_ASSET", address(0)),
            start: vm.envUint("START_TIME"),
            daily: vm.envOr("DAILY_BUDGET", uint256(12_000_000e18)),
            maxPerDay: vm.envOr("MAX_PER_DAY", uint256(90e18)),
            maxIncrease: vm.envOr("MAX_DAILY_INCREASE", uint256(24_000_000e18)),
            faucetMaxDrip: vm.envOr("FAUCET_MAX_DRIP", uint256(0.001e18)),
            faucetDailyCap: vm.envOr("FAUCET_DAILY_CAP", uint256(0.05e18))
        });
        // BNB is LONGYU's gas token, so a native reward asset would pay out gas: refuse it, and
        // refuse an address with no code (a typo or a token on the wrong chain).
        if (p.asset == address(0) || p.asset.code.length == 0) revert RewardTokenRequired();

        vm.startBroadcast();
        address deployer = msg.sender;
        d = deploy(deployer, p);
        vm.stopBroadcast();

        console2.log("EmissionSchedule ", address(d.schedule));
        console2.log("MiningVault      ", address(d.vault));
        console2.log("MiningDistributor", address(d.distributor));
        console2.log("Faucet           ", address(d.faucet));
    }

    function deploy(address deployer, Params memory p) public returns (Deployment memory d) {
        // Day 0 is fixed for good. Each day already behind it adds a daily budget and a day of the
        // growth cap to what the first root may carry, and a far-off day 0 leaves mining unable to
        // start: it is today at the earliest and 30 days ahead at the latest.
        if (p.start > block.timestamp + 30 days || p.start + 1 days <= block.timestamp) {
            revert StartTimeOutOfRange(p.start);
        }
        // Testnet pool: 4 billion tLONG; 30-day periods with no decay.
        d.schedule = new EmissionSchedule(p.start, p.daily, 30, 0, 4_000_000_000e18);
        d.vault = new MiningVault(p.asset, d.schedule, deployer);
        d.distributor = new MiningDistributor(
            p.asset,
            d.schedule,
            p.maxPerDay,
            12 hours,
            p.maxIncrease,
            deployer,
            p.publisher,
            p.guardian,
            address(0)
        );
        d.faucet = new Faucet(
            p.faucetAsset, p.admin, p.faucetSigner, p.guardian, p.faucetMaxDrip, 1 days, p.faucetDailyCap
        );

        d.vault.setDistributor(address(d.distributor));
        d.distributor.setVault(d.vault);

        bytes32 adminRole = d.vault.DEFAULT_ADMIN_ROLE();
        if (p.admin != deployer) {
            d.vault.grantRole(adminRole, p.admin);
            d.distributor.grantRole(adminRole, p.admin);
            d.vault.renounceRole(adminRole, deployer);
            d.distributor.renounceRole(adminRole, deployer);
        }
    }
}
