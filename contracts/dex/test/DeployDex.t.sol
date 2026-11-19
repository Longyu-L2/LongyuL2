// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {DexFixture, IWETH9} from "./utils/DexFixture.sol";
import {DeployDex} from "../script/DeployDex.s.sol";
import {IUniswapV2Factory} from "../src/core/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Router02} from "../src/periphery/interfaces/IUniswapV2Router02.sol";
import {TestERC20} from "./mocks/TestERC20.sol";

/// @notice The deploy script against a WETH9 etched at the OP Stack predeploy address, as on LONGYU.
contract DeployDexTest is DexFixture {
    DeployDex internal script;

    function setUp() public override {
        vm.etch(WBNB_PREDEPLOY, vm.getDeployedCode(weth9Artifact()));
        script = new DeployDex();
        tokenA = new TestERC20("Token A", "TKA");
        tokenB = new TestERC20("Token B", "TKB");
    }

    function useDeployment(DeployDex.Deployment memory d) internal {
        factory = IUniswapV2Factory(d.factory);
        router = IUniswapV2Router02(d.router);
        weth = IWETH9(WBNB_PREDEPLOY);
    }

    function test_ScriptConstants() public view {
        assertEq(script.DEFAULT_WETH(), WBNB_PREDEPLOY);
        assertEq(script.INIT_CODE_HASH(), INIT_CODE_HASH);
    }

    function test_DeployAgainstPredeployEndToEnd() public {
        DeployDex.Deployment memory d = script.deploy(feeToSetter, WBNB_PREDEPLOY);
        useDeployment(d);
        assertEq(factory.feeToSetter(), feeToSetter);
        assertEq(factory.feeTo(), address(0));
        assertEq(router.factory(), d.factory);
        assertEq(router.WETH(), WBNB_PREDEPLOY);
        script.checkPairAddress(d.factory);

        // Add BNB liquidity, swap both ways, and withdraw through the predeploy.
        (IUniswapV2Pair pair, uint256 liquidity) = addLiquidityETH(alice, tokenA, 10e18, 5e18);
        assertEq(address(pair), factory.getPair(address(tokenA), WBNB_PREDEPLOY));
        assertEq(weth.balanceOf(address(pair)), 5e18);

        vm.deal(bob, 1e18);
        vm.prank(bob);
        router.swapExactETHForTokens{value: 1e18}(
            1662497915624478906, path2(WBNB_PREDEPLOY, address(tokenA)), bob, deadline()
        );
        assertEq(tokenA.balanceOf(bob), 1662497915624478906);

        vm.startPrank(bob);
        tokenA.approve(address(router), type(uint256).max);
        address[] memory back = path2(address(tokenA), WBNB_PREDEPLOY);
        uint256 expected = router.getAmountsOut(1662497915624478906, back)[1];
        router.swapExactTokensForETH(1662497915624478906, expected, back, bob, deadline());
        vm.stopPrank();
        assertEq(bob.balance, expected);

        vm.startPrank(alice);
        pair.approve(address(router), liquidity);
        router.removeLiquidityETH(address(tokenA), liquidity, 0, 0, alice, deadline());
        vm.stopPrank();
        assertGt(alice.balance, 0);
        assertEq(pair.balanceOf(alice), 0);
    }

    function test_DeployRefusesMissingFeeToSetterOrWeth() public {
        vm.expectRevert(DeployDex.FeeToSetterRequired.selector);
        script.deploy(address(0), WBNB_PREDEPLOY);

        address noCode = makeAddr("not a contract");
        vm.expectRevert(abi.encodeWithSelector(DeployDex.WethHasNoCode.selector, noCode));
        script.deploy(feeToSetter, noCode);

        vm.etch(WBNB_PREDEPLOY, "");
        vm.expectRevert(abi.encodeWithSelector(DeployDex.WethHasNoCode.selector, WBNB_PREDEPLOY));
        script.deploy(feeToSetter, WBNB_PREDEPLOY);
    }

    /// @dev The only test that touches the process environment (tests run in parallel).
    function test_RunReadsEnvironment() public {
        vm.setEnv("FEE_TO_SETTER", vm.toString(feeToSetter));
        vm.setEnv("WETH", vm.toString(WBNB_PREDEPLOY));
        DeployDex.Deployment memory d = script.run();
        assertEq(IUniswapV2Factory(d.factory).feeToSetter(), feeToSetter);
        assertEq(IUniswapV2Router02(d.router).WETH(), WBNB_PREDEPLOY);
        assertEq(IUniswapV2Router02(d.router).factory(), d.factory);

        vm.setEnv("FEE_TO_SETTER", vm.toString(address(0)));
        vm.expectRevert(DeployDex.FeeToSetterRequired.selector);
        script.run();

        address noCode = makeAddr("not a contract");
        vm.setEnv("FEE_TO_SETTER", vm.toString(feeToSetter));
        vm.setEnv("WETH", vm.toString(noCode));
        vm.expectRevert(abi.encodeWithSelector(DeployDex.WethHasNoCode.selector, noCode));
        script.run();
    }
}
