import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as core from "./launch-core.ts";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Log } from "viem";
import { CANCELLED } from "./bridge-core.ts";
import {
  MAX_NAME,
  MAX_SUPPLY,
  MAX_SYMBOL,
  MIN_SUPPLY,
  RESERVED,
  checkLaunch,
  formatWhole,
  launchErrorMessage,
  launchedToken,
  nameProblem,
  parseLaunchConfig,
  parseSupply,
  symbolProblem,
  tokenLinks,
} from "./launch-core.ts";
import { WBNB, launcherAbi, passesForLongyu } from "./swap-core.ts";

const LAUNCHER: Address = "0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF";
const RPC = "https://rpc.longyu.example";
const raw = { launcher: LAUNCHER, rpcUrl: RPC, explorerUrl: "https://scan.longyu.example/", swapPage: true };
const source = readFileSync(new URL("../../../contracts/src/TokenLauncher.sol", import.meta.url), "utf8");

test("settings: a complete set is accepted, and nothing is guessed", () => {
  assert.deepEqual(parseLaunchConfig(raw), { ok: true, config: { launcher: LAUNCHER, rpcUrl: RPC, explorerUrl: "https://scan.longyu.example", swapPage: true, apiUrl: null } });
  const plain = parseLaunchConfig({ ...raw, launcher: LAUNCHER.toLowerCase(), explorerUrl: "", swapPage: undefined });
  assert.deepEqual(plain, { ok: true, config: { launcher: LAUNCHER, rpcUrl: RPC, explorerUrl: null, swapPage: false, apiUrl: null } });
  const withApi = parseLaunchConfig({ ...raw, apiUrl: "https://api.longyu.network/" });
  assert.ok(withApi.ok && withApi.config.apiUrl === "https://api.longyu.network");
  const refused = (change: Record<string, unknown>) => {
    const parsed = parseLaunchConfig({ ...raw, ...change });
    assert.ok(!parsed.ok);
    return parsed.problems;
  };
  assert.deepEqual(refused({ launcher: "", rpcUrl: "" }), ["TOKEN_LAUNCHER is missing", "L2_RPC_URL is missing"]);
  for (const nothing of [null, undefined, {}]) assert.equal(parseLaunchConfig(nothing).ok, false);
  assert.deepEqual(refused({ launcher: "0x1234" }), ["TOKEN_LAUNCHER is not a valid address"]);
  assert.deepEqual(refused({ launcher: LAUNCHER.replace("F6f", "f6f") }), ["TOKEN_LAUNCHER is not a valid address"]);
  assert.deepEqual(refused({ launcher: WBNB }), ["TOKEN_LAUNCHER is the wrapped BNB contract"]);
  assert.deepEqual(refused({ rpcUrl: "http://rpc.longyu.example" }), ["L2_RPC_URL is not an https URL"]);
  assert.deepEqual(refused({ explorerUrl: "javascript:alert(1)" }), ["EXPLORER_URL is not an https URL"]);
  // Only true links to the swap page.
  const truthy = parseLaunchConfig({ ...raw, swapPage: "true" as unknown as boolean });
  assert.ok(truthy.ok && !truthy.config.swapPage);
});

test("rules: the limits are the contract's", () => {
  const constant = (name: string) => BigInt(new RegExp(`${name} = ([0-9e]+);`).exec(source)![1]!.replace(/^1e(\d+)$/, (_, e: string) => `1${"0".repeat(Number(e))}`));
  assert.equal(BigInt(MAX_NAME), constant("MAX_NAME_BYTES"));
  assert.equal(BigInt(MAX_SYMBOL), constant("MAX_SYMBOL_BYTES"));
  assert.equal(MIN_SUPPLY, constant("MIN_SUPPLY"));
  assert.equal(MAX_SUPPLY, constant("MAX_SUPPLY"));
  assert.equal(MAX_SUPPLY, 10n ** 15n);
});

test("rules: a name is 1 to 32 printable ASCII characters, no space at either end", () => {
  for (const name of ["A", "Moon Coffee", "x".repeat(32), "A-B_C.D (1)!~", "a  b"]) assert.equal(nameProblem(name), null, name);
  assert.equal(nameProblem(""), "Enter a name.");
  assert.equal(nameProblem("x".repeat(33)), "Use at most 32 characters.");
  for (const name of [" Moon", "Moon ", " "]) assert.equal(nameProblem(name), "Remove the space at the start or end.", JSON.stringify(name));
  // Tabs, line breaks, DEL and anything beyond ASCII are refused, as the contract refuses them.
  for (const name of ["Moon\tCoffee", "Moon\n", "Moon\u007f", "Café", "LОNG", "Moon​"]) assert.equal(nameProblem(name), "Use plain letters, digits, spaces and punctuation.", JSON.stringify(name));
});

