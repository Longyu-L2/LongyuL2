// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {MigrationDistributor} from "../src/MigrationDistributor.sol";
import {LongToken} from "../src/LongToken.sol";
import {Merkle} from "./utils/Merkle.sol";

contract MigrationDistributorTest is Test {
    uint64 constant START = 1_900_000_000;
    uint64 constant VESTING = 365 days;
    uint64 constant END = START + 2 * 365 days;
    uint16 constant TGE_BPS = 2_500;
    uint256 constant POOL = 500_000_000e18;

    LongToken token;
    MigrationDistributor mig;
    address admin = makeAddr("admin");
    address guardian = makeAddr("guardian");
    address pool = makeAddr("communityPool");
    uint256 aliceKey = 0xA11CE;
    address alice;
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address relayer = makeAddr("relayer");

    address[] accts;
    uint256[] allocs;

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        vm.warp(START - 30 days);
        alice = vm.addr(aliceKey);
        token = new LongToken("LONGYU", "LONG", 10_000_000_000e18, address(this));
        mig = new MigrationDistributor(address(token), admin, guardian, START, VESTING, END, TGE_BPS, pool);
        token.transfer(address(mig), POOL);
        accts.push(alice);
        accts.push(bob);
        accts.push(carol);
        allocs.push(1_000e18);
        allocs.push(400e18);
        allocs.push(250e18);
        bytes32 root = Merkle.root(_leaves());
        vm.prank(admin);
        mig.setRoot(root, 1_650e18, keccak256("snapshot"));
    }

    function _leaves() internal view returns (bytes32[] memory l) {
        l = new bytes32[](accts.length);
        for (uint256 i; i < accts.length; ++i) {
            l[i] = mig.leaf(accts[i], allocs[i]);
        }
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory) {
        return Merkle.proof(_leaves(), i);
    }

    function test_RejectsBadSchedule() public {
        vm.expectRevert(MigrationDistributor.InvalidSchedule.selector);
        new MigrationDistributor(
            address(token), admin, guardian, START, VESTING, START + VESTING - 1, TGE_BPS, pool
        );
        vm.expectRevert(MigrationDistributor.InvalidSchedule.selector);
        new MigrationDistributor(address(token), admin, guardian, START, VESTING, END, 10_001, pool);
        vm.expectRevert(MigrationDistributor.InvalidSchedule.selector);
        new MigrationDistributor(
            address(token), admin, guardian, uint64(block.timestamp), VESTING, END, TGE_BPS, pool
        );
    }

    function test_ClaimEndMustComeAfterVesting() public {
        // Claims stop at claimEnd: ending with vesting would leave the last part impossible to claim.
        vm.expectRevert(MigrationDistributor.InvalidSchedule.selector);
        new MigrationDistributor(
            address(token), admin, guardian, START, VESTING, START + VESTING, TGE_BPS, pool
        );
        vm.expectRevert(MigrationDistributor.InvalidSchedule.selector);
        new MigrationDistributor(address(token), admin, guardian, START, 0, START, TGE_BPS, pool);

        // One second more is the shortest schedule, and in that second everything can be claimed.
        MigrationDistributor shortest = new MigrationDistributor(
            address(token), admin, guardian, START, VESTING, START + VESTING + 1, TGE_BPS, pool
        );
        token.transfer(address(shortest), 1_650e18);
        bytes32[] memory l = new bytes32[](accts.length);
        for (uint256 i; i < accts.length; ++i) {
            l[i] = shortest.leaf(accts[i], allocs[i]);
        }
        vm.prank(admin);
        shortest.setRoot(Merkle.root(l), 1_650e18, keccak256("snapshot"));
        vm.warp(START + VESTING - 1);
        assertLt(shortest.claim(alice, 1_000e18, Merkle.proof(l, 0)), 1_000e18);
        vm.warp(START + VESTING);
        shortest.claim(alice, 1_000e18, Merkle.proof(l, 0));
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(shortest.claim(bob, 400e18, Merkle.proof(l, 1)), 400e18);
        bytes32[] memory p = Merkle.proof(l, 2);
        vm.warp(START + VESTING + 1);
        vm.expectRevert(MigrationDistributor.ClaimsNotOpen.selector);
        shortest.claim(carol, 250e18, p);
    }

    function test_ConstructorAndRootValidation() public {
        vm.expectRevert(MigrationDistributor.ZeroAddress.selector);
        new MigrationDistributor(address(token), address(0), guardian, START, VESTING, END, TGE_BPS, pool);
        vm.expectRevert(MigrationDistributor.ZeroAddress.selector);
        new MigrationDistributor(address(token), admin, address(0), START, VESTING, END, TGE_BPS, pool);
        vm.expectRevert(MigrationDistributor.ZeroAddress.selector);
        new MigrationDistributor(address(token), admin, guardian, START, VESTING, END, TGE_BPS, address(0));
        vm.startPrank(admin);
        vm.expectRevert(MigrationDistributor.InvalidRoot.selector);
        mig.setRoot(bytes32(0), 1, bytes32(0));
        vm.expectRevert(MigrationDistributor.InvalidRoot.selector);
        mig.setRoot(keccak256("x"), 0, bytes32(0));
        vm.stopPrank();
    }

    function test_ClaimToRejectsZeroRecipient() public {
        vm.warp(START);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(MigrationDistributor.ZeroAddress.selector);
        mig.claimTo(alice, 1_000e18, p, address(0), block.timestamp + 1, "");
    }

    function test_RejectsNativeWhenErc20() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = address(mig).call{value: 1}("");
        assertFalse(ok);
    }

    function test_NoRootMeansNoClaims() public {
        MigrationDistributor empty =
            new MigrationDistributor(address(token), admin, guardian, START, VESTING, END, TGE_BPS, pool);
        vm.warp(START);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(MigrationDistributor.InvalidRoot.selector);
        empty.claim(alice, 1_000e18, p);
    }

    function test_NothingBeforeStart() public {
        bytes32[] memory p = _proof(0);
        vm.expectRevert(MigrationDistributor.ClaimsNotOpen.selector);
        mig.claim(alice, 1_000e18, p);
    }

    function test_VestingSchedule() public {
        vm.warp(START);
        assertEq(mig.claim(alice, 1_000e18, _proof(0)), 250e18); // 25% at launch
        vm.warp(START + VESTING / 2);
        assertEq(mig.claim(alice, 1_000e18, _proof(0)), 375e18); // 62.5% after six months
        vm.warp(START + VESTING);
        assertEq(mig.claim(alice, 1_000e18, _proof(0)), 375e18); // 100% after twelve months
        assertEq(token.balanceOf(alice), 1_000e18);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(MigrationDistributor.NothingToClaim.selector);
        mig.claim(alice, 1_000e18, p);
    }

    function testFuzz_VestedNeverDecreasesOrExceeds(uint256 allocation, uint64 t1, uint64 t2) public view {
        allocation = bound(allocation, 0, 1e30);
        (uint64 lo, uint64 hi) = t1 < t2 ? (t1, t2) : (t2, t1);
        uint256 a = mig.vestedAmount(allocation, lo);
        uint256 b = mig.vestedAmount(allocation, hi);
        assertLe(a, b);
        assertLe(b, allocation);
    }

    function test_RelayerClaimPaysAccount() public {
        vm.warp(START);
        bytes32[] memory p = _proof(1);
        vm.prank(relayer);
        mig.claim(bob, 400e18, p);
        assertEq(token.balanceOf(bob), 100e18);
        assertEq(token.balanceOf(relayer), 0);
    }

    function test_RevertWhen_ProofInvalid() public {
        vm.warp(START);
        bytes32[] memory p = _proof(1);
        vm.expectRevert(MigrationDistributor.InvalidProof.selector);
        mig.claim(bob, 401e18, p);
        vm.expectRevert(MigrationDistributor.InvalidProof.selector);
        mig.claim(carol, 400e18, p);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(MigrationDistributor.InvalidProof.selector);
        mig.claim(bob, 400e18, p);
    }

    function _claimToSig(uint256 key, address account, address recipient, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("LONGYU Migration"), keccak256("1"), block.chainid, address(mig)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(mig.CLAIM_TO_TYPEHASH(), account, recipient, nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_ClaimToWithSignature() public {
        vm.warp(START);
        address newWallet = makeAddr("newWallet");
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _claimToSig(aliceKey, alice, newWallet, 0, deadline);
        vm.prank(relayer);
        mig.claimTo(alice, 1_000e18, _proof(0), newWallet, deadline, sig);
        assertEq(token.balanceOf(newWallet), 250e18);
        assertEq(mig.claimed(alice), 250e18);

        // The same signature cannot be replayed: the nonce has moved on.
        vm.warp(START + VESTING);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(MigrationDistributor.InvalidSignature.selector);
        mig.claimTo(alice, 1_000e18, p, newWallet, deadline + VESTING, sig);
    }

    function test_RevertWhen_ClaimToNotSignedByAccount() public {
        vm.warp(START);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory sig = _claimToSig(0xBAD, alice, relayer, 0, deadline);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(MigrationDistributor.InvalidSignature.selector);
        mig.claimTo(alice, 1_000e18, p, relayer, deadline, sig);
    }

    function test_RevertWhen_ClaimToExpired() public {
        vm.warp(START);
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _claimToSig(aliceKey, alice, relayer, 0, deadline);
        bytes32[] memory p = _proof(0);
        vm.expectRevert(MigrationDistributor.SignatureExpired.selector);
        mig.claimTo(alice, 1_000e18, p, relayer, deadline, sig);
    }

    function test_RootFixedOnceClaimsOpen() public {
        vm.warp(START);
        vm.prank(admin);
        vm.expectRevert(MigrationDistributor.ClaimsAlreadyStarted.selector);
        mig.setRoot(keccak256("other"), 1, bytes32(0));
    }

    function test_OnlyAdminSetsRoot() public {
        vm.prank(alice);
        vm.expectRevert();
        mig.setRoot(keccak256("other"), 1, bytes32(0));
    }

    function test_DeclaredTotalCapsPayouts() public {
        // A root whose leaves add up to more than its declared total cannot overpay.
        bytes32 root = Merkle.root(_leaves());
        vm.prank(admin);
        mig.setRoot(root, 1_000e18, bytes32(0));
        vm.warp(START + VESTING);
        mig.claim(alice, 1_000e18, _proof(0));
        bytes32[] memory p = _proof(1);
        vm.expectRevert(MigrationDistributor.AboveTotalAllocation.selector);
        mig.claim(bob, 400e18, p);
    }

    function test_SweepAfterEnd() public {
        vm.warp(START);
        mig.claim(alice, 1_000e18, _proof(0));
        vm.expectRevert(MigrationDistributor.ClaimsNotEnded.selector);
        mig.sweepUnclaimed();
        vm.warp(END);
        bytes32[] memory p = _proof(1);
        vm.expectRevert(MigrationDistributor.ClaimsNotOpen.selector);
        mig.claim(bob, 400e18, p);
        mig.sweepUnclaimed();
        assertEq(token.balanceOf(pool), POOL - 250e18);
        vm.expectRevert(MigrationDistributor.AlreadySwept.selector);
        mig.sweepUnclaimed();
    }

    function test_Pause() public {
        vm.warp(START);
        vm.prank(guardian);
        mig.pause();
        bytes32[] memory p = _proof(0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mig.claim(alice, 1_000e18, p);
        vm.prank(admin);
        mig.unpause();
        mig.claim(alice, 1_000e18, p);
    }
}
