// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test helper that builds Merkle trees compatible with OpenZeppelin's MerkleProof
///         (commutative, sorted-pair keccak256). Odd nodes are promoted unchanged.
library Merkle {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "empty");
        bytes32[] memory layer = leaves;
        while (layer.length > 1) {
            layer = _next(layer);
        }
        return layer[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        require(index < leaves.length, "index");
        bytes32[] memory tmp = new bytes32[](64);
        uint256 n;
        bytes32[] memory layer = leaves;
        uint256 i = index;
        while (layer.length > 1) {
            uint256 sibling = i ^ 1;
            if (sibling < layer.length) tmp[n++] = layer[sibling];
            layer = _next(layer);
            i /= 2;
        }
        bytes32[] memory out = new bytes32[](n);
        for (uint256 k; k < n; ++k) {
            out[k] = tmp[k];
        }
        return out;
    }

    function _next(bytes32[] memory layer) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((layer.length + 1) / 2);
        for (uint256 i; i < layer.length; i += 2) {
            next[i / 2] = i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i];
        }
    }
}