test("rules: a symbol is 1 to 11 letters and digits", () => {
  for (const symbol of ["M", "MOON", "moon2", "A".repeat(11), "0"]) assert.equal(symbolProblem(symbol), null, symbol);
  assert.equal(symbolProblem(""), "Enter a symbol.");
  assert.equal(symbolProblem("A".repeat(12)), "Use at most 11 characters.");
  for (const symbol of ["MO ON", "MOON!", "$MOON", "M-1", "MÖÖN", " MOON"]) assert.equal(symbolProblem(symbol), "Use letters and digits only.", symbol);
});

test("rules: the supply is whole tokens from 1 to 10^15", () => {
  assert.deepEqual(parseSupply("1"), { ok: true, wholeTokens: 1n });
  assert.deepEqual(parseSupply(" 1000000 "), { ok: true, wholeTokens: 1_000_000n });
  assert.deepEqual(parseSupply("1,000,000"), { ok: true, wholeTokens: 1_000_000n });
  assert.deepEqual(parseSupply("1000000000000000"), { ok: true, wholeTokens: MAX_SUPPLY });
  assert.deepEqual(parseSupply("1,000,000,000,000,000"), { ok: true, wholeTokens: MAX_SUPPLY });
  assert.deepEqual(parseSupply(""), { ok: false, error: "Enter the supply." });
  for (const text of ["1.5", "-1", "1e6", "0x10", "1,00", "1,000,00", ",100", "100,", "one", "1 000"]) assert.deepEqual(parseSupply(text), { ok: false, error: "Use whole numbers only." }, text);
  assert.deepEqual(parseSupply("0"), { ok: false, error: "At least 1 token." });
  assert.deepEqual(parseSupply("1000000000000001"), { ok: false, error: "At most 1,000,000,000,000,000 tokens." });
  assert.deepEqual(parseSupply("9".repeat(40)), { ok: false, error: "At most 1,000,000,000,000,000 tokens." });
});

test("rules: a launch is checked field by field, and LONGYU's names are refused where the contract refuses them", () => {
  assert.deepEqual(checkLaunch({ name: "Moon Coffee", symbol: "MOON", supply: "1,000,000" }), { ok: true, launch: { name: "Moon Coffee", symbol: "MOON", wholeTokens: 1_000_000n } });
  // Sent as typed: the contract checks the name and symbol as they are.
  assert.deepEqual(checkLaunch({ name: "moon", symbol: "moon", supply: "1" }), { ok: true, launch: { name: "moon", symbol: "moon", wholeTokens: 1n } });
  assert.deepEqual(checkLaunch({ name: "", symbol: "MO ON", supply: "0" }), { ok: false, problems: { name: "Enter a name.", symbol: "Use letters and digits only.", supply: "At least 1 token." } });
  assert.deepEqual(checkLaunch({ name: "LONGYU Coin", symbol: "LYC", supply: "1" }), { ok: false, problems: { name: RESERVED } });
  assert.deepEqual(checkLaunch({ name: "Moon", symbol: "wLONG", supply: "1" }), { ok: false, problems: { symbol: RESERVED } });
  assert.deepEqual(checkLaunch({ name: "L0NG", symbol: "L0NG", supply: "1" }), { ok: false, problems: { name: RESERVED, symbol: RESERVED } });
  assert.deepEqual(checkLaunch({ name: "Long Island", symbol: "LI", supply: "1" }).ok, true);
  assert.equal(RESERVED, "That passes for LONGYU's own token. Choose another.");
});

/** TokenLauncher.passesForLongyu as the contract computes it (_reads, _isLong, _contains), for the comparison below. */
function contractPasses(name: string, symbol: string): boolean {
  const reads = (s: string) =>
    [...s]
      .map((c) => (c >= "a" && c <= "z" ? c.toUpperCase() : c === "0" ? "O" : c === "1" || c === "|" ? "L" : c))
      .filter((c) => c >= "A" && c <= "Z")
      .join("");
  const [n, s] = [reads(name), reads(symbol)];
  const long = (x: string) => x === "LONG" || x === "TLONG" || x === "WLONG";
  return long(n) || long(s) || n.includes("LONGYU") || s.includes("LONGYU");
}

