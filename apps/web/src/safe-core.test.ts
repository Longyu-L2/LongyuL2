import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { CANCELLED } from "./bridge-core.ts";
import {
  CALLS,
  CHAIN_NAMES,
  GUARD_SLOT,
  MAX_DATA_BYTES,
  SAFE_VERSION,
  chooseSigners,
  decodeCall,
  encodeCall,
  encodeLink,
  execArgs,
  formatValue,
  hashArgs,
  packApprovals,
  parseArg,
  parseData,
  parseLink,
  parseSafeConfig,
  safeAbi,
  safeErrorMessage,
  safeTxHash,
  stageOf,
  type SafeLink,
} from "./safe-core.ts";

const SAFE: Address = "0x7b47bB59dD70457d08C5c639Edd0f7647BA9A66D";
const TLONG: Address = "0x88d5B1946BaB654e31Fbf0bcc3D022e995aB129C";
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";
const C: Address = "0xaec9643e4f011e8343B61C44675ac107A73267bF";
const call = (signature: string) => CALLS.find((c) => c.signature === signature)!;

test("the hash equals the one the Safe computes", () => {
  // Answers of getTransactionHash from the Safe v1.3.0 that owns the rollup's upgrade admin on BSC testnet.
  const transfer: Hex = "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000de0b6b3a7640000";
  assert.equal(safeTxHash(97, SAFE, { to: TLONG, value: 0n, data: transfer, nonce: 7n }), "0x7e86ca1e933f9d596434f2817e48d66177646ac66a4d285b554134c6a5206e6d");
  assert.equal(safeTxHash(97, SAFE, { to: DEAD, value: 12345n, data: "0x", nonce: 0n }), "0xdd430eeb09bd21450c6ab30170b4a7534753b092b479682ce8b63845094385e9");
  // And from a Safe created on LONGYU testnet with contracts/script/CreateSafe.s.sol.
  const onLongyu: Hex = "0xa9059cbb000000000000000000000000aec9643e4f011e8343b61c44675ac107a73267bf0000000000000000000000000000000000000000000000004563918244f40000";
  assert.equal(
    safeTxHash(668801, "0x6E5B7798aC2F6C9d617bDaa57CA148558eAfF65a", { to: "0xF4769160D6dc78F66f61F0eA1638E65d43610163", value: 0n, data: onLongyu, nonce: 0n }),
    "0x0fdd5991c0c1233ffb435b9e2e13d8e3ca3a530a6cd14c05efe1b4d7e4990ee7",
  );
  // Another chain, Safe or nonce gives another hash: an approval cannot be reused.
  const tx = { to: DEAD, value: 12345n, data: "0x" as Hex, nonce: 0n };
  const hashes = new Set([safeTxHash(97, SAFE, tx), safeTxHash(668801, SAFE, tx), safeTxHash(97, TLONG, tx), safeTxHash(97, SAFE, { ...tx, nonce: 1n })]);
  assert.equal(hashes.size, 4);
});

test("the Safe is asked about a plain call that pays no refund", () => {
  const tx = { to: DEAD, value: 5n, data: "0x1234" as Hex, nonce: 9n };
  const zero = "0x0000000000000000000000000000000000000000";
  assert.deepEqual(hashArgs(tx), [DEAD, 5n, "0x1234", 0, 0n, 0n, 0n, zero, zero, 9n]);
  assert.deepEqual(execArgs(tx, "0xabcd"), [DEAD, 5n, "0x1234", 0, 0n, 0n, 0n, zero, zero, "0xabcd"]);
  assert.equal(SAFE_VERSION, "1.3.0");
  // keccak256("guard_manager.guard.address"), from Safe v1.3.0's GuardManager.
  assert.equal(GUARD_SLOT, "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8");
  assert.deepEqual(CHAIN_NAMES, { 97: "BSC Testnet", 668801: "LONGYU Testnet" });
});

test("the page's Safe functions are Safe v1.3.0's", () => {
  const selector = (name: string) => toFunctionSelector(safeAbi.find((x) => x.type === "function" && x.name === name) as never);
  assert.equal(selector("approveHash"), "0xd4d9bdcd");
  assert.equal(selector("execTransaction"), "0x6a761202");
  assert.equal(selector("getTransactionHash"), "0xd8d11f78");
  assert.equal(selector("approvedHashes"), "0x7d832974");
  assert.equal(selector("getOwners"), "0xa0e67e2b");
  assert.equal(selector("getThreshold"), "0xe75235b8");
  assert.equal(selector("nonce"), "0xaffed0e0");
  assert.equal(selector("getModulesPaginated"), "0xcc2f8452");
  assert.equal(selector("getStorageAt"), "0x5624b25b");
  assert.equal(selector("VERSION"), "0xffa1ad74");
});

