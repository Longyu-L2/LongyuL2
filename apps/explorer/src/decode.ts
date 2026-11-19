/**
 * Turns calldata and logs into readable calls and events, using every ABI LONGYU knows: its own
 * contracts (from @longyu/abis), the standard token interfaces and the OP Stack contracts built
 * into every LONGYU genesis. Unknown data is shown raw, never guessed.
 */
import * as abis from "@longyu/abis";
import {
  decodeEventLog,
  decodeFunctionData,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  type Hex,
} from "viem";

const standard = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  // Wrapped BNB (WETH9 predeploy)
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  // OP Stack bridge predeploys
  "event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)",
  "event DepositFinalized(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)",
  "event ERC20BridgeInitiated(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)",
  "event ERC20BridgeFinalized(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)",
  "event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)",
  "event ETHBridgeFinalized(address indexed from, address indexed to, uint256 amount, bytes extraData)",
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
  "event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)",
  "event SentMessageExtension1(address indexed sender, uint256 value)",
  "event RelayedMessage(bytes32 indexed msgHash)",
  "event OptimismMintableERC20Created(address indexed localToken, address indexed remoteToken, address deployer)",
  "function withdraw(address l2Token, uint256 amount, uint32 minGasLimit, bytes extraData) payable",
  "function withdrawTo(address l2Token, address to, uint256 amount, uint32 minGasLimit, bytes extraData) payable",
  "function bridgeETH(uint32 minGasLimit, bytes extraData) payable",
  "function bridgeETHTo(address to, uint32 minGasLimit, bytes extraData) payable",
  "function initiateWithdrawal(address target, uint256 gasLimit, bytes data) payable",
  "function createOptimismMintableERC20(address remoteToken, string name, string symbol) returns (address)",
  "function relayMessage(uint256 nonce, address sender, address target, uint256 value, uint256 minGasLimit, bytes message) payable",
  "function finalizeBridgeERC20(address localToken, address remoteToken, address from, address to, uint256 amount, bytes extraData)",
]);

const functions = new Map<string, AbiFunction[]>();
const events = new Map<string, AbiEvent[]>();
const seen = new Set<string>();

function register(abi: Abi) {
  for (const item of abi) {
    if (item.type === "function") {
      const sel = toFunctionSelector(item);
      const sig = `f:${sel}:${JSON.stringify(item.inputs)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      functions.set(sel, [...(functions.get(sel) ?? []), item]);
    } else if (item.type === "event") {
      const sel = toEventSelector(item);
      const sig = `e:${sel}:${JSON.stringify(item.inputs)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      events.set(sel, [...(events.get(sel) ?? []), item]);
    }
  }
}

register(standard);
for (const [name, value] of Object.entries(abis)) {
  if (name.endsWith("Abi") && Array.isArray(value)) register(value as Abi);
}

export interface DecodedArg {
  name: string;
  type: string;
  value: unknown;
}
export interface Decoded {
  name: string;
  args: DecodedArg[];
}

const argList = (inputs: readonly AbiParameter[], values: readonly unknown[] | Record<string, unknown> | undefined): DecodedArg[] =>
  inputs.map((p, i) => ({
    name: p.name || `arg${i}`,
    type: p.type,
    value: Array.isArray(values) ? values[i] : (values as Record<string, unknown> | undefined)?.[p.name ?? ""],
  }));

export function decodeCall(input: string | null): Decoded | null {
  if (!input || input.length < 10) return null;
  for (const fn of functions.get(input.slice(0, 10)) ?? []) {
    try {
      const { args } = decodeFunctionData({ abi: [fn], data: input as Hex });
      return { name: fn.name, args: argList(fn.inputs, args as readonly unknown[] | undefined) };
    } catch {
      // Try the next function with this selector.
    }
  }
  return null;
}

export function decodeLog(topics: (string | null)[], data: string): Decoded | null {
  const t = topics.filter((x): x is string => Boolean(x)) as [Hex, ...Hex[]];
  if (t.length === 0) return null;
  for (const ev of events.get(t[0]) ?? []) {
    try {
      const out = decodeEventLog({ abi: [ev], topics: t, data: data as Hex, strict: true });
      return { name: ev.name, args: argList(ev.inputs, out.args as Record<string, unknown>) };
    } catch {
      // Indexed layouts differ (ERC-20 vs ERC-721 Transfer): try the next candidate.
    }
  }
  return null;
}

/** Method name for a selector, if exactly one known function has it. */
export function methodName(selector: string | null): string | null {
  if (!selector) return null;
  const fns = functions.get(selector);
  if (!fns?.length) return null;
  const names = new Set(fns.map((f) => f.name));
  return names.size === 1 ? fns[0]!.name : null;
}

export const L2_MESSENGER = "0x4200000000000000000000000000000000000007";
export const L2_BRIDGE = "0x4200000000000000000000000000000000000010";
export const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

export interface BridgedToken {
  token: string;
  amount: bigint;
}

const arg = (d: Decoded | null, name: string) => d?.args.find((a) => a.name === name)?.value;
const isContract = (v: unknown, address: string) => typeof v === "string" && v.toLowerCase() === address;
const callIn = (data: unknown) => (typeof data === "string" ? decodeCall(data) : null);

/**
 * The LONGYU token and the amount a bridge event records, or null when it records none. A deposit:
 * the bridge's ERC20BridgeFinalized. A withdrawal: MessagePassed from the messenger, relaying the
 * bridge's finalizeBridgeERC20 to BSC, where the two tokens are named the other way round. The
 * message passer, the messenger and the bridge each record who called them, so no other contract
 * can write either event.
 */
export function bridgedToken(l: { address: string; topic0: string | null; topic1: string | null; topic2: string | null; topic3: string | null; data: string }): BridgedToken | null {
  const d = decodeLog([l.topic0, l.topic1, l.topic2, l.topic3], l.data);
  let token: unknown;
  let amount: unknown;
  if (l.address === L2_BRIDGE && d?.name === "ERC20BridgeFinalized") {
    [token, amount] = [arg(d, "localToken"), arg(d, "amount")];
  } else if (l.address === MESSAGE_PASSER && d?.name === "MessagePassed" && isContract(arg(d, "sender"), L2_MESSENGER)) {
    const relay = callIn(arg(d, "data"));
    const message = relay?.name === "relayMessage" && isContract(arg(relay, "sender"), L2_BRIDGE) ? callIn(arg(relay, "message")) : null;
    if (message?.name === "finalizeBridgeERC20") [token, amount] = [arg(message, "remoteToken"), arg(message, "amount")];
  }
  return typeof token === "string" && typeof amount === "bigint" ? { token: token.toLowerCase(), amount } : null;
}

/** Contracts every LONGYU genesis contains, plus the deposit system account. */
export const PREDEPLOYS: Record<string, string> = {
  "0x4200000000000000000000000000000000000006": "Wrapped BNB",
  "0x4200000000000000000000000000000000000007": "L2 Cross-Domain Messenger",
  "0x420000000000000000000000000000000000000f": "Gas Price Oracle",
  "0x4200000000000000000000000000000000000010": "L2 Standard Bridge",
  "0x4200000000000000000000000000000000000011": "Sequencer Fee Vault",
  "0x4200000000000000000000000000000000000012": "Token Factory (Optimism Mintable ERC-20)",
  "0x4200000000000000000000000000000000000015": "L1 Block",
  "0x4200000000000000000000000000000000000016": "L2 to L1 Message Passer",
  "0x4200000000000000000000000000000000000019": "Base Fee Vault",
  "0x420000000000000000000000000000000000001a": "L1 Fee Vault",
  "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001": "System (L1 attributes)",
};
