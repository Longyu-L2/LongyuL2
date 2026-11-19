// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EmissionSchedule} from "../src/EmissionSchedule.sol";
import {MiningVault} from "../src/MiningVault.sol";
import {MiningDistributor} from "../src/MiningDistributor.sol";

/// @notice Posts a root produced by the TypeScript reward engine
///         (packages/reward-engine/scripts/make-fixture.ts) and claims every leaf.
///         If the engine and the contract ever disagree on leaf encoding, proofs, per-user bounds,
///         budgets or growth caps, this test fails.
contract EngineParityTest is Test {
    struct Fixture {
        uint256 start;
        uint256 daily;
        uint64 day;
        address distributor;
        bytes32 root;
        bytes32 dataHash;
        uint256 total;
        address[] accounts;
        uint256[] amounts;
        bytes32[] proofFlat;
        uint256[] proofLens;
    }

    address admin = makeAddr("admin");
    address publisher = makeAddr("publisher");
    address guardian = makeAddr("guardian");

    function _load() internal returns (Fixture memory f) {
        string memory json = vm.readFile("test/fixtures/engine-root.json");
        assertTrue(vm.parseJsonBool(json, ".day1Scaled"), "fixture should cover a scaled day");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        f.start = vm.parseJsonUint(json, ".scheduleStart");
        f.daily = vm.parseJsonUint(json, ".dailyBudget");
        f.day = uint64(vm.parseJsonUint(json, ".day"));
        f.distributor = vm.parseJsonAddress(json, ".distributor");
        f.root = vm.parseJsonBytes32(json, ".root");
        f.dataHash = vm.parseJsonBytes32(json, ".dataHash");
        f.total = vm.parseJsonUint(json, ".totalEntitled");
        f.accounts = vm.parseJsonAddressArray(json, ".accounts");
        f.amounts = vm.parseJsonUintArray(json, ".amounts");
        f.proofFlat = vm.parseJsonBytes32Array(json, ".proofFlat");
        f.proofLens = vm.parseJsonUintArray(json, ".proofLens");
    }

    function _deploy(Fixture memory f) internal returns (MiningDistributor dist, MiningVault vault) {
        EmissionSchedule schedule = new EmissionSchedule(f.start, f.daily, 30, 0, 4_000_000_000e18);
        deployCodeTo(
            "MiningDistributor.sol:MiningDistributor",
            abi.encode(address(0), schedule, 43e18, 12 hours, 200e18, admin, publisher, guardian),
            f.distributor
        );
        dist = MiningDistributor(payable(f.distributor));
        vault = new MiningVault(address(0), schedule, admin);
        vm.startPrank(admin);
        vault.setDistributor(f.distributor);
        dist.setVault(vault);
        vm.stopPrank();
        vm.deal(address(vault), 1_000_000e18);
    }

    function _proof(Fixture memory f, uint256 offset, uint256 len)
        internal
        pure
        returns (bytes32[] memory p)
    {
        p = new bytes32[](len);
        for (uint256 j; j < len; ++j) {
            p[j] = f.proofFlat[offset + j];
        }
    }

    function test_EngineRootPaysEveryLeafExactly() public {
        Fixture memory f = _load();
        vm.warp(f.start + (uint256(f.day) + 1) * 1 days + 1 hours);
        (MiningDistributor dist, MiningVault vault) = _deploy(f);

        vm.prank(publisher);
        dist.proposeRoot(f.day, f.root, f.total, f.dataHash, "fixture");
        vm.warp(block.timestamp + 12 hours);

        assertEq(f.accounts.length, f.amounts.length);
        assertEq(f.accounts.length, f.proofLens.length);
        uint256 offset;
        uint256 sum;
        for (uint256 i; i < f.accounts.length; ++i) {
            bytes32[] memory proof = _proof(f, offset, f.proofLens[i]);
            offset += f.proofLens[i];
            assertEq(dist.claim(f.accounts[i], f.amounts[i], proof), f.amounts[i]);
            assertEq(f.accounts[i].balance, f.amounts[i]);
            sum += f.amounts[i];
        }
        assertEq(offset, f.proofFlat.length);
        assertEq(sum, f.total);
        assertEq(dist.totalClaimed(), f.total);
        assertEq(vault.released(), f.total);
    }
}