test("stage: a nonce is used, ready or queued", () => {
  assert.equal(stageOf(3n, 4n), "used");
  assert.equal(stageOf(4n, 4n), "ready");
  assert.equal(stageOf(5n, 4n), "queued");
});

test("signers: those who approved, and the sender when a signer", () => {
  const owners = [C, B, A];
  const approved = (...list: Address[]) => new Set(list.map((x) => x.toLowerCase()));
  assert.equal(chooseSigners(owners, approved(), null, 2), null);
  assert.equal(chooseSigners(owners, approved(A), null, 2), null);
  // Ascending by address, whatever the order of the Safe's list.
  assert.deepEqual(chooseSigners(owners, approved(C, A), null, 2), [A, C]);
  assert.deepEqual(chooseSigners(owners, approved(B), C, 2), [B, C]);
  assert.deepEqual(chooseSigners(owners, approved(B), C.toLowerCase() as Address, 2), [B, C]);
  // Exactly the threshold, lowest first.
  assert.deepEqual(chooseSigners(owners, approved(A, B, C), C, 2), [A, B]);
  assert.deepEqual(chooseSigners(owners, approved(), A, 1), [A]);
  // A sender or an approval from outside the Safe counts for nothing.
  assert.equal(chooseSigners(owners, approved(A), DEAD, 2), null);
  assert.equal(chooseSigners(owners, approved(A, DEAD), null, 2), null);
  // A sender who also approved counts once.
  assert.equal(chooseSigners(owners, approved(A), A, 2), null);
  assert.equal(chooseSigners(owners, approved(A, B), null, 0), null);
  assert.equal(chooseSigners(owners, approved(A, B), null, 1.5), null);
});

test("approvals are packed as the Safe reads them", () => {
  const word = (s: string) => s.padStart(64, "0");
  assert.equal(packApprovals([]), "0x");
  assert.equal(packApprovals([A]), `0x${word("1111111111111111111111111111111111111111")}${word("")}01`);
  const two = `0x${word("2222222222222222222222222222222222222222")}${word("")}01${word("aec9643e4f011e8343b61c44675ac107a73267bf")}${word("")}01`;
  assert.equal(packApprovals([C, B]), two);
  assert.equal(packApprovals([B, C]), two);
  assert.equal(packApprovals([B, C, B]), two);
  assert.equal((packApprovals([A, B, C]).length - 2) / 2, 3 * 65);
});

test("link: a transaction survives the round trip", () => {
  const links: SafeLink[] = [
    { chainId: 97, safe: SAFE, tx: null },
    { chainId: 668801, safe: SAFE, tx: { to: DEAD, value: 12345n, data: "0x", nonce: 0n } },
    { chainId: 97, safe: SAFE, tx: { to: TLONG, value: 0n, data: "0xa9059cbb00ff", nonce: 123456789012345678n } },
    { chainId: 97, safe: SAFE, tx: { to: SAFE, value: 2n ** 256n - 1n, data: `0x${"ab".repeat(MAX_DATA_BYTES)}`, nonce: 7n } },
  ];
  for (const link of links) assert.deepEqual(parseLink(encodeLink(link)), link);
  assert.equal(encodeLink(links[0]!), `#chain=97&safe=${SAFE}`);
  assert.equal(encodeLink(links[1]!), `#chain=668801&safe=${SAFE}&to=${DEAD}&value=12345&data=0x&nonce=0`);
  assert.deepEqual(parseLink(encodeLink(links[1]!).slice(1)), links[1]);
});