test("rules: on plain ASCII the page's rule is the contract's", () => {
  // The contract's own words for it.
  assert.match(source, /if \(c >= 0x61 && c <= 0x7a\) c -= 0x20;\s*else if \(c == 0x30\) c = 0x4f; \/\/ 0 -> O\s*else if \(c == 0x31 \|\| c == 0x7c\) c = 0x4c; \/\/ 1 and \| -> L/);
  assert.match(source, /h == keccak256\("LONG"\) \|\| h == keccak256\("TLONG"\) \|\| h == keccak256\("WLONG"\)/);
  assert.match(source, /_contains\(n, "LONGYU"\) \|\| _contains\(s, "LONGYU"\)/);
  // Random names drawn mostly from the pieces that matter, and from every printable character.
  const pieces = ["L", "O", "N", "G", "Y", "U", "l", "o", "n", "g", "y", "u", "0", "1", "|", "T", "w", " ", "-", ".", "x", "LONG", "l0ng", "1ONG", "LONGYU", "L0ngYu", "|ongyu"];
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const word = (pool: string[]) => Array.from({ length: 1 + (next() % 5) }, () => pool[next() % pool.length]).join("");
  let passing = 0;
  for (let i = 0; i < 5000; i++) {
    const [name, symbol] = i % 5 === 0 ? [word(printable), word(printable)] : [word(pieces), word(pieces)];
    const ours = passesForLongyu({ name, symbol });
    assert.equal(ours, contractPasses(name, symbol), `${JSON.stringify(name)} / ${JSON.stringify(symbol)}`);
    if (ours) passing++;
  }
  assert.ok(passing > 100, "the sample holds names that pass");
});

const CREATOR: Address = "0x2222222222222222222222222222222222222222";
const TOKEN: Address = "0x3333333333333333333333333333333333333333";

function launchedLog(at: Address, token: Address, creator: Address): Log {
  const topics = encodeEventTopics({ abi: launcherAbi, eventName: "TokenLaunched", args: { token, creator } });
  const data = encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "uint256" }], ["Moon Coffee", "MOON", 10n ** 24n]);
  return { address: at, topics: topics as Log["topics"], data, blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false };
}

test("result: the new token comes from the launcher's own event for the sender", () => {
  const transfer: Log = { ...launchedLog(LAUNCHER, TOKEN, CREATOR), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] };
  assert.equal(launchedToken([transfer, launchedLog(LAUNCHER, TOKEN, CREATOR)], LAUNCHER, CREATOR), TOKEN);
  assert.equal(launchedToken([launchedLog(LAUNCHER, TOKEN.toLowerCase() as Address, CREATOR)], LAUNCHER, getAddress(CREATOR)), TOKEN);
  // The same event from another contract, or for someone else, is not this launch.
  assert.equal(launchedToken([launchedLog(TOKEN, TOKEN, CREATOR)], LAUNCHER, CREATOR), null);
  assert.equal(launchedToken([launchedLog(LAUNCHER, TOKEN, TOKEN)], LAUNCHER, CREATOR), null);
  assert.equal(launchedToken([], LAUNCHER, CREATOR), null);
});

test("result: links to the token and to its first liquidity", () => {
  assert.deepEqual(tokenLinks({ explorerUrl: "https://scan.longyu.example", swapPage: true }, TOKEN), {
    explorer: `https://scan.longyu.example/token/${TOKEN}`,
    addLiquidity: `./swap.html?token=${TOKEN}&mode=add`,
  });
  assert.deepEqual(tokenLinks({ explorerUrl: null, swapPage: false }, TOKEN), { explorer: null, addLiquidity: null });
});

test("display: whole tokens are grouped in threes", () => {
  assert.equal(formatWhole(1n), "1");
  assert.equal(formatWhole(999n), "999");
  assert.equal(formatWhole(1000n), "1,000");
  assert.equal(formatWhole(1_000_000n), "1,000,000");
  assert.equal(formatWhole(MAX_SUPPLY), "1,000,000,000,000,000");
});

test("errors: the launcher's refusals in plain words", () => {
  const refused = (errorName: string) => {
    const cause = Object.assign(new Error(`The contract reverted with ${errorName}()`), { name: "ContractFunctionRevertedError", data: { errorName } });
    return Object.assign(new Error("Execution reverted."), { shortMessage: "Execution reverted.", cause });
  };
  assert.equal(launchErrorMessage(refused("BadName")), "Names are 1 to 32 plain characters, with no space at the start or end.");
  assert.equal(launchErrorMessage(refused("BadSymbol")), "Symbols are 1 to 11 letters and digits.");
  assert.equal(launchErrorMessage(refused("BadSupply")), "The supply is 1 to 1,000,000,000,000,000 tokens.");
  assert.equal(launchErrorMessage(refused("ReservedName")), RESERVED);
  // Only from the error itself, as a whole word.
  assert.equal(launchErrorMessage({ message: "x", cause: { data: { errorName: "ReservedName" } } }), RESERVED);
  assert.equal(launchErrorMessage(new Error("BadNameless")), "BadNameless");
  assert.equal(launchErrorMessage(Object.assign(new Error("User rejected: ReservedName"), { code: 4001 })), CANCELLED);
  assert.equal(launchErrorMessage(new Error("insufficient funds for gas * price + value")), "Not enough tBNB for gas.");
});

