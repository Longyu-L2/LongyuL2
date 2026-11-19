// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreateL2Token} from "../script/CreateL2Token.s.sol";
import {BridgeToL2, IL1StandardBridge} from "../script/BridgeToL2.s.sol";
import {DeployTestToken} from "../script/DeployTestToken.s.sol";
import {LongToken} from "../src/LongToken.sol";

/// Records what the predeploy factory was asked to create.
contract FactoryMock {
    address public remote;
    string public name;
    string public symbol;

    function createOptimismMintableERC20(address remote_, string memory name_, string memory symbol_)
        external
        returns (address)
    {
        (remote, name, symbol) = (remote_, name_, symbol_);
        return address(0xBEEF);
    }
}

/// Behaves like the L1 standard bridge for ERC-20 deposits: pulls the tokens and records the call.
contract BridgeMock {
    address public l1Token;
    address public l2Token;
    address public to;
    uint256 public amount;
    uint32 public minGasLimit;
    uint256 public pull;

    constructor(uint256 pull_) {
        pull = pull_;
    }

    function depositERC20To(address l1, address l2, address to_, uint256 amount_, uint32 gas, bytes calldata)
        external
    {
        (l1Token, l2Token, to, amount, minGasLimit) = (l1, l2, to_, amount_, gas);
        IERC20(l1).transferFrom(msg.sender, address(this), pull == 0 ? amount_ : pull);
    }
}

contract BridgeScriptsTest is Test {
    function test_DeployTestTokenMintsTheSupplyToTheHolderOnBscTestnet() public {
        DeployTestToken script = new DeployTestToken();
        address holder = makeAddr("holder");
        vm.chainId(97);
        LongToken tlong = script.deploy(holder, 10_000_000_000e18);
        assertEq(tlong.name(), "LONGYU Testnet Token");
        assertEq(tlong.symbol(), "tLONG");
        assertEq(tlong.decimals(), 18);
        assertEq(tlong.totalSupply(), 10_000_000_000e18);
        assertEq(tlong.balanceOf(holder), 10_000_000_000e18);
    }

    function test_DeployTestTokenRefusesAnyOtherChain() public {
        DeployTestToken script = new DeployTestToken();
        uint256[3] memory others = [uint256(56), 668801, 31337];
        for (uint256 i = 0; i < others.length; i++) {
            vm.chainId(others[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployTestToken.NotBscTestnet.selector, others[i]));
            script.deploy(makeAddr("holder"), 1e18);
        }
    }

    function test_CreateL2TokenCallsThePredeployFactory() public {
        CreateL2Token script = new CreateL2Token();
        vm.etch(script.FACTORY(), address(new FactoryMock()).code);
        address token = script.create(address(0x1234), "LONGYU Testnet Token", "tLONG");
        assertEq(token, address(0xBEEF));
        FactoryMock f = FactoryMock(script.FACTORY());
        assertEq(f.remote(), address(0x1234));
        assertEq(f.name(), "LONGYU Testnet Token");
        assertEq(f.symbol(), "tLONG");
    }

    function test_CreateL2TokenRefusesAChainWithoutTheFactory() public {
        CreateL2Token script = new CreateL2Token();
        vm.expectRevert(CreateL2Token.NotOnLongyu.selector);
        script.create(address(0x1234), "LONGYU Testnet Token", "tLONG");
        vm.expectRevert(CreateL2Token.InvalidL1Token.selector);
        script.create(address(0), "LONGYU Testnet Token", "tLONG");
    }

    function test_BridgeToL2DepositsExactlyTheAmount() public {
        BridgeToL2 script = new BridgeToL2();
        LongToken tlong = new LongToken("LONGYU Testnet Token", "tLONG", 1_000e18, address(script));
        BridgeMock bridge = new BridgeMock(0);
        address vault = makeAddr("vault");
        script.deposit(
            IL1StandardBridge(address(bridge)), IERC20(address(tlong)), address(0xBEEF), vault, 400e18
        );
        assertEq(tlong.balanceOf(address(bridge)), 400e18);
        assertEq(tlong.allowance(address(script), address(bridge)), 0);
        assertEq(bridge.to(), vault);
        assertEq(bridge.l2Token(), address(0xBEEF));
        assertEq(bridge.minGasLimit(), 200_000);
    }

    function test_BridgeToL2RejectsBadInputsAndShortPulls() public {
        BridgeToL2 script = new BridgeToL2();
        LongToken tlong = new LongToken("LONGYU Testnet Token", "tLONG", 1_000e18, address(script));
        BridgeMock bridge = new BridgeMock(1e18);
        vm.expectRevert(abi.encodeWithSelector(BridgeToL2.BridgeTookWrongAmount.selector, 1e18));
        script.deposit(
            IL1StandardBridge(address(bridge)), IERC20(address(tlong)), address(0xBEEF), address(1), 400e18
        );

        BridgeMock ok = new BridgeMock(0);
        vm.expectRevert(BridgeToL2.InvalidParams.selector);
        script.deposit(IL1StandardBridge(address(ok)), IERC20(address(tlong)), address(0), address(1), 400e18);
        vm.expectRevert(BridgeToL2.InvalidParams.selector);
        script.deposit(IL1StandardBridge(address(ok)), IERC20(address(tlong)), address(0xBEEF), address(1), 0);
        vm.expectRevert(BridgeToL2.InvalidParams.selector);
        script.deposit(
            IL1StandardBridge(makeAddr("eoa")), IERC20(address(tlong)), address(0xBEEF), address(1), 1
        );
    }

    function test_BridgeToL2OnBscTestnetBridgesTLongOnlyToItsCopy() public {
        BridgeToL2 script = new BridgeToL2();
        IERC20 tlong = IERC20(script.TLONG());
        address copy = script.TLONG_ON_LONGYU();
        deployCodeTo(
            "LongToken.sol",
            abi.encode("LONGYU Testnet Token", "tLONG", 1_000e18, address(script)),
            address(tlong)
        );
        IERC20 other = IERC20(address(new LongToken("Other Token", "OTHER", 1_000e18, address(script))));
        IL1StandardBridge bridge = IL1StandardBridge(address(new BridgeMock(0)));
        address vault = makeAddr("vault");

        vm.chainId(97);
        script.deposit(bridge, tlong, copy, vault, 400e18);
        assertEq(tlong.balanceOf(address(bridge)), 400e18);
        assertEq(BridgeMock(address(bridge)).l2Token(), copy);

        // LONGYU would mint nothing for either of these, and the deposit would stay in the bridge.
        vm.expectRevert(
            abi.encodeWithSelector(BridgeToL2.WrongTokenPair.selector, address(tlong), address(0xBEEF))
        );
        script.deposit(bridge, tlong, address(0xBEEF), vault, 400e18);
        vm.expectRevert(abi.encodeWithSelector(BridgeToL2.WrongTokenPair.selector, address(other), copy));
        script.deposit(bridge, other, copy, vault, 400e18);
        assertEq(tlong.balanceOf(address(bridge)), 400e18);
        assertEq(other.balanceOf(address(bridge)), 0);

        // A pair the script does not know is left to the sender, on BSC testnet and on any other chain.
        script.deposit(bridge, other, address(0xBEEF), vault, 1e18);
        vm.chainId(56);
        script.deposit(bridge, tlong, address(0xBEEF), vault, 1e18);
        assertEq(other.balanceOf(address(bridge)), 1e18);
        assertEq(tlong.balanceOf(address(bridge)), 401e18);
    }
}