test("link: anything unexpected is refused whole", () => {
  const base = { chain: "97", safe: SAFE, to: DEAD, value: "1", data: "0x", nonce: "0" };
  const link = (o: Record<string, string>) => `#${new URLSearchParams(o).toString()}`;
  assert.ok(parseLink(link(base)));
  const bad: Record<string, string>[] = [
    { ...base, chain: "56" },
    { ...base, chain: "097" },
    { ...base, chain: "97.0" },
    { ...base, chain: "0x61" },
    { ...base, safe: SAFE.toLowerCase().replace("0x7b", "0x7B") }, // a wrong checksum
    { ...base, safe: "0x0000000000000000000000000000000000000000" },
    { ...base, safe: SAFE.slice(0, 40) },
    { ...base, to: "vitalik.eth" },
    { ...base, value: "-1" },
    { ...base, value: "1.5" },
    { ...base, value: "01" },
    { ...base, value: "0x1" },
    { ...base, value: (2n ** 256n).toString() },
    { ...base, nonce: "" },
    { ...base, nonce: "1e3" },
    { ...base, nonce: "1234567890123456789" },
    { ...base, data: "" },
    { ...base, data: "0x1" },
    { ...base, data: "0xzz" },
    { ...base, data: "1234" },
    { ...base, data: `0x${"ab".repeat(MAX_DATA_BYTES + 1)}` },
    { ...base, operation: "1" },
    { ...base, signature: "transfer(address,uint256)" },
    { chain: "97" },
    { safe: SAFE },
    { chain: "97", safe: SAFE, to: DEAD },
    { chain: "97", safe: SAFE, to: DEAD, value: "1", data: "0x" },
  ];
  for (const o of bad) assert.equal(parseLink(link(o)), null, JSON.stringify(o).slice(0, 120));
  // A repeated key is not a link this page wrote.
  assert.equal(parseLink(`${link(base)}&to=${TLONG}`), null);
  assert.equal(parseLink(`#chain=97&chain=97&safe=${SAFE}`), null);
  assert.equal(parseLink(""), null);
  assert.equal(parseLink("#"), null);
  assert.equal(parseLink("#safe"), null);
  // Upper-case data is read as the same bytes.
  assert.equal(parseLink(link({ ...base, data: "0xABCD" }))?.tx?.data, "0xabcd");
});

test("catalogue: every selector names one call", () => {
  assert.equal(new Set(CALLS.map((c) => c.selector)).size, CALLS.length);
  for (const c of CALLS) {
    assert.equal(c.selector, toFunctionSelector(c.fn), c.signature);
    assert.notEqual(c.fn.stateMutability, "view", c.signature);
    assert.notEqual(c.fn.stateMutability, "pure", c.signature);
  }
  // Selectors as published for these functions.
  const known: [string, string][] = [
    ["transfer(address to, uint256 amount)", "0xa9059cbb"],
    ["approve(address spender, uint256 amount)", "0x095ea7b3"],
    ["transferOwnership(address newOwner)", "0xf2fde38b"],
    ["renounceOwnership()", "0x715018a6"],
    ["addOwnerWithThreshold(address owner, uint256 _threshold)", "0x0d582f13"],
    ["removeOwner(address prevOwner, address owner, uint256 _threshold)", "0xf8dc5dd9"],
    ["swapOwner(address prevOwner, address oldOwner, address newOwner)", "0xe318b52b"],
    ["changeThreshold(uint256 _threshold)", "0x694e80c3"],
    ["enableModule(address module)", "0x610b5925"],
    ["setGuard(address guard)", "0xe19a9dd9"],
    ["setFeeTo(address _feeTo)", "0xf46901ed"],
    ["setFeeToSetter(address _feeToSetter)", "0xa2e74af6"],
    ["upgrade(address _proxy, address _implementation)", "0x99a88ec4"],
    ["upgradeAndCall(address _proxy, address _implementation, bytes _data)", "0x9623609d"],
    ["changeProxyAdmin(address _proxy, address _newAdmin)", "0x7eff275e"],
    ["setUnsafeBlockSigner(address _unsafeBlockSigner)", "0x18d13918"],
    ["setBatcherHash(bytes32 _batcherHash)", "0xc9b26f61"],
    ["setGasConfig(uint256 _overhead, uint256 _scalar)", "0x935f029e"],
    ["setGasConfigEcotone(uint32 _basefeeScalar, uint32 _blobbasefeeScalar)", "0x21d7fde5"],
    ["setGasLimit(uint64 _gasLimit)", "0xb40a817c"],
    ["setRequired(uint256 _required)", "0x0457d6f2"],
    ["setRecommended(uint256 _recommended)", "0x5fd579af"],
    ["setImplementation(uint32 _gameType, address _impl)", "0x14f6b1a3"],
    ["setInitBond(uint32 _gameType, uint256 _initBond)", "0x1e334240"],
  ];
  for (const [signature, selector] of known) assert.equal(call(signature)?.selector, selector, signature);
  // The Safe's own approve and execute are sent by a signer, never proposed through the Safe.
  for (const selector of ["0xd4d9bdcd", "0x6a761202"]) assert.equal(CALLS.find((c) => c.selector === selector), undefined);
  // LONGYU's own contracts are in the list too.
  for (const name of ["pause", "unpause", "grantRole", "revokeRole"]) assert.ok(CALLS.some((c) => c.fn.name === name), name);
});