test("form: the supply is grouped in threes as it is typed, and the caret stays after its digit", () => {
  assert.deepEqual(core.formatSupplyInput("1000000", 7), { value: "1,000,000", caret: 9 });
  assert.deepEqual(core.formatSupplyInput("", 0), { value: "", caret: 0 });
  assert.deepEqual(core.formatSupplyInput("999", 3), { value: "999", caret: 3 });
  // A digit typed in the middle: the caret stays after the digit typed.
  assert.deepEqual(core.formatSupplyInput("1,0050", 5), { value: "10,050", caret: 5 });
  // A comma deleted on its own comes back, the caret where it was.
  assert.deepEqual(core.formatSupplyInput("1000,000", 1), { value: "1,000,000", caret: 1 });
  assert.deepEqual(core.formatSupplyInput("12,34", 0), { value: "1,234", caret: 0 });
  // What is not a whole number is left as typed, so the field says what is wrong.
  assert.deepEqual(core.formatSupplyInput("1.5", 3), { value: "1.5", caret: 3 });
  assert.deepEqual(core.formatSupplyInput("1e6", 3), { value: "1e6", caret: 3 });
  // Whatever it groups, parseSupply reads the same number.
  for (const typed of ["1", "12", "1234", "1000000000000000", "0001"]) {
    const { value } = core.formatSupplyInput(typed, typed.length);
    assert.deepEqual(parseSupply(value), parseSupply(typed), typed);
  }
});

const png = (extra = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(extra).fill(0)]);

test("logos: the kind comes from the file's bytes, and the API's limits are checked first", () => {
  assert.equal(core.logoKind(png()), "image/png");
  assert.equal(core.logoKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(core.logoKind(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  // RIFF that is not WebP (a WAV file), a GIF, an SVG and nothing.
  assert.equal(core.logoKind(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])), null);
  assert.equal(core.logoKind(new TextEncoder().encode("GIF89a")), null);
  assert.equal(core.logoKind(new TextEncoder().encode("<svg xmlns=")), null);
  assert.equal(core.logoKind(new Uint8Array()), null);
  assert.equal(core.logoFileProblem(png(100)), null);
  assert.equal(core.logoFileProblem(png(core.LOGO_MAX_BYTES - 8)), null);
  assert.equal(core.logoFileProblem(png(core.LOGO_MAX_BYTES - 7)), "Use an image of at most 256 KB.");
  assert.equal(core.logoFileProblem(new TextEncoder().encode("<svg/>")), "Use a PNG, JPEG or WebP image.");
  assert.equal(core.logoSizeProblem(64, 64), null);
  assert.equal(core.logoSizeProblem(1024, 512), null);
  assert.equal(core.logoSizeProblem(63, 200), "Use an image at least 64 × 64 px.");
  assert.equal(core.logoSizeProblem(200, 1025), "Use an image at most 1024 × 1024 px.");
  assert.deepEqual(core.LOGO_TYPES, ["image/png", "image/jpeg", "image/webp"]);
});

test("logos: the bytes go as base64, and the creator signs the token, the chain and the image's digest", () => {
  const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
  assert.equal(core.toBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.equal(core.toBase64(new Uint8Array()), "");
  assert.equal(core.hexOf(new Uint8Array([0, 15, 255])), "000fff");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const token = "0x0f6f17abd46463f2b431104e1895bbe6aa91d7bf";
  assert.equal(
    core.logoMessage(token, 668800, digest),
    `LONGYU token logo\nToken: 0x0F6f17ABD46463F2B431104e1895bBE6AA91d7BF\nChain: 668800\nImage: sha256:${digest}`,
  );
  assert.equal(core.logoMessage(token, 668800, digest).split("\n").length, 4);
  assert.throws(() => core.logoMessage(token, 668800, digest.toUpperCase()), /64 lower-case hex/);
  assert.throws(() => core.logoMessage(token, 668800, digest.slice(1)), /64 lower-case hex/);
});

test("logos: the API's refusals in plain words", () => {
  assert.equal(core.logoErrorMessage(403, { error: "not_creator", message: "x" }), "Only the account that launched the token can set its logo.");
  assert.equal(core.logoErrorMessage(400, { error: "logo_invalid" }), "Use a PNG, JPEG or WebP image, at most 256 KB and 64 to 1024 px on each side.");
  assert.equal(core.logoErrorMessage(401, { error: "signature_invalid" }), "The signature does not match. Try again.");
  assert.equal(core.logoErrorMessage(404, { error: "not_launched" }), "That token was not made with LONGYU Launch.");
  assert.equal(core.logoErrorMessage(429, null), "Too many tries. Wait a minute and try again.");
  assert.equal(core.logoErrorMessage(502, "<html>"), "The logo service is busy. Try again.");
  assert.equal(core.logoErrorMessage(400, { error: "toString" }), "The logo was not saved. Try again.");
});
