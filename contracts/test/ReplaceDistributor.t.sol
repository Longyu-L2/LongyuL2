// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";
import {ReplaceDistributor} from "../script/ReplaceDistributor.s.sol";
import {Merkle} from "./utils/Merkle.sol";

/// Rehearses the distributor replacement on a copy of LONGYU testnet:
///   LONGYU_RPC=... CLAIMERS=0x..,0x.. PUBLISHER=0x.. ADMIN=0x.. forge test --match-contract ReplaceDistributorTest
contract ReplaceDistributorTest is Test {
    string internal longyuRpc = vm.envOr("LONGYU_RPC", string(""));
    address[] internal who;
    uint256[] internal amount;
    uint256[] internal owed;

    function test_Longyu_ReplacesAndPaysWhatIsOwed() public {
        if (bytes(longyuRpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(longyuRpc);
        ReplaceDistributor script = new ReplaceDistributor();
        MiningDistributor old = script.OLD();
        address[] memory claimers = vm.envAddress("CLAIMERS", ",");
        address publisher = vm.envAddress("PUBLISHER");
        address admin = vm.envAddress("ADMIN");
        uint256 vaultReleased = script.VAULT().released();
        uint256 claimedBefore = old.totalClaimed();

        MiningDistributor next = script.replace(claimers, publisher, admin);

        // Nothing goes through the old one any more, and the replacement cannot run twice.
        uint64 nextDay = old.activeRoot().day + 1;
        vm.prank(publisher);
        vm.expectRevert();
        old.proposeRoot(nextDay, keccak256("x"), claimedBefore, bytes32(0), "");
        vm.expectRevert();
        script.replace(claimers, publisher, admin);

        // The engine's next root on the new distributor: every claimer is owed 10 more, a newcomer 7.
        for (uint256 i; i < claimers.length; ++i) {
            _add(claimers[i], old.claimed(claimers[i]) + 10e18, 10e18);
        }
        _add(makeAddr("newcomer"), 7e18, 7e18);
        bytes32[] memory leaves = _leaves(next);
        uint256 total = _sum(amount);
        // What the old roots entitled beyond this stays in the total, as the engine's reserve keeps it.
        if (total < old.activeTotalEntitled()) total = old.activeTotalEntitled();
        uint64 closedDay = uint64(next.schedule().currentDay() - 1);
        vm.prank(publisher);
        next.proposeRoot(closedDay, Merkle.root(leaves), total, bytes32(0), "");
        vm.warp(block.timestamp + next.challengeDelay());

        _claimAll(next, leaves);
        assertEq(next.totalClaimed(), claimedBefore + _sum(owed));
        // The vault sent only what the new root added; the float carried over covered the rest.
        assertEq(script.VAULT().released(), total > vaultReleased ? total : vaultReleased);
        assertEq(IERC20(next.asset()).balanceOf(address(next)), total - next.totalClaimed());
    }

    function _add(address account, uint256 cumulative, uint256 due) internal {
        who.push(account);
        amount.push(cumulative);
        owed.push(due);
    }

    function _leaves(MiningDistributor d) internal view returns (bytes32[] memory leaves) {
        leaves = new bytes32[](who.length);
        for (uint256 i; i < who.length; ++i) {
            leaves[i] = d.leaf(who[i], amount[i]);
        }
    }

    function _sum(uint256[] storage values) internal view returns (uint256 s) {
        for (uint256 i; i < values.length; ++i) {
            s += values[i];
        }
    }

    function _claimAll(MiningDistributor d, bytes32[] memory leaves) internal {
        IERC20 asset = IERC20(d.asset());
        for (uint256 i; i < who.length; ++i) {
            uint256 before = asset.balanceOf(who[i]);
            assertEq(d.claim(who[i], amount[i], Merkle.proof(leaves, i)), owed[i]);
            assertEq(asset.balanceOf(who[i]) - before, owed[i]);
        }
    }
}