test("decode: a known call is named with its arguments", () => {
  const data = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), args: [DEAD, 5n * 10n ** 18n] });
  const decoded = decodeCall(data)!;
  assert.equal(decoded.call.fn.name, "transfer");
  assert.deepEqual(decoded.args, [
    { name: "to", type: "address", value: DEAD },
    { name: "amount", type: "uint256", value: "5000000000000000000 (5 × 10^18)" },
  ]);
  assert.deepEqual(decodeCall("0x715018a6")?.args, []);
  assert.equal(decodeCall(data.toUpperCase().replace("0X", "0x") as Hex)?.call.fn.name, "transfer");
  const upgrade = encodeFunctionData({ abi: parseAbi(["function upgradeAndCall(address _proxy, address _implementation, bytes _data) payable"]), args: [A, B, "0x8129fc1c"] });
  assert.deepEqual(decodeCall(upgrade)?.args.map((a) => a.value), [A, B, "0x8129fc1c"]);
});

test("decode: anything else stays raw", () => {
  const data = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), args: [DEAD, 1n] });
  assert.equal(decodeCall("0x"), null);
  assert.equal(decodeCall("0xa9059c"), null);
  assert.equal(decodeCall("0xdeadbeef"), null);
  // The right selector with missing, extra or malformed arguments.
  assert.equal(decodeCall("0xa9059cbb"), null);
  assert.equal(decodeCall(data.slice(0, -2) as Hex), null);
  assert.equal(decodeCall(`${data}00` as Hex), null);
  assert.equal(decodeCall(`${data}${"00".repeat(32)}` as Hex), null);
  assert.equal(decodeCall(`0xa9059cbb${"ff".repeat(32)}${"00".repeat(32)}` as Hex), null);
  // A read-only function is not a call a Safe needs to make.
  assert.equal(decodeCall("0x70a08231000000000000000000000000000000000000000000000000000000000000dead"), null);
});

test("values are shown in full", () => {
  assert.equal(formatValue(0n), "0");
  assert.equal(formatValue(999_999_999_999_999n), "999999999999999");
  assert.equal(formatValue(10n ** 15n), "1000000000000000 (0.001 × 10^18)");
  assert.equal(formatValue(true), "true");
  assert.equal(formatValue("0xab"), "0xab");
  assert.equal(formatValue([1n, "x"]), '["1","x"]');
});

