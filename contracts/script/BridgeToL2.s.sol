// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice LONGYU's standard bridge on BSC (the L1StandardBridge proxy from the rollup deployment).
interface IL1StandardBridge {
    function depositERC20To(
        address l1Token,
        address l2Token,
        address to,
        uint256 amount,
        uint32 minGasLimit,
        bytes calldata extraData
    ) external;
}

/// @notice Bridges a BEP-20 from BSC to an address on LONGYU, such as tLONG into the mining vault.
/// @dev Run against BSC (testnet). Approves exactly `AMOUNT`, deposits, and checks that the bridge
///      took exactly that much. The tokens arrive on LONGYU a few minutes later, once the
///      deposit's BSC block is final. Environment: L1_BRIDGE, L1_TOKEN, L2_TOKEN, TO, AMOUNT (wei).
///      On BSC testnet tLONG goes only to its own copy on LONGYU. For any other pair, bridge a small
///      amount first.
contract BridgeToL2 is Script {
    using SafeERC20 for IERC20;

    uint256 public constant BSC_TESTNET = 97;
    /// tLONG on BSC testnet and its bridged copy on LONGYU testnet.
    address public constant TLONG = 0x88d5B1946BaB654e31Fbf0bcc3D022e995aB129C;
    address public constant TLONG_ON_LONGYU = 0xF4769160D6dc78F66f61F0eA1638E65d43610163;

    /// Gas the bridge message may use on LONGYU; minting a standard bridged token needs far less.
    uint32 public constant MIN_GAS_LIMIT = 200_000;

    error InvalidParams();
    error WrongTokenPair(address l1Token, address l2Token);
    error BridgeTookWrongAmount(uint256 taken);

    function run() external {
        address bridge = vm.envAddress("L1_BRIDGE");
        address l1Token = vm.envAddress("L1_TOKEN");
        address l2Token = vm.envAddress("L2_TOKEN");
        address to = vm.envAddress("TO");
        uint256 amount = vm.envUint("AMOUNT");
        vm.startBroadcast();
        deposit(IL1StandardBridge(bridge), IERC20(l1Token), l2Token, to, amount);
        vm.stopBroadcast();
        console2.log("Deposited", amount, "to", to);
    }

    function deposit(IL1StandardBridge bridge, IERC20 l1Token, address l2Token, address to, uint256 amount)
        public
    {
        if (address(bridge).code.length == 0 || address(l1Token).code.length == 0) revert InvalidParams();
        if (l2Token == address(0) || to == address(0) || amount == 0) revert InvalidParams();
        // The bridge on BSC takes a deposit for any `l2Token`. If that is not the copy of `l1Token` on
        // LONGYU, nothing is minted there and the deposit stays locked in the bridge. The testnet pair is
        // known, so it is checked. On any other chain nothing here can tell: bridge a small amount first.
        if (block.chainid == BSC_TESTNET && (address(l1Token) == TLONG) != (l2Token == TLONG_ON_LONGYU)) {
            revert WrongTokenPair(address(l1Token), l2Token);
        }
        uint256 before = l1Token.balanceOf(address(bridge));
        l1Token.forceApprove(address(bridge), amount);
        bridge.depositERC20To(address(l1Token), l2Token, to, amount, MIN_GAS_LIMIT, "");
        uint256 taken = l1Token.balanceOf(address(bridge)) - before;
        if (taken != amount) revert BridgeTookWrongAmount(taken);
    }
}
