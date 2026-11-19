// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {LongToken} from "../src/LongToken.sol";

/// @notice Mints the fixed 10 billion $LONG supply on BNB Smart Chain and splits it exactly as in
///         the tokenomics proposal. Vesting uses OpenZeppelin VestingWallet:
///         a wallet with start S and duration D releases linearly from S to S + D, so a
///         "12-month cliff, then linear over 36 months" is a wallet starting at TGE + 12 months.
/// @dev Environment: TGE_TIME (unix time, no more than a day ago or two years ahead) and one recipient
///      per bucket (normally a multisig):
///      MINING_RESERVE, MIGRATION_OPS, ECOSYSTEM, TEAM, TREASURY, BACKERS, NETWORK, LIQUIDITY.
///      The script only runs on BNB Smart Chain, so a wrong RPC address cannot mint the supply on
///      another chain. With --ledger or --account, also pass --sender with the signing address.
contract AllocateLong is Script {
    uint256 public constant TOTAL = 10_000_000_000e18;
    uint64 public constant MONTH = 30 days;
    uint256 public constant BSC = 56;

    struct Recipients {
        address miningReserve;
        address migrationOps;
        address ecosystem;
        address team;
        address treasury;
        address backers;
        address network;
        address liquidity;
    }

    struct Allocation {
        LongToken token;
        VestingWallet ecosystemVesting;
        VestingWallet teamVesting;
        VestingWallet treasuryVesting;
        VestingWallet backersVesting;
        VestingWallet networkVesting;
        VestingWallet liquidityVesting;
    }

    function run() external returns (Allocation memory a) {
        // A hardware wallet or keystore signs the transactions but, without --sender, msg.sender here
        // is forge's default address: the supply would be minted to an address that is not the holder.
        require(msg.sender != DEFAULT_SENDER, "sender required");
        Recipients memory r = Recipients({
            miningReserve: vm.envAddress("MINING_RESERVE"),
            migrationOps: vm.envAddress("MIGRATION_OPS"),
            ecosystem: vm.envAddress("ECOSYSTEM"),
            team: vm.envAddress("TEAM"),
            treasury: vm.envAddress("TREASURY"),
            backers: vm.envAddress("BACKERS"),
            network: vm.envAddress("NETWORK"),
            liquidity: vm.envAddress("LIQUIDITY")
        });
        uint256 tge = vm.envUint("TGE_TIME");
        vm.startBroadcast();
        a = allocate(r, tge, msg.sender);
        vm.stopBroadcast();
        console2.log("LongToken", address(a.token));
    }

    /// @param tgeTime Unix time of the token launch, which every vesting schedule counts from.
    /// @param holder The account that makes the transfers: the broadcaster in `run`, the caller in tests.
    function allocate(Recipients memory r, uint256 tgeTime, address holder)
        public
        returns (Allocation memory a)
    {
        require(block.chainid == BSC, "not BNB Smart Chain");
        // The vesting wallets keep 64-bit times that can never be changed. Cut to 64 bits or mistyped,
        // the launch time would unlock every bucket at once or lock them far too long.
        require(tgeTime <= type(uint64).max, "TGE time does not fit 64 bits");
        require(tgeTime <= block.timestamp + 730 days, "TGE time more than two years ahead");
        require(tgeTime + 1 days >= block.timestamp, "TGE time more than a day ago");
        uint64 tge = uint64(tgeTime);

        a.token = new LongToken("LONGYU", "LONG", TOTAL, holder);

        // Community mining: 5% testnet migration + 35% mainnet mining. Released to the L2 over time.
        _send(a.token, r.migrationOps, 500_000_000e18);
        _send(a.token, r.miningReserve, 3_500_000_000e18);

        // Ecosystem 15%: 100M at TGE, 1.4B linear over 48 months.
        _send(a.token, r.ecosystem, 100_000_000e18);
        a.ecosystemVesting = _vest(a.token, r.ecosystem, tge, 48 * MONTH, 1_400_000_000e18);

        // Team 15%: 12-month cliff, then linear over 36 months.
        a.teamVesting = _vest(a.token, r.team, tge + 12 * MONTH, 36 * MONTH, 1_500_000_000e18);

        // Treasury 12%: locked 12 months, then linear over 48 months.
        a.treasuryVesting = _vest(a.token, r.treasury, tge + 12 * MONTH, 48 * MONTH, 1_200_000_000e18);

        // Backers 8%: 12-month cliff, then linear over 24 months.
        a.backersVesting = _vest(a.token, r.backers, tge + 12 * MONTH, 24 * MONTH, 800_000_000e18);

        // Network incentives 5%: locked 24 months, then linear over 60 months.
        a.networkVesting = _vest(a.token, r.network, tge + 24 * MONTH, 60 * MONTH, 500_000_000e18);

        // Liquidity 5%: 200M at TGE, 300M linear over 24 months.
        _send(a.token, r.liquidity, 200_000_000e18);
        a.liquidityVesting = _vest(a.token, r.liquidity, tge, 24 * MONTH, 300_000_000e18);

        require(a.token.balanceOf(holder) == 0, "allocation incomplete");
    }

    function _send(LongToken token, address to, uint256 amount) internal {
        require(to != address(0), "zero recipient");
        token.transfer(to, amount);
    }

    function _vest(LongToken token, address beneficiary, uint64 start, uint64 duration, uint256 amount)
        internal
        returns (VestingWallet w)
    {
        require(beneficiary != address(0), "zero beneficiary");
        w = new VestingWallet(beneficiary, start, duration);
        token.transfer(address(w), amount);
    }
}