test("form: each argument type is read strictly", () => {
  assert.equal(parseArg("address", ` ${DEAD} `), DEAD);
  assert.equal(parseArg("address", DEAD.toLowerCase()), DEAD);
  assert.throws(() => parseArg("address", "0x000000000000000000000000000000000000DEAD"), /Not a valid address/); // a wrong checksum
  assert.throws(() => parseArg("address", "0x1234"), /Not a valid address/);
  assert.throws(() => parseArg("address", ""), /Not a valid address/);
  assert.equal(parseArg("bool", "true"), true);
  assert.equal(parseArg("bool", "false"), false);
  assert.throws(() => parseArg("bool", "1"), /true or false/);
  assert.equal(parseArg("string", " as typed "), " as typed ");
  assert.equal(parseArg("bytes", "0x"), "0x");
  assert.equal(parseArg("bytes", "0xABcd"), "0xabcd");
  assert.throws(() => parseArg("bytes", "0xabc"), /hex bytes/);
  assert.throws(() => parseArg("bytes", "abcd"), /hex bytes/);
  assert.equal(parseArg("bytes32", `0x${"11".repeat(32)}`), `0x${"11".repeat(32)}`);
  assert.throws(() => parseArg("bytes32", `0x${"11".repeat(31)}`), /exactly 32 bytes/);
  assert.throws(() => parseArg("bytes4", "0x"), /exactly 4 bytes/);

  assert.equal(parseArg("uint256", "0"), 0n);
  assert.equal(parseArg("uint256", " 42 "), 42n);
  assert.equal(parseArg("uint256", "5e18"), 5n * 10n ** 18n);
  assert.equal(parseArg("uint256", "1.5e18"), 15n * 10n ** 17n);
  assert.equal(parseArg("uint256", "0.001e18"), 10n ** 15n);
  assert.equal(parseArg("uint256", (2n ** 256n - 1n).toString()), 2n ** 256n - 1n);
  assert.throws(() => parseArg("uint256", (2n ** 256n).toString()), /Out of range/);
  assert.throws(() => parseArg("uint256", "-1"), /Out of range/);
  assert.throws(() => parseArg("uint256", "1.5"), /whole number/);
  assert.throws(() => parseArg("uint256", "1.55e1"), /whole number/);
  assert.throws(() => parseArg("uint256", "0x10"), /whole number/);
  assert.throws(() => parseArg("uint256", "1,000"), /whole number/);
  assert.throws(() => parseArg("uint256", ""), /whole number/);
  assert.throws(() => parseArg("uint256", "1e99"), /Out of range/);
  assert.throws(() => parseArg("uint256", "1e100"), /whole number/);
  assert.equal(parseArg("uint8", "255"), 255n);
  assert.throws(() => parseArg("uint8", "256"), /Out of range for uint8/);
  assert.equal(parseArg("uint64", "3e7"), 30_000_000n);
  assert.equal(parseArg("int8", "-128"), -128n);
  assert.throws(() => parseArg("int8", "128"), /Out of range/);
  for (const type of ["address[]", "tuple", "uint256[2]", "bytes33", "uint7", "function"]) assert.throws(() => parseArg(type, "1"), /Use raw data/, type);
});

test("form: a call is encoded as the contract expects it", () => {
  const abi = parseAbi([
    "function transfer(address to, uint256 amount)",
    "function addOwnerWithThreshold(address owner, uint256 _threshold)",
    "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
    "function setUpgrading(bool _upgrading)",
    "function setAddress(string _name, address _address)",
    "function setBatcherHash(bytes32 _batcherHash)",
  ]);
  assert.equal(encodeCall(call("transfer(address to, uint256 amount)"), [DEAD, "5e18"]), encodeFunctionData({ abi, functionName: "transfer", args: [DEAD, 5n * 10n ** 18n] }));
  assert.equal(encodeCall(call("addOwnerWithThreshold(address owner, uint256 _threshold)"), [A, "2"]), encodeFunctionData({ abi, functionName: "addOwnerWithThreshold", args: [A, 2n] }));
  assert.equal(
    encodeCall(call("removeOwner(address prevOwner, address owner, uint256 _threshold)"), ["0x0000000000000000000000000000000000000001", C, "2"]),
    encodeFunctionData({ abi, functionName: "removeOwner", args: ["0x0000000000000000000000000000000000000001", C, 2n] }),
  );
  assert.equal(encodeCall(call("setUpgrading(bool _upgrading)"), ["true"]), encodeFunctionData({ abi, functionName: "setUpgrading", args: [true] }));
  assert.equal(encodeCall(call("setAddress(string _name, address _address)"), ["OVM_L1CrossDomainMessenger", A]), encodeFunctionData({ abi, functionName: "setAddress", args: ["OVM_L1CrossDomainMessenger", A] }));
  const hash = `0x${"00".repeat(12)}${A.slice(2)}` as Hex;
  assert.equal(encodeCall(call("setBatcherHash(bytes32 _batcherHash)"), [hash]), encodeFunctionData({ abi, functionName: "setBatcherHash", args: [hash] }));
  assert.equal(encodeCall(call("renounceOwnership()"), []), "0x715018a6");
  assert.throws(() => encodeCall(call("transfer(address to, uint256 amount)"), [DEAD]), /Fill in every argument/);
  assert.throws(() => encodeCall(call("transfer(address to, uint256 amount)"), [DEAD, "five"]), /^Error: amount: Use a whole number\.$/);
  assert.throws(() => encodeCall(call("transfer(address to, uint256 amount)"), ["", "1"]), /^Error: to: Not a valid address\.$/);
  // What the form builds, the page reads back as the same call.
  for (const c of CALLS.filter((x) => x.simple)) {
    const texts = c.fn.inputs.map((i) => (i.type === "address" ? DEAD : i.type === "bool" ? "true" : i.type === "string" ? "name" : i.type === "bytes" ? "0x1234" : i.type.startsWith("bytes") ? `0x${"ab".repeat(Number(i.type.slice(5)))}` : "7"));
    assert.equal(decodeCall(encodeCall(c, texts))?.call.selector, c.selector, c.signature);
  }
});

