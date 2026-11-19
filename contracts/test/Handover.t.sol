// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISafe, ISafeProxyFactory, IOwnable, Safes} from "../script/Safes.sol";
import {CreateSafe} from "../script/CreateSafe.s.sol";
import {HandoverBsc} from "../script/HandoverBsc.s.sol";
import {HandoverLongyu, ISwapFactory} from "../script/HandoverLongyu.s.sol";

interface ISwapFactoryFee {
    function feeTo() external view returns (address);
    function setFeeTo(address feeTo) external;
}

/// Rehearses the handover of the testnet admin key's rights on copies of the live chains.
/// Runs only when the chains' addresses are given; otherwise every test is skipped:
///   BSC_TESTNET_RPC=... LONGYU_RPC=... forge test --match-contract HandoverTest
contract HandoverTest is Test {
    string internal bscRpc = vm.envOr("BSC_TESTNET_RPC", string(""));
    string internal longyuRpc = vm.envOr("LONGYU_RPC", string(""));
    address[] internal founders;
    mapping(address => uint256) internal keyOf;

    function setUp() public {
        for (uint256 i = 0; i < 3; ++i) {
            (address founder, uint256 key) = makeAddrAndKey(string.concat("founder", vm.toString(i)));
            founders.push(founder);
            keyOf[founder] = key;
        }
    }

    modifier onBsc() {
        if (bytes(bscRpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(bscRpc);
        _;
    }

    modifier onLongyu() {
        if (bytes(longyuRpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(longyuRpc);
        _;
    }

    /// Needs no chain: what msg.sender is when a hardware wallet signs and --sender is not given.
    function test_CreateSafeRefusesForgesDefaultSender() public {
        CreateSafe script = new CreateSafe();
        vm.expectRevert(CreateSafe.SenderRequired.selector);
        vm.prank(DEFAULT_SENDER);
        script.run();
    }

    /// Executes a Safe transaction signed by two founders (signatures go in ascending signer order).
    function _exec(ISafe safe, address to, bytes memory data, address a, address b) internal returns (bool) {
        bytes32 hash = _hash(safe, to, data);
        if (a > b) (a, b) = (b, a);
        return _send(safe, to, data, bytes.concat(_sign(a, hash), _sign(b, hash)));
    }

    function _hash(ISafe safe, address to, bytes memory data) internal view returns (bytes32) {
        return safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
    }

    function _send(ISafe safe, address to, bytes memory data, bytes memory signatures)
        internal
        returns (bool)
    {
        return safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    function _sign(address signer, bytes32 hash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(keyOf[signer], hash);
        return abi.encodePacked(r, s, v);
    }

    function _alone(address key) internal pure returns (bytes memory) {
        return abi.encodePacked(uint256(uint160(key)), uint256(0), uint8(1));
    }

    // ---- BSC testnet ----

    function test_Bsc_TheFoundersReplaceTheAdminKey() public onBsc {
        HandoverBsc script = new HandoverBsc();
        ISafe safe = script.SYSTEM_OWNER_SAFE();
        IERC20 tlong = script.TLONG();
        address adminKey = safe.getOwners()[0];
        uint256 supply = tlong.balanceOf(adminKey);
        assertGt(supply, 9_000_000_000e18);

        script.handOver(founders, 2);

        assertEq(safe.getOwners(), founders);
        assertEq(safe.getThreshold(), 2);
        assertFalse(safe.isOwner(adminKey));
        assertEq(tlong.balanceOf(adminKey), 0);
        assertEq(tlong.balanceOf(address(safe)), supply);
        assertEq(script.SYSTEM_CONFIG().owner(), address(safe));
        assertEq(script.PROTOCOL_VERSIONS().owner(), address(safe));
        assertEq(script.PROXY_ADMIN().owner(), address(safe));
        script.check(founders, 2);

        // The admin key can do nothing more.
        bytes memory move = abi.encodeCall(IERC20.transfer, (adminKey, 1e18));
        bytes memory alone = _alone(adminKey);
        vm.prank(adminKey);
        vm.expectRevert();
        safe.execTransaction(address(tlong), 0, move, 0, 0, 0, 0, address(0), payable(address(0)), alone);
        _cannotTakeOwnership(script.SYSTEM_CONFIG(), adminKey);
        _cannotTakeOwnership(script.PROTOCOL_VERSIONS(), adminKey);

        // One founder is not enough; two are.
        bytes memory single = _sign(founders[0], _hash(safe, address(tlong), move));
        vm.expectRevert();
        safe.execTransaction(address(tlong), 0, move, 0, 0, 0, 0, address(0), payable(address(0)), single);
        assertTrue(_exec(safe, address(tlong), move, founders[0], founders[2]));
        assertEq(tlong.balanceOf(adminKey), 1e18);
        // The upgrade rights answer to the same two signatures.
        address next = makeAddr("next owner");
        IOwnable proxyAdmin = script.PROXY_ADMIN();
        _exec(
            safe,
            address(proxyAdmin),
            abi.encodeCall(IOwnable.transferOwnership, (next)),
            founders[1],
            founders[2]
        );
        assertEq(proxyAdmin.owner(), next);
    }

    function _cannotTakeOwnership(IOwnable target, address key) internal {
        vm.prank(key);
        vm.expectRevert();
        target.transferOwnership(key);
    }

    function test_Bsc_RefusesAWeakSignerListAndASecondRun() public onBsc {
        HandoverBsc script = new HandoverBsc();
        address adminKey = script.SYSTEM_OWNER_SAFE().getOwners()[0];

        vm.expectRevert(Safes.ThresholdOutOfRange.selector);
        script.handOver(founders, 1);
        vm.expectRevert(Safes.ThresholdOutOfRange.selector);
        script.handOver(founders, 4);
        address[] memory one = new address[](1);
        one[0] = founders[0];
        vm.expectRevert(Safes.TooFewOwners.selector);
        script.handOver(one, 1);
        address[] memory twice = new address[](3);
        (twice[0], twice[1], twice[2]) = (founders[0], founders[1], founders[0]);
        vm.expectRevert(abi.encodeWithSelector(Safes.DuplicateOwner.selector, founders[0]));
        script.handOver(twice, 2);
        address[] memory withKey = new address[](3);
        (withKey[0], withKey[1], withKey[2]) = (founders[0], adminKey, founders[1]);
        vm.expectRevert(abi.encodeWithSelector(Safes.SingleKeyIsOwner.selector, adminKey));
        script.handOver(withKey, 2);
        address[] memory withZero = new address[](2);
        withZero[0] = founders[0];
        vm.expectRevert(abi.encodeWithSelector(Safes.InvalidOwner.selector, address(0)));
        script.handOver(withZero, 2);

        vm.expectRevert();
        script.check(founders, 2);
        script.handOver(founders, 3);
        script.check(founders, 3);
        vm.expectRevert(HandoverBsc.AlreadyHandedOver.selector);
        script.handOver(founders, 3);
    }

    function test_Bsc_CreateSafe() public onBsc {
        _createSafe();
    }

    function _createSafe() internal returns (ISafe safe) {
        CreateSafe script = new CreateSafe();
        address sender = makeAddr("sender");
        safe = ISafe(script.create(founders, 2, 0, sender));
        assertEq(safe.getOwners(), founders);
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.VERSION(), "1.3.0");
        assertFalse(safe.isOwner(sender));
        assertFalse(safe.isOwner(address(script)));
        // The same signers and salt cannot make a second Safe; another salt can.
        vm.expectRevert();
        script.create(founders, 2, 0, sender);
        assertTrue(script.create(founders, 2, 1, sender) != address(safe));
        vm.expectRevert(abi.encodeWithSelector(Safes.SingleKeyIsOwner.selector, founders[1]));
        script.create(founders, 2, 2, founders[1]);
        vm.expectRevert(Safes.ThresholdOutOfRange.selector);
        script.create(founders, 1, 2, sender);
    }

    // ---- LONGYU testnet ----

    function test_Longyu_TheFoundersReplaceTheAdminKey() public onLongyu {
        ISafe safe = _createSafe();
        HandoverLongyu script = new HandoverLongyu();
        ISwapFactory factory = script.SWAP_FACTORY();
        address adminKey = factory.feeToSetter();
        vm.expectRevert();
        script.check(address(safe));

        script.handOver(address(safe));

        assertEq(factory.feeToSetter(), address(safe));
        assertEq(script.PROXY_ADMIN().owner(), address(safe));
        script.check(address(safe));

        address treasury = makeAddr("treasury");
        vm.prank(adminKey);
        vm.expectRevert();
        ISwapFactoryFee(address(factory)).setFeeTo(treasury);
        vm.prank(adminKey);
        vm.expectRevert();
        factory.setFeeToSetter(adminKey);
        _cannotTakeOwnership(script.PROXY_ADMIN(), adminKey);

        assertTrue(
            _exec(
                safe,
                address(factory),
                abi.encodeCall(ISwapFactoryFee.setFeeTo, (treasury)),
                founders[2],
                founders[1]
            )
        );
        assertEq(ISwapFactoryFee(address(factory)).feeTo(), treasury);

        vm.expectRevert(HandoverLongyu.AlreadyHandedOver.selector);
        script.handOver(address(safe));
    }

    function test_Longyu_RefusesAnythingButAFoundersMultisig() public onLongyu {
        HandoverLongyu script = new HandoverLongyu();
        address adminKey = script.SWAP_FACTORY().feeToSetter();
        Safes.Kit memory k = Safes.kit();

        // A plain wallet.
        vm.expectRevert(abi.encodeWithSelector(Safes.NotASafe.selector, founders[0]));
        script.handOver(founders[0]);
        // A contract that is not a Safe.
        vm.expectRevert(abi.encodeWithSelector(Safes.NotASafe.selector, k.singletonL2));
        script.handOver(k.singletonL2);
        // A Safe one signature can move.
        address weak = _rawSafe(k, founders, 1, k.fallbackHandler);
        vm.expectRevert(abi.encodeWithSelector(Safes.ThresholdTooLow.selector, 1));
        script.handOver(weak);
        // A Safe the admin key still signs for.
        address[] memory withKey = new address[](3);
        (withKey[0], withKey[1], withKey[2]) = (founders[0], adminKey, founders[1]);
        address shared = _rawSafe(k, withKey, 2, k.fallbackHandler);
        vm.expectRevert(abi.encodeWithSelector(Safes.SingleKeyIsOwner.selector, adminKey));
        script.handOver(shared);
        // A Safe with someone else's fallback handler.
        address odd = _rawSafe(k, founders, 2, address(this));
        vm.expectRevert(abi.encodeWithSelector(Safes.UnknownFallbackHandler.selector, address(this)));
        script.handOver(odd);
        // A Safe proxy pointing at code that is not Safe's.
        address fake = ISafeProxyFactory(k.factory).createProxyWithNonce(address(this), "", 7);
        vm.expectRevert(abi.encodeWithSelector(Safes.UnknownSingleton.selector, address(this)));
        script.handOver(fake);

        assertEq(script.SWAP_FACTORY().feeToSetter(), adminKey);
    }

    function _rawSafe(Safes.Kit memory k, address[] memory owners, uint256 threshold, address handler)
        internal
        returns (address)
    {
        bytes memory setup = abi.encodeCall(
            ISafe.setup, (owners, threshold, address(0), "", handler, address(0), 0, payable(address(0)))
        );
        return ISafeProxyFactory(k.factory).createProxyWithNonce(k.singletonL2, setup, 99);
    }

    /// Answers the storage read that Safes.requireMultisig makes on a proxy pointing at this contract.
    function getStorageAt(uint256 offset, uint256) external view returns (bytes memory) {
        bytes32 value;
        assembly {
            value := sload(offset)
        }
        return abi.encode(value);
    }
}
