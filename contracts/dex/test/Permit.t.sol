// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {DexFixture} from "./utils/DexFixture.sol";
import {IUniswapV2Pair} from "../src/core/interfaces/IUniswapV2Pair.sol";

/// @notice EIP-2612 permits on the LP token, whose EIP-712 domain uses the patched name "LONGYU Swap LP".
contract PermitTest is DexFixture {
    event Approval(address indexed owner, address indexed spender, uint256 value);

    address internal owner;
    uint256 internal ownerKey;
    IUniswapV2Pair internal pair;
    uint256 internal liquidity;

    function setUp() public override {
        super.setUp();
        (owner, ownerKey) = makeAddrAndKey("lp owner");
        (pair, liquidity) = addLiquidity(owner, tokenA, tokenB, 1e18, 4e18);
    }

    function test_DomainSeparatorUsesPatchedName() public view {
        assertEq(pair.DOMAIN_SEPARATOR(), lpDomainSeparator("LONGYU Swap LP", address(pair)));
        assertNotEq(pair.DOMAIN_SEPARATOR(), lpDomainSeparator("Uniswap V2", address(pair)));
        assertEq(pair.PERMIT_TYPEHASH(), PERMIT_TYPEHASH);
    }

    function test_Permit() public {
        uint256 dl = deadline();
        (uint8 v, bytes32 r, bytes32 s) = signLpPermit(pair, ownerKey, bob, 123, dl);
        vm.expectEmit(address(pair));
        emit Approval(owner, bob, 123);
        pair.permit(owner, bob, 123, dl, v, r, s);
        assertEq(pair.allowance(owner, bob), 123);
        assertEq(pair.nonces(owner), 1);

        // The spender can now move the LP tokens.
        vm.prank(bob);
        assertTrue(pair.transferFrom(owner, bob, 123));
        assertEq(pair.balanceOf(bob), 123);
    }

    function test_PermitCannotBeReplayed() public {
        uint256 dl = deadline();
        (uint8 v, bytes32 r, bytes32 s) = signLpPermit(pair, ownerKey, bob, 123, dl);
        pair.permit(owner, bob, 123, dl, v, r, s);
        vm.expectRevert(bytes("UniswapV2: INVALID_SIGNATURE"));
        pair.permit(owner, bob, 123, dl, v, r, s);
    }

    function test_PermitRejectsExpiredDeadline() public {
        vm.warp(1_000_000);
        uint256 dl = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = signLpPermit(pair, ownerKey, bob, 123, dl);
        vm.expectRevert(bytes("UniswapV2: EXPIRED"));
        pair.permit(owner, bob, 123, dl, v, r, s);
    }

    function test_PermitRejectsWrongSignerOrValue() public {
        uint256 dl = deadline();
        (, uint256 otherKey) = makeAddrAndKey("someone else");
        (uint8 v, bytes32 r, bytes32 s) = signLpPermit(pair, otherKey, bob, 123, dl);
        vm.expectRevert(bytes("UniswapV2: INVALID_SIGNATURE"));
        pair.permit(owner, bob, 123, dl, v, r, s);

        (v, r, s) = signLpPermit(pair, ownerKey, bob, 123, dl);
        vm.expectRevert(bytes("UniswapV2: INVALID_SIGNATURE"));
        pair.permit(owner, bob, 124, dl, v, r, s);
    }

    /// @dev A wallet that still signs for the Uniswap domain name gets rejected.
    function test_PermitSignedForUniswapNameIsRejected() public {
        uint256 dl = deadline();
        (uint8 v, bytes32 r, bytes32 s) =
            signPermit(lpDomainSeparator("Uniswap V2", address(pair)), ownerKey, bob, 123, 0, dl);
        vm.expectRevert(bytes("UniswapV2: INVALID_SIGNATURE"));
        pair.permit(owner, bob, 123, dl, v, r, s);
    }

    /// @dev Caveat kept from Uniswap V2: the chain id is fixed into the domain when the pair is created.
    function test_DomainSeparatorIsFixedAtCreation() public {
        bytes32 before = pair.DOMAIN_SEPARATOR();
        vm.chainId(block.chainid + 1);
        assertEq(pair.DOMAIN_SEPARATOR(), before);
    }

    function test_RemoveLiquidityWithPermit() public {
        uint256 dl = deadline();
        (uint8 v, bytes32 r, bytes32 s) = signLpPermit(pair, ownerKey, address(router), liquidity, dl);
        vm.prank(owner);
        (uint256 amountA, uint256 amountB) = router.removeLiquidityWithPermit(
            address(tokenA), address(tokenB), liquidity, 1e18 - 500, 4e18 - 2000, owner, dl, false, v, r, s
        );
        assertEq(amountA, 1e18 - 500);
        assertEq(amountB, 4e18 - 2000);
        assertEq(pair.balanceOf(owner), 0);
        assertEq(pair.allowance(owner, address(router)), 0);
    }

    function test_RemoveLiquidityETHWithPermitApproveMax() public {
        (address ethOwner, uint256 ethOwnerKey) = makeAddrAndKey("bnb lp owner");
        (IUniswapV2Pair ethPair, uint256 ethLiquidity) = addLiquidityETH(ethOwner, tokenA, 1e18, 4e18);
        uint256 dl = deadline();
        (uint8 v, bytes32 r, bytes32 s) =
            signLpPermit(ethPair, ethOwnerKey, address(router), type(uint256).max, dl);
        vm.prank(ethOwner);
        (uint256 amountToken, uint256 amountETH) = router.removeLiquidityETHWithPermit(
            address(tokenA), ethLiquidity, 1e18 - 500, 4e18 - 2000, ethOwner, dl, true, v, r, s
        );
        assertEq(amountToken, 1e18 - 500);
        assertEq(amountETH, 4e18 - 2000);
        assertEq(ethOwner.balance, 4e18 - 2000);
        // An unlimited allowance is never spent.
        assertEq(ethPair.allowance(ethOwner, address(router)), type(uint256).max);
    }
}