test("form: raw data is hex bytes or nothing", () => {
  assert.equal(parseData(""), "0x");
  assert.equal(parseData(" 0x "), "0x");
  assert.equal(parseData("0xABCD"), "0xabcd");
  assert.equal(parseData("0xabc"), null);
  assert.equal(parseData("abcd"), null);
  assert.equal(parseData("0xzz"), null);
  assert.equal(parseData(`0x${"00".repeat(MAX_DATA_BYTES)}`)?.length, 2 + 2 * MAX_DATA_BYTES);
  assert.equal(parseData(`0x${"00".repeat(MAX_DATA_BYTES + 1)}`), null);
});

test("configuration: the LONGYU RPC is required, addresses are https", () => {
  const good = { l1RpcUrl: "", l2RpcUrl: "https://rpc.example", explorerUrl: "https://explorer.example/" };
  assert.deepEqual(parseSafeConfig(good), { ok: true, config: { l1RpcUrl: "https://bsc-testnet-rpc.publicnode.com", l2RpcUrl: "https://rpc.example", explorerUrl: "https://explorer.example" } });
  assert.deepEqual(parseSafeConfig({ ...good, l1RpcUrl: "https://bsc.example", explorerUrl: "" }), { ok: true, config: { l1RpcUrl: "https://bsc.example", l2RpcUrl: "https://rpc.example", explorerUrl: null } });
  const problems = (raw: Parameters<typeof parseSafeConfig>[0]) => {
    const r = parseSafeConfig(raw);
    return r.ok ? [] : r.problems;
  };
  assert.deepEqual(problems(null), ["L2_RPC_URL is missing"]);
  assert.deepEqual(problems({ ...good, l2RpcUrl: " " }), ["L2_RPC_URL is missing"]);
  assert.deepEqual(problems({ ...good, l2RpcUrl: "http://rpc.example" }), ["L2_RPC_URL is not an https URL"]);
  assert.deepEqual(problems({ ...good, l1RpcUrl: "ftp://bsc.example" }), ["L1_RPC_URL is not an https URL"]);
  assert.deepEqual(problems({ ...good, explorerUrl: "javascript:alert(1)" }), ["EXPLORER_URL is not an https URL"]);
});

test("a Safe's refusals are put in plain words", () => {
  const revert = (reason: string) => Object.assign(new Error("call failed"), { shortMessage: "Execution reverted", cause: { message: `execution reverted: ${reason}` } });
  assert.equal(safeErrorMessage(revert("GS013")), "The transaction inside would fail.");
  for (const code of ["GS020", "GS025", "GS026"]) assert.equal(safeErrorMessage(revert(code)), "Not enough approvals.", code);
  assert.equal(safeErrorMessage(revert("GS030")), "Only a signer of this Safe can approve.");
  assert.equal(safeErrorMessage(revert("GS031")), "Only the Safe itself can do that.");
  assert.equal(safeErrorMessage(Object.assign(new Error("x"), { code: 4001 })), CANCELLED);
  assert.equal(safeErrorMessage(new Error("Not enough tBNB for gas.")), "Not enough tBNB for gas.");
});

test("the page: no script or style from elsewhere, and nothing from a link becomes markup", () => {
  const html = readFileSync(new URL("./safe.html", import.meta.url), "utf8");
  const page = readFileSync(new URL("./safe.ts", import.meta.url), "utf8");
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src https: http:\/\/localhost:\*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; object-src 'none'" \/>/);
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.equal([...html.matchAll(/<script\b[^>]*>/g)].length, 1);
  assert.match(html, /<script type="module" src="\.\/safe\.js"><\/script>/);
  assert.doesNotMatch(html, /\son[a-z]+=|javascript:/i);
  assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  // Every element the script looks up exists once in the page.
  const ids = new Set([...page.matchAll(/(?:\$|show)\("([a-z0-9-]+)"/g)].map((m) => m[1]!));
  assert.ok(ids.size > 30);
  for (const id of ids) assert.equal([...html.matchAll(new RegExp(`\\sid="${id}"`, "g"))].length, 1, id);
  // A Safe transaction from this page is always a plain call: no delegate call can be proposed or executed.
  assert.doesNotMatch(page, /operation/i);
});
