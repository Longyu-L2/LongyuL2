// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {LongToken} from "../src/LongToken.sol";
import {Safes} from "./Safes.sol";

/// @notice Mints the fixed 10 billion $LONG supply on BNB Smart Chain, all of it to the treasury Safe.
///         Nothing is split at launch (founders' decision, 21 November 2026): the mining vault is funded
///         from the treasury as mining needs, and the other allocations are made later from it, with
///         vesting (AllocateLong.s.sol has a split, for then). The token has no mint function, so this
///         is the whole supply for good.
/// @dev Environment: TREASURY (a Safe v1.3.0 that needs at least two signatures). The sending key gets
///      nothing and must not sign for the Safe. With --ledger or --account, also pass --sender.
contract LaunchLong is Script {
    uint256 public constant TOTAL = 10_000_000_000e18;
    uint256 public constant BSC = 56;

    error NotBsc();
    error SenderRequired();
    error NotLaunched(string what);

    function run() external returns (LongToken token) {
        // A hardware wallet or keystore signs but, without --sender, msg.sender here is forge's default
        // address: the check that the sending key is no signer would test that address instead.
        if (msg.sender == DEFAULT_SENDER) revert SenderRequired();
        address treasury = vm.envAddress("TREASURY");
        vm.startBroadcast();
        token = launch(treasury, msg.sender);
        vm.stopBroadcast();
        console2.log("LONG", address(token));
        console2.log("held by the treasury Safe", treasury);
    }

    function launch(address treasury, address sender) public returns (LongToken token) {
        if (block.chainid != BSC) revert NotBsc();
        // Nothing is minted to an address before it is known to be a multisig the sender cannot move.
        Safes.requireMultisig(treasury, sender);
        token = new LongToken("LONGYU", "LONG", TOTAL, treasury);
        check(token, treasury);
    }

    /// @notice Reverts unless `token` is LONG with its whole supply at the treasury. Run it against BSC
    ///         after broadcasting:
    ///         TOKEN=0x.. TREASURY=0x.. forge script script/LaunchLong.s.sol --sig "verify()" --rpc-url $BSC_RPC
    function verify() external view {
        check(LongToken(vm.envAddress("TOKEN")), vm.envAddress("TREASURY"));
    }

    function check(LongToken token, address treasury) public view {
        if (keccak256(bytes(token.name())) != keccak256("LONGYU")) revert NotLaunched("name");
        if (keccak256(bytes(token.symbol())) != keccak256("LONG")) revert NotLaunched("symbol");
        if (token.decimals() != 18) revert NotLaunched("decimals");
        if (token.totalSupply() != TOTAL) revert NotLaunched("supply");
        if (token.balanceOf(treasury) != TOTAL) revert NotLaunched("treasury balance");
    }
}
