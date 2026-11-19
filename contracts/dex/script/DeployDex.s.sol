// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

interface IDexFactory {
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IDexRouter {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

/// @notice Deploys LONGYU Swap (UniswapV2Factory and UniswapV2Router02) from this project's artifacts.
/// @dev Environment:
///      FEE_TO_SETTER  required: the founders' multisig, the only account that can turn the 0.05%
///                     protocol fee on (setFeeTo) or hand the role over (setFeeToSetter). feeTo stays off.
///      WETH           optional: the wrapped gas token, default 0x4200...0006 (the OP Stack WETH9
///                     predeploy, which wraps BNB on LONGYU). It must already have code.
///      Run: forge script script/DeployDex.s.sol --rpc-url $LONGYU_RPC --broadcast [signer flags]
contract DeployDex is Script {
    address public constant DEFAULT_WETH = 0x4200000000000000000000000000000000000006;
    /// @dev keccak256 of the UniswapV2Pair creation code; the router's UniswapV2Library hard-codes it.
    bytes32 public constant INIT_CODE_HASH =
        0x1907514ce58ff8bfdf875cc39008a411896e40d361d744a143d33cb957350a5f;

    error FeeToSetterRequired();
    error WethHasNoCode(address weth);
    error PairCodeMismatch(bytes32 actual);
    error RouterHashMismatch();
    error CreateFailed();
    error DeploymentMismatch();

    struct Deployment {
        address factory;
        address router;
    }

    function run() external returns (Deployment memory d) {
        address feeToSetter = vm.envAddress("FEE_TO_SETTER");
        address weth = vm.envOr("WETH", DEFAULT_WETH);
        preflight(feeToSetter, weth); // refuse before anything is broadcast

        vm.startBroadcast();
        d = deploy(feeToSetter, weth);
        vm.stopBroadcast();

        // Not broadcast: a local-only pair creation proves the factory puts pairs where the router looks.
        checkPairAddress(d.factory);

        console2.log("chain id           ", block.chainid);
        console2.log("UniswapV2Factory   ", d.factory);
        console2.log("UniswapV2Router02  ", d.router);
        console2.log("WETH (wrapped BNB) ", weth);
        console2.log("feeToSetter        ", feeToSetter);
        console2.log("init code hash     ", vm.toString(INIT_CODE_HASH));
        if (feeToSetter.code.length == 0) {
            console2.log("WARNING: FEE_TO_SETTER has no code; is it the multisig?");
        }
    }

    /// @dev Checks the inputs, and that the artifacts about to be deployed agree on the init code hash.
    function preflight(address feeToSetter, address weth) public view returns (bytes memory routerCode) {
        if (feeToSetter == address(0)) revert FeeToSetterRequired();
        if (weth.code.length == 0) revert WethHasNoCode(weth);
        bytes32 pairHash = keccak256(vm.getCode("UniswapV2Pair.sol:UniswapV2Pair"));
        if (pairHash != INIT_CODE_HASH) revert PairCodeMismatch(pairHash);
        routerCode = vm.getCode("UniswapV2Router02.sol:UniswapV2Router02");
        if (!contains(routerCode, INIT_CODE_HASH)) revert RouterHashMismatch();
    }

    function deploy(address feeToSetter, address weth) public returns (Deployment memory d) {
        bytes memory routerCode = preflight(feeToSetter, weth);
        d.factory = create(
            abi.encodePacked(vm.getCode("UniswapV2Factory.sol:UniswapV2Factory"), abi.encode(feeToSetter))
        );
        d.router = create(abi.encodePacked(routerCode, abi.encode(d.factory, weth)));

        if (
            IDexFactory(d.factory).feeToSetter() != feeToSetter
                || IDexFactory(d.factory).feeTo() != address(0) || IDexRouter(d.router).factory() != d.factory
                || IDexRouter(d.router).WETH() != weth
        ) revert DeploymentMismatch();
    }

    /// @dev createPair makes no calls to the tokens, so two arbitrary addresses are enough.
    function checkPairAddress(address factory) public {
        address t0 = address(uint160(uint256(keccak256("LONGYU Swap check token 0"))));
        address t1 = address(uint160(uint256(keccak256("LONGYU Swap check token 1"))));
        (t0, t1) = t0 < t1 ? (t0, t1) : (t1, t0);
        address expected = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff", factory, keccak256(abi.encodePacked(t0, t1)), INIT_CODE_HASH
                        )
                    )
                )
            )
        );
        if (IDexFactory(factory).createPair(t0, t1) != expected) revert DeploymentMismatch();
    }

    function create(bytes memory initCode) internal returns (address deployed) {
        assembly {
            deployed := create(0, add(initCode, 32), mload(initCode))
        }
        if (deployed == address(0) || deployed.code.length == 0) revert CreateFailed();
    }

    function contains(bytes memory code, bytes32 word) internal pure returns (bool) {
        for (uint256 i = 0; i + 32 <= code.length; i++) {
            bytes32 w;
            assembly {
                w := mload(add(add(code, 32), i))
            }
            if (w == word) return true;
        }
        return false;
    }
}
