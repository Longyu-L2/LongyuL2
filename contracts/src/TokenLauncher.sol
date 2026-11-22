// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title LaunchedToken
/// @notice A plain token made with TokenLauncher: 18 decimals, the whole supply minted once to its
///         creator. No owner, no further minting, no fees, no blocklist, no pause: once launched,
///         nobody (its creator included) can change it.
contract LaunchedToken is ERC20, ERC20Permit {
    /// @notice The account that launched it.
    address public immutable creator;

    constructor(string memory name_, string memory symbol_, uint256 supply, address creator_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        creator = creator_;
        _mint(creator_, supply);
    }
}

/// @title TokenLauncher
/// @notice Lets anyone launch a LaunchedToken on LONGYU, free of charge (gas only). It has no owner
///         and no settings. Names that pass for LONGYU's own token are refused: a symbol that reads
///         LONG, TLONG or WLONG, or a name or symbol with LONGYU in it (case, spacing, punctuation and
///         the digits 0 and 1 for O and L ignored). Names and symbols are plain ASCII, so letters from
///         other alphabets cannot imitate them either.
contract TokenLauncher {
    /// @notice Supply limits, in whole tokens. The upper one keeps every pool's reserves within the
    ///         uint112 a LONGYU Swap pair can hold.
    uint256 public constant MIN_SUPPLY = 1;
    uint256 public constant MAX_SUPPLY = 1e15;
    uint256 public constant MAX_NAME_BYTES = 32;
    uint256 public constant MAX_SYMBOL_BYTES = 11;

    /// @notice Every token launched here, oldest first.
    address[] public tokens;
    /// @notice Whether a token was launched here (so it is a plain LaunchedToken).
    mapping(address => bool) public launched;

    event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 supply);

    error BadName();
    error BadSymbol();
    error BadSupply();
    error ReservedName();

    /// @notice Launches a token; the whole supply goes to the caller.
    /// @param name_ 1 to 32 printable ASCII characters, not starting or ending with a space.
    /// @param symbol_ 1 to 11 letters and digits.
    /// @param wholeTokens The supply in whole tokens (18 decimals each), from 1 to 10^15.
    function launch(string calldata name_, string calldata symbol_, uint256 wholeTokens)
        external
        returns (address token)
    {
        if (!_isName(bytes(name_))) revert BadName();
        if (!_isSymbol(bytes(symbol_))) revert BadSymbol();
        if (wholeTokens < MIN_SUPPLY || wholeTokens > MAX_SUPPLY) revert BadSupply();
        if (passesForLongyu(name_, symbol_)) revert ReservedName();

        uint256 supply = wholeTokens * 1e18;
        token = address(new LaunchedToken(name_, symbol_, supply, msg.sender));
        tokens.push(token);
        launched[token] = true;
        emit TokenLaunched(token, msg.sender, name_, symbol_, supply);
    }

    /// @notice How many tokens were launched here.
    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /// @notice Up to `count` launched tokens from index `start` (oldest first).
    function tokensFrom(uint256 start, uint256 count) external view returns (address[] memory page) {
        uint256 total = tokens.length;
        if (start >= total) return new address[](0);
        uint256 end = start + count > total ? total : start + count;
        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            page[i - start] = tokens[i];
        }
    }

    /// @notice Whether a name or symbol passes for LONGYU's own token (see the contract notice).
    function passesForLongyu(string memory name_, string memory symbol_) public pure returns (bool) {
        bytes memory n = _reads(bytes(name_));
        bytes memory s = _reads(bytes(symbol_));
        return _isLong(n) || _isLong(s) || _contains(n, "LONGYU") || _contains(s, "LONGYU");
    }

    // ------------------------------------------------------------------ internals

    function _isName(bytes memory b) private pure returns (bool) {
        if (b.length == 0 || b.length > MAX_NAME_BYTES || b[0] == 0x20 || b[b.length - 1] == 0x20) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (uint8(b[i]) < 0x20 || uint8(b[i]) > 0x7e) return false;
        }
        return true;
    }

    function _isSymbol(bytes memory b) private pure returns (bool) {
        if (b.length == 0 || b.length > MAX_SYMBOL_BYTES) return false;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            bool digit = c >= 0x30 && c <= 0x39;
            bool upper = c >= 0x41 && c <= 0x5a;
            bool lower = c >= 0x61 && c <= 0x7a;
            if (!digit && !upper && !lower) return false;
        }
        return true;
    }

    /// @dev The text as it reads: capitals, 0 as O and 1 as L, only A to Z kept.
    function _reads(bytes memory b) private pure returns (bytes memory out) {
        out = new bytes(b.length);
        uint256 n;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 0x61 && c <= 0x7a) c -= 0x20;
            else if (c == 0x30) c = 0x4f; // 0 -> O
            else if (c == 0x31 || c == 0x7c) c = 0x4c; // 1 and | -> L
            if (c >= 0x41 && c <= 0x5a) out[n++] = bytes1(c);
        }
        assembly {
            mstore(out, n)
        }
    }

    function _isLong(bytes memory b) private pure returns (bool) {
        bytes32 h = keccak256(b);
        return h == keccak256("LONG") || h == keccak256("TLONG") || h == keccak256("WLONG");
    }

    function _contains(bytes memory hay, bytes memory needle) private pure returns (bool) {
        if (needle.length > hay.length) return false;
        for (uint256 i = 0; i + needle.length <= hay.length; i++) {
            bool same = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    same = false;
                    break;
                }
            }
            if (same) return true;
        }
        return false;
    }
}
