// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
// The original Uniswap interfaces, compiled again with 0.8.28 for the tests. The contracts under test
// come from the 0.5.16 and 0.6.6 artifacts through vm.deployCode.
import {IUniswapV2Factory} from "../../src/core/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../../src/core/interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Router02} from "../../src/periphery/interfaces/IUniswapV2Router02.sol";
import {TestERC20} from "../mocks/TestERC20.sol";

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

abstract contract DexFixture is Test {
    /// @dev keccak256 of the UniswapV2Pair creation code. UniswapV2Library.pairFor hard-codes the same value.
    bytes32 internal constant INIT_CODE_HASH =
        0x1907514ce58ff8bfdf875cc39008a411896e40d361d744a143d33cb957350a5f;
    uint256 internal constant MINIMUM_LIQUIDITY = 1000;
    address internal constant WBNB_PREDEPLOY = 0x4200000000000000000000000000000000000006;

    address internal feeToSetter = makeAddr("feeToSetter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    IWETH9 internal weth;
    IUniswapV2Factory internal factory;
    IUniswapV2Router02 internal router;
    TestERC20 internal tokenA;
    TestERC20 internal tokenB;

    function setUp() public virtual {
        weth = IWETH9(vm.deployCode(weth9Artifact()));
        factory = IUniswapV2Factory(deployFactory(feeToSetter));
        router = IUniswapV2Router02(deployRouter(address(factory), address(weth)));
        tokenA = new TestERC20("Token A", "TKA");
        tokenB = new TestERC20("Token B", "TKB");
        vm.label(address(weth), "WBNB");
        vm.label(address(factory), "Factory");
        vm.label(address(router), "Router02");
    }

    /// @dev WETH9 (0.6.6, verbatim from v2-periphery) cannot be imported by these 0.8 tests, so a filtered
    ///      run (forge test --match-*), which compiles only src/ and the matched tests, does not build it.
    ///      Such a run reads the artifact that the last full build wrote.
    function weth9Artifact() internal view returns (string memory) {
        try vm.getCode("WETH9.sol:WETH9") returns (bytes memory) {
            return "WETH9.sol:WETH9";
        } catch {
            require(
                vm.exists("out/WETH9.sol/WETH9.json"), "WETH9 not built: run forge build once, then filter"
            );
            return "out/WETH9.sol/WETH9.json";
        }
    }

    function deployFactory(address setter) internal returns (address) {
        return vm.deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(setter));
    }

    function deployRouter(address factory_, address weth_) internal returns (address) {
        return vm.deployCode("UniswapV2Router02.sol:UniswapV2Router02", abi.encode(factory_, weth_));
    }

    /// @dev The CREATE2 address of the pair, computed independently of the factory and the router.
    function pairAddress(address factory_, address a, address b) internal pure returns (address) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        bytes32 salt = keccak256(abi.encodePacked(t0, t1));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", factory_, salt, INIT_CODE_HASH)))));
    }

    function pairFor(address a, address b) internal view returns (IUniswapV2Pair) {
        return IUniswapV2Pair(pairAddress(address(factory), a, b));
    }

    /// @dev The 0.3% fee: amountOut = amountIn * 997 * reserveOut / (reserveIn * 1000 + amountIn * 997).
    function amountOutFor(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256)
    {
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
    }

    /// @dev Smallest input that buys amountOut: floor(reserveIn * amountOut * 1000 / ((reserveOut - amountOut) * 997)) + 1.
    function amountInFor(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256)
    {
        return (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    function deadline() internal view returns (uint256) {
        return block.timestamp + 1 hours;
    }

    function path2(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function sorted(TestERC20 a, TestERC20 b) internal pure returns (TestERC20, TestERC20) {
        return address(a) < address(b) ? (a, b) : (b, a);
    }

    function fund(TestERC20 token, address user, uint256 amount) internal {
        token.mint(user, amount);
        vm.prank(user);
        token.approve(address(router), type(uint256).max);
    }

    /// @dev Adds token/token liquidity through the router as `user`.
    function addLiquidity(address user, TestERC20 a, TestERC20 b, uint256 amountA, uint256 amountB)
        internal
        returns (IUniswapV2Pair pair, uint256 liquidity)
    {
        fund(a, user, amountA);
        fund(b, user, amountB);
        vm.prank(user);
        (,, liquidity) = router.addLiquidity(address(a), address(b), amountA, amountB, 0, 0, user, deadline());
        pair = pairFor(address(a), address(b));
    }

    /// @dev Adds token/WBNB liquidity through the router as `user`, paying native BNB.
    function addLiquidityETH(address user, TestERC20 token, uint256 amountToken, uint256 amountETH)
        internal
        returns (IUniswapV2Pair pair, uint256 liquidity)
    {
        fund(token, user, amountToken);
        vm.deal(user, user.balance + amountETH);
        vm.prank(user);
        (,, liquidity) =
            router.addLiquidityETH{value: amountETH}(address(token), amountToken, 0, 0, user, deadline());
        pair = pairFor(address(token), address(weth));
    }

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @dev The LP token's EIP-712 domain, computed from the patched name rather than read from the pair.
    function lpDomainSeparator(string memory name, address pair) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes("1")), block.chainid, pair
            )
        );
    }

    function signPermit(
        bytes32 domainSeparator,
        uint256 key,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline_
    ) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, vm.addr(key), spender, value, nonce, deadline_)
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }

    function signLpPermit(IUniswapV2Pair pair, uint256 key, address spender, uint256 value, uint256 deadline_)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return signPermit(
            lpDomainSeparator("LONGYU Swap LP", address(pair)),
            key,
            spender,
            value,
            pair.nonces(vm.addr(key)),
            deadline_
        );
    }

    function reservesOf(IUniswapV2Pair pair, address tokenIn)
        internal
        view
        returns (uint256 rIn, uint256 rOut)
    {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rIn, rOut) = tokenIn == pair.token0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }
}
