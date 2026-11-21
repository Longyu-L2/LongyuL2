// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LaunchLong} from "../script/LaunchLong.s.sol";
import {CreateSafe} from "../script/CreateSafe.s.sol";
import {Safes} from "../script/Safes.sol";
import {LongToken} from "../src/LongToken.sol";

contract LaunchLongTest is Test {
    string internal bscRpc = vm.envOr("BSC_RPC", string(""));

    modifier onBsc() {
        if (bytes(bscRpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(bscRpc);
        _;
    }

    function test_RefusesAnotherChain() public {
        LaunchLong script = new LaunchLong();
        vm.expectRevert(LaunchLong.NotBsc.selector);
        script.launch(makeAddr("treasury"), address(this));
    }

    // ---- BSC, on a local fork: BSC_RPC=https://bsc-rpc.publicnode.com forge test --match-contract LaunchLongTest

    function test_Bsc_TheWholeSupplyGoesToTheTreasurySafe() public onBsc {
        address[] memory owners = new address[](3);
        owners[0] = makeAddr("signer 1");
        owners[1] = makeAddr("signer 2");
        owners[2] = makeAddr("signer 3");
        address deployer = makeAddr("deployer");
        address treasury = new CreateSafe().create(owners, 2, 0, deployer);

        LaunchLong script = new LaunchLong();
        LongToken token = script.launch(treasury, deployer);

        assertEq(token.totalSupply(), 10_000_000_000e18);
        assertEq(token.balanceOf(treasury), 10_000_000_000e18);
        assertEq(token.balanceOf(deployer), 0);
        assertEq(token.balanceOf(address(script)), 0);
        assertEq(token.name(), "LONGYU");
        assertEq(token.symbol(), "LONG");
        script.check(token, treasury);
    }

    function test_Bsc_RefusesAPlainKeyAndASafeTheSenderSigns() public onBsc {
        LaunchLong script = new LaunchLong();
        address deployer = makeAddr("deployer");
        address key = makeAddr("plain key");
        vm.expectRevert(abi.encodeWithSelector(Safes.NotASafe.selector, key));
        script.launch(key, deployer);

        address[] memory owners = new address[](2);
        owners[0] = makeAddr("signer 1");
        owners[1] = deployer;
        address signedByDeployer = new CreateSafe().create(owners, 2, 1, makeAddr("someone else"));
        vm.expectRevert(abi.encodeWithSelector(Safes.SingleKeyIsOwner.selector, deployer));
        script.launch(signedByDeployer, deployer);
    }
}
