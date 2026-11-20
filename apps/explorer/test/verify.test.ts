/**
 * Contract verification. A source is published only when the bytecode the explorer compiled from
 * it is the code at the address: byte for byte, with nothing set aside but what the compiler itself
 * marks (immutables, a library's own address, its metadata hash). The compiler here is a stand-in
 * that answers what a test tells it to; the real one, started the way the explorer starts it, is
 * shown to be unable to read files, start processes or see the environment.
 * The limits: one compilation at a time and eight waiting, what a day may add to the database, a
 * visitor's uploads and readings a minute, and the switch that stops new verifications.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { buildApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createPgliteDb, migrate } from "../src/db.ts";
import { Indexer } from "../src/indexer.ts";
import * as Q from "../src/queries.ts";
import { type Hex, type RawReceipt, type RawTx } from "../src/rpc.ts";
import { sandbox, type Compile } from "../src/verify/compile.ts";
import { COMPILERS, CompilerStore, findCompiler, type CompilerBuild } from "../src/verify/compilers.ts";
import { compilerInput, parseRequest } from "../src/verify/input.ts";
import { matchCreation, matchRuntime } from "../src/verify/match.ts";
import { QUEUE_LENGTH } from "../src/verify/service.ts";
import { ALICE, FakeChain, pad } from "./fake-chain.ts";

// ------------------------------------------------------------- bytecode

/** The map the compiler ends a contract's code with, around a metadata hash, and its length. */
function metadata(hash: string): string {
  const map = `a2${"64697066735822"}${hash}${"64736f6c6343"}00081c`;
  return `${map}${(map.length / 2).toString(16).padStart(4, "0")}`;
}
const HASH_A = `1220${"aa".repeat(32)}`;
const HASH_B = `1220${"bb".repeat(32)}`;
const BODY = "6080604052348015600e575f5ffd5b50603e80601a5f395ff3fe60806040525f5ffdfe";
const RUNTIME = BODY + metadata(HASH_A);
const INIT = "608060405234801561000f575f5ffd5b50";
const CREATION = INIT + RUNTIME;
const AT = "00000000000000000000000000000000000c0de1";
const here = { address: AT, partial: true };

test("code matches in full only when every byte is the compiler's", () => {
  assert.equal(matchRuntime(RUNTIME, RUNTIME, [], here), "full");
  const changed = `61${RUNTIME.slice(2)}`;
  assert.equal(matchRuntime(changed, RUNTIME, [], here), null);
  assert.equal(matchRuntime(RUNTIME + "00", RUNTIME, [], here), null);
  assert.equal(matchRuntime(RUNTIME.toUpperCase(), RUNTIME, [], here), null, "hex is lower-case throughout");
  assert.equal(matchRuntime("", "", [], here), null);
  assert.equal(matchRuntime(`${RUNTIME}0`, `${RUNTIME}0`, [], here), null);
});

test("immutables are set aside where the compiler says they are, and nowhere else", () => {
  const onchain = `${RUNTIME.slice(0, 8)}deadbeef${RUNTIME.slice(16)}`;
  assert.equal(matchRuntime(onchain, RUNTIME, [], here), null);
  assert.equal(matchRuntime(onchain, RUNTIME, [{ start: 4, length: 4 }], here), "full");
  assert.equal(matchRuntime(onchain, RUNTIME, [{ start: 5, length: 4 }], here), null);
  // A range the code does not have is not a range.
  for (const bad of [{ start: -1, length: 4 }, { start: 4, length: 10_000 }, { start: 1.5, length: 1 }]) {
    assert.equal(matchRuntime(RUNTIME, RUNTIME, [bad], here), null);
  }
});

test("a library's own address is set aside only when it is the address being verified", () => {
  const rest = `301460806040525f5ffdfe${metadata(HASH_A)}`;
  const compiled = `73${"00".repeat(20)}${rest}`;
  assert.equal(matchRuntime(`73${AT}${rest}`, compiled, [], here), "full");
  const other = "00000000000000000000000000000000000bad00";
  assert.equal(matchRuntime(`73${other}${rest}`, compiled, [], here), null);
  // Code that only begins like a library's is compared as it is.
  const plain = `73${"00".repeat(20)}5014${rest.slice(4)}`;
  assert.equal(matchRuntime(`73${AT}5014${rest.slice(4)}`, plain, [], here), null);
});

test("a partial match sets aside the hash the compiler appended, and no other bytes that look like one", () => {
  const other = BODY + metadata(HASH_B);
  assert.equal(matchRuntime(other, RUNTIME, [], here), "partial");
  assert.equal(matchRuntime(other, RUNTIME, [], { address: AT, partial: false }), null);
  // The compiler's version, which follows the hash in the map, is part of the code.
  assert.equal(matchRuntime(other.replace("00081c", "00081b"), RUNTIME, [], here), null);

  // A constant in the source made to look like a metadata hash: the bytes in it are compared.
  const lookalike = (hash: string) => `${BODY}a164697066735822${hash}0027${metadata(HASH_A)}`;
  assert.equal(matchRuntime(lookalike(HASH_A), lookalike(HASH_A), [], here), "full");
  assert.equal(matchRuntime(lookalike(HASH_B), lookalike(HASH_A), [], here), null);

  // Code that does not end with the compiler's map has nothing to set aside.
  assert.equal(matchRuntime(`${BODY}ff`, `${BODY}fe`, [], here), null);
});

test("the creation transaction's input is the compiled creation code, then the constructor's arguments", () => {
  const args = pad(42n).slice(2);
  assert.deepEqual(matchCreation(CREATION + args, CREATION, RUNTIME, here), { kind: "full", args });
  assert.deepEqual(matchCreation(CREATION, CREATION, RUNTIME, here), { kind: "full", args: "" });
  assert.equal(matchCreation(CREATION.slice(0, -2), CREATION, RUNTIME, here), null);
  assert.equal(matchCreation(`61${CREATION.slice(2)}${args}`, CREATION, RUNTIME, here), null);

  const other = INIT + BODY + metadata(HASH_B);
  assert.deepEqual(matchCreation(other + args, CREATION, RUNTIME, here), { kind: "partial", args });
  assert.equal(matchCreation(other + args, CREATION, RUNTIME, { partial: false }), null);
  // The constructor's code differs as well: not this source.
  assert.equal(matchCreation(`61${other.slice(2)}${args}`, CREATION, RUNTIME, here), null);
});

// -------------------------------------------------------------- requests

const NEWEST = COMPILERS[0]!;
const fieldsOf = (values: Record<string, string>) => (name: string) => values[name];
const SOURCE = "contract Token { function decimals() external pure returns (uint8) { return 18; } }";
const single = (more: Record<string, string> = {}) => ({ contractaddress: `0x${AT}`, compilerversion: `v${NEWEST.long}`, contractname: "Token", sourceCode: SOURCE, ...more });
const standard = (input: unknown, more: Record<string, string> = {}) =>
  ({ contractaddress: `0x${AT}`, compilerversion: `v${NEWEST.long}`, codeformat: "solidity-standard-json-input", contractname: "src/Token.sol:Token", sourceCode: JSON.stringify(input), ...more });

test("only pinned compiler releases are known, by version or by version and commit", () => {
  assert.ok(COMPILERS.length >= 70);
  for (const c of COMPILERS) {
    assert.match(c.path, /^soljson-v\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}\.js$/);
    assert.match(c.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(findCompiler(`v${NEWEST.long}`), NEWEST);
  assert.equal(findCompiler(NEWEST.version), NEWEST);
  assert.equal(findCompiler(`v${NEWEST.version}+commit.00000000`), null);
  assert.equal(findCompiler("0.4.26"), null);
  assert.equal(findCompiler(`${NEWEST.version}-nightly.2024.1.1+commit.00000000`), null);
  assert.equal(findCompiler("../../etc/passwd"), null);
});

test("a request becomes the compiler's input: its sources, the settings that shape bytecode, and nothing else", () => {
  const one = parseRequest(fieldsOf(single({ optimizationUsed: "1", runs: "999", evmversion: "cancun", viaIR: "1" })));
  assert.ok(one.ok);
  assert.deepEqual(one.value.input, { language: "Solidity", sources: { "Token.sol": { content: SOURCE } }, settings: { optimizer: { enabled: true, runs: 999 }, evmVersion: "cancun", viaIR: true } });
  assert.equal(one.value.address, `0x${AT}`);

  const many = parseRequest(fieldsOf(standard({
    language: "Solidity",
    sources: { "src/Token.sol": { content: SOURCE, keccak256: "0x00" } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["*"] } }, stopAfter: "parsing", modelChecker: { engine: "all" } },
  })));
  assert.ok(many.ok);
  assert.deepEqual(many.value.input, { language: "Solidity", sources: { "src/Token.sol": { content: SOURCE } }, settings: { optimizer: { enabled: true, runs: 200 } } });
  // The compiler is asked for the one contract's ABI and bytecode, whatever the request asked for.
  assert.deepEqual(JSON.parse(compilerInput(many.value)).settings.outputSelection, {
    "src/Token.sol": { Token: ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] },
  });

  const refused: [Record<string, string>, RegExp][] = [
    [single({ contractaddress: "0x123" }), /Invalid address/],
    [single({ compilerversion: "v0.4.26+commit.4563c3fc" }), /Unsupported compiler/],
    [single({ contractname: "Token;" }), /contractname/],
    [single({ sourceCode: "  " }), /Missing sourceCode/],
    [single({ runs: "-1" }), /Invalid runs/],
    [single({ evmversion: "tomorrow" }), /evmversion/],
    [single({ codeformat: "vyper-json" }), /Unsupported codeformat/],
    [standard("not an input"), /Solidity/],
    [standard({ language: "Yul", sources: {} }), /Solidity/],
    [standard({ language: "Solidity", sources: {} }), /between 1 and/],
    // Nothing is fetched for a request: a source given by address is refused.
    [standard({ language: "Solidity", sources: { "src/Token.sol": { urls: ["https://example.com/Token.sol"] } } }), /has no content/],
    [standard({ language: "Solidity", sources: { "src/Other.sol": { content: SOURCE } } }), /no source named/],
    [{ ...standard({}), sourceCode: "{" }, /not valid JSON/],
  ];
  for (const [values, error] of refused) {
    const got = parseRequest(fieldsOf(values));
    assert.ok(!got.ok && error.test(got.error), `${JSON.stringify(values).slice(0, 120)} -> ${got.ok ? "accepted" : got.error}`);
  }
});

test("a compiler that does not have its pinned hash is never returned, from the download or from the disk", async () => {
  const good = Buffer.from("the compiler");
  const build: CompilerBuild = { version: "0.8.28", long: "0.8.28+commit.7893614a", path: "soljson-test.js", sha256: createHash("sha256").update(good).digest("hex") };
  const dir = mkdtempSync(join(tmpdir(), "longyu-compilers-"));
  let answer = Buffer.from("something else");
  const asked: string[] = [];
  const store = new CompilerStore(dir, async (url) => {
    asked.push(url);
    return answer;
  });

  await assert.rejects(store.load(build), /pinned hash/);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(asked, ["https://binaries.soliditylang.org/wasm/soljson-test.js"]);

  answer = good;
  assert.deepEqual(await store.load(build), good);
  assert.deepEqual(await store.load(build), good);
  assert.equal(asked.length, 2, "a kept build is not downloaded again");

  // The kept file is changed behind the explorer's back: it is thrown away and fetched again.
  writeFileSync(join(dir, build.path), "tampered");
  assert.deepEqual(await store.load(build), good);
  assert.equal(asked.length, 3);
  assert.deepEqual(readdirSync(dir), [build.path]);
});

test("the compiler's process cannot read files, start processes or see the explorer's environment", () => {
  // Windows and macOS hand every process a few names of their own; the explorer's are not among them.
  const OWN = process.platform === "win32" ? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"] : ["__CF_USER_TEXT_ENCODING"];
  const dir = mkdtempSync(join(tmpdir(), "longyu-sandbox-"));
  const script = join(dir, "probe.cjs");
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "the database password");
  writeFileSync(script, `
    const tried = {};
    const attempt = (name, f) => { try { f(); tried[name] = "allowed"; } catch (e) { tried[name] = e.code || e.message; } };
    attempt("read", () => require("node:fs").readFileSync(${JSON.stringify(secret)}, "utf8"));
    attempt("write", () => require("node:fs").writeFileSync(${JSON.stringify(join(dir, "written.txt"))}, "x"));
    attempt("list", () => require("node:fs").readdirSync(${JSON.stringify(dir)}));
    attempt("spawn", () => require("node:child_process").spawnSync(process.execPath, ["--version"]));
    attempt("worker", () => new (require("node:worker_threads").Worker)("1", { eval: true }));
    tried.env = Object.keys(process.env).filter((k) => !${JSON.stringify(OWN)}.includes(k.toUpperCase()));
    process.stdout.write(JSON.stringify(tried));
  `);
  process.env.LONGYU_PROBE = "the origin secret";
  const { args, env } = sandbox(script);
  const ran = spawnSync(process.execPath, args, { env: { ...env }, encoding: "utf8" });
  delete process.env.LONGYU_PROBE;
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { read: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", list: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", worker: "ERR_ACCESS_DENIED", env: [] });
  assert.deepEqual(readdirSync(dir).sort(), ["probe.cjs", "secret.txt"]);
});

// ------------------------------------------------------------- endpoints

class Chain extends FakeChain {
  code = new Map<string, string>();
  override async call<T>(method: string, params: unknown[]): Promise<T> {
    if (method === "eth_getCode") return (this.code.get(String(params[0])) ?? "0x") as T;
    if (method === "eth_getBalance") return "0x0" as T;
    return super.call<T>(method, params);
  }
}

const TOKEN_AT = `0x${AT}` as Hex;
const ABI = [{ type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8", name: "" }], stateMutability: "pure" }];
const SECRET = "s".repeat(40);

/** What the stand-in compiler answers for the one contract it was asked for. */
type Answer = (input: { sources: Record<string, { content: string }>; settings: { outputSelection: Record<string, Record<string, string[]>> } }) => unknown;
const compiled = (runtime = RUNTIME, creation = CREATION, abi: unknown = ABI): Answer => (input) => {
  const [file, names] = Object.entries(input.settings.outputSelection)[0]!;
  const name = Object.keys(names)[0]!;
  return { contracts: { [file === "*" ? Object.keys(input.sources)[0]! : file]: { [name]: { abi, evm: { bytecode: { object: creation }, deployedBytecode: { object: runtime, immutableReferences: {} } } } } } };
};

async function serve(env: Record<string, string> = {}, setup: (chain: Chain) => void = () => undefined) {
  const chain = new Chain();
  chain.add([]);
  chain.code.set(TOKEN_AT, `0x${RUNTIME}`);
  setup(chain);
  const db = await createPgliteDb();
  await migrate(db);
  await new Indexer(db, chain, { startBlock: 0n, batchSize: 50 }).step();
  const state = { answer: compiled(), compiles: 0, loads: [] as string[], hold: null as Promise<void> | null };
  const compile: Compile = async (_compiler, input) => {
    state.compiles++;
    if (state.hold) await state.hold;
    return JSON.stringify(state.answer(JSON.parse(input)));
  };
  const config = ConfigSchema.parse({ RPC_URL: "http://node.invalid", CHAIN_ID: "668801", NODE_ENV: "test", ORIGIN_SECRET: SECRET, ...env });
  const app = await buildApp({ db, rpc: chain, config, verify: { compile, loadCompiler: async (build) => (state.loads.push(build.long), Buffer.from("compiler")) } });
  let visitors = 0;
  const headers = (ip?: string) => ({ "x-longyu-origin": SECRET, "cf-connecting-ip": ip ?? `198.51.100.${++visitors % 250}` });
  const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
  const post = (url: string, values: Record<string, string>, ip?: string) =>
    app.inject({ method: "POST", url, headers: { ...headers(ip), "content-type": "application/x-www-form-urlencoded" }, payload: form(values) });
  const get = (url: string, ip?: string) => app.inject({ method: "GET", url, headers: headers(ip) });
  const api = (values: Record<string, string>, ip?: string) => post("/api", { module: "contract", ...values }, ip);
  /** Asks until the verification has an answer. */
  const result = async (guid: string): Promise<string> => {
    for (let i = 0; i < 400; i++) {
      const r = (await api({ action: "checkverifystatus", guid })).json().result as string;
      if (r !== "Pending in queue") return r;
      await new Promise((done) => setTimeout(done, 5));
    }
    throw new Error("the verification did not finish");
  };
  const verify = async (values: Record<string, string>) => {
    const sent = (await api({ action: "verifysourcecode", ...values })).json();
    return sent.status === "1" ? result(sent.result) : (sent.result as string);
  };
  return { app, db, chain, state, get, post, api, result, verify, close: async () => { await app.close(); await db.close(); } };
}

/** A block that creates a contract with this input, and the code the contract ends up with. */
function create(chain: Chain, address: Hex, input: string, runtime: string) {
  const hash = pad(0xc0de0000n + BigInt(chain.blocks.length));
  const tx: RawTx = { hash, from: ALICE, to: null, value: "0x0", gas: "0x5208", gasPrice: "0x1", nonce: "0x0", input: `0x${input}`, type: "0x2", transactionIndex: "0x0" };
  const receipt: RawReceipt = { transactionHash: hash, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: address, logs: [] };
  chain.addBlock([tx], [receipt]);
  chain.code.set(address, `0x${runtime}`);
}

test("Foundry's flow: post the source, ask after it, read the ABI and the source back", async () => {
  const s = await serve();
  assert.deepEqual((await s.get(`/api?module=contract&action=getabi&address=${TOKEN_AT}`)).json(), { status: "0", message: "NOTOK", result: "Contract source code not verified" });
  const unverified = (await s.get(`/api?module=contract&action=getsourcecode&address=${TOKEN_AT}`)).json();
  assert.equal(unverified.status, "1");
  assert.equal(unverified.result[0].SourceCode, "");
  assert.equal(unverified.result[0].ABI, "Contract source code not verified");

  const input = { language: "Solidity", sources: { "src/Token.sol": { content: SOURCE }, "src/Base.sol": { content: "// <script>alert(1)</script>" } }, settings: { optimizer: { enabled: true, runs: 10000 }, evmVersion: "cancun" } };
  const sent = await s.api({ action: "verifysourcecode", ...standard(input) });
  assert.equal(sent.headers["cache-control"], "no-store");
  assert.match(sent.json().result, /^[0-9a-f]{32}$/);
  assert.deepEqual([sent.json().status, sent.json().message], ["1", "OK"]);
  assert.equal(await s.result(sent.json().result), "Pass - Verified");
  // Asked by GET as well, as Hardhat does.
  assert.deepEqual((await s.get(`/api?module=contract&action=checkverifystatus&guid=${sent.json().result}`)).json(), { status: "1", message: "OK", result: "Pass - Verified" });
  assert.deepEqual(s.state.loads, [NEWEST.long]);

  assert.deepEqual((await s.get(`/api?module=contract&action=getabi&address=${TOKEN_AT}`)).json(), { status: "1", message: "OK", result: JSON.stringify(ABI) });
  const [got] = (await s.get(`/api?module=contract&action=getsourcecode&address=0x${AT.toUpperCase()}`)).json().result;
  assert.deepEqual(JSON.parse(got.SourceCode.slice(1, -1)), input);
  assert.deepEqual(
    { name: got.ContractName, compiler: got.CompilerVersion, optimizer: got.OptimizationUsed, runs: got.Runs, evm: got.EVMVersion, args: got.ConstructorArguments },
    { name: "Token", compiler: `v${NEWEST.long}`, optimizer: "1", runs: "10000", evm: "cancun", args: "" },
  );

  // The address page: a Contract tab with a tick, the contract's own file first, and every file's text escaped.
  const page = (await s.get(`/address/${TOKEN_AT}?tab=contract`)).body;
  assert.match(page, /<span class="verified">Contract<\/span>/);
  assert.match(page, /<strong class="verified">Token<\/strong>/);
  assert.ok(page.includes(`<pre class="mono code" id="source-text">${SOURCE}</pre>`));
  assert.ok(page.includes("Full") && page.includes("Deployed code") && page.includes("10,000 runs"));
  const other = (await s.get(`/address/${TOKEN_AT}?tab=contract&file=1`)).body;
  assert.ok(other.includes("// &lt;script&gt;alert(1)&lt;/script&gt;") && !other.includes("<script>alert(1)"));
  assert.ok((await s.get(`/address/${TOKEN_AT}?tab=contract&file=99`)).body.includes(SOURCE), "a file the source does not have shows the contract's own");
  assert.match((await s.get(`/address/${TOKEN_AT}`)).body, /<span class="verified">Contract<\/span>/);

  // Sent again: Etherscan's own words, which Foundry takes for success.
  assert.equal(await s.verify(standard(input)), "Contract source code already verified");
  assert.equal(s.state.compiles, 1);
  await s.close();
});

test("source that does not compile to the contract's code is not published, and the answer says why", async () => {
  const s = await serve();
  const failing: [Answer, RegExp][] = [
    [compiled(`61${RUNTIME.slice(2)}`), /^Fail - Unable to verify\. The compiled bytecode is not the code at the address/],
    [() => ({ errors: [{ severity: "warning", formattedMessage: "Warning: unused" }, { severity: "error", formattedMessage: "ParserError: Expected ';'\n --> src/Token.sol:1:5" }] }), /Compilation failed\. ParserError: Expected ';' --> src\/Token\.sol:1:5/],
    [() => ({ contracts: {} }), /The sources have no contract named Token/],
    [compiled("", ""), /has no bytecode/],
    [compiled(`${BODY}__$1234567890123456789012345678901234$__${metadata(HASH_A)}`), /uses libraries/],
    [compiled(RUNTIME, CREATION, "x".repeat(10)), /has no bytecode/],
    [() => "not an object", /could not be read/],
  ];
  for (const [answer, reason] of failing) {
    s.state.answer = answer;
    assert.match(await s.verify(single()), reason);
  }
  assert.equal(await Q.verified(s.db, TOKEN_AT), null);
  assert.match((await s.get(`/address/${TOKEN_AT}?tab=contract`)).body, /Source not verified.*href="\/verify\?address=0x0{35}c0de1"/s);

  // Requests that never reach the compiler.
  const before = s.state.compiles;
  assert.equal(await s.verify(single({ contractaddress: ALICE })), `Unable to locate ContractCode at ${ALICE}`);
  assert.equal(await s.verify(single({ compilerversion: "v0.4.11" })), "Unsupported compiler version. Give a Solidity release from 0.5.0 on, as v0.8.28+commit.7893614a");
  assert.equal((await s.get(`/api?module=contract&action=verifysourcecode&${new URLSearchParams(single())}`)).json().result, "Error! Use POST for this action");
  assert.equal((await s.api({ action: "checkverifystatus", guid: "f".repeat(32) })).json().result, "Error! No verification with that guid");
  assert.equal((await s.api({ action: "checkverifystatus", guid: "../../etc" })).json().result, "Error! No verification with that guid");
  assert.equal((await s.api({ action: "getabi", address: "nope" })).json().result, "Error! Invalid address format");
  assert.equal((await s.api({ action: "selfdestruct" })).json().result, "Error! Unsupported module or action");
  assert.equal(s.state.compiles, before);
  // The other modules are read with GET.
  assert.equal((await s.post("/api", { module: "account", action: "balance", address: ALICE })).statusCode, 405);
  await s.close();
});

test("a contract made by a transaction is checked against that transaction, and its constructor arguments are kept", async () => {
  const args = pad(1_000_000n).slice(2);
  const made = "0x00000000000000000000000000000000000c0de2" as Hex;
  const wrong = "0x00000000000000000000000000000000000c0de3" as Hex;
  const s = await serve({}, (chain) => {
    create(chain, made, CREATION + args, RUNTIME);
    // Its code is this source's, but another constructor made it.
    create(chain, wrong, `61${CREATION.slice(2)}${args}`, RUNTIME);
  });
  assert.equal(await s.verify(single({ contractaddress: made })), "Pass - Verified");
  const row = (await Q.verified(s.db, made))!;
  assert.deepEqual([row.creation_checked, row.constructor_args, row.match_kind], [true, args, "full"]);
  assert.match((await s.get(`/address/${made}?tab=contract`)).body, /Deployed code and creation transaction/);

  assert.match(await s.verify(single({ contractaddress: wrong })), /The compiled creation code is not the code in the transaction that created the contract/);
  assert.equal(await Q.verified(s.db, wrong), null);

  // No creation transaction of its own (made by another contract): the deployed code is what is compared.
  assert.equal(await s.verify(single()), "Pass - Verified");
  const plain = (await Q.verified(s.db, TOKEN_AT))!;
  assert.deepEqual([plain.creation_checked, plain.constructor_args], [false, null]);
  await s.close();
});

test("a partial match is marked as one, and only a full match replaces it", async () => {
  const s = await serve();
  s.state.answer = compiled(BODY + metadata(HASH_B), INIT + BODY + metadata(HASH_B));
  assert.equal(await s.verify(single()), "Pass - Verified");
  assert.equal((await Q.verified(s.db, TOKEN_AT))!.match_kind, "partial");
  assert.match((await s.get(`/address/${TOKEN_AT}?tab=contract`)).body, /<dt>Match<\/dt><dd>Partial<\/dd>/);
  assert.match(await s.verify(single({ sourceCode: `${SOURCE} // again` })), /Only a full match, from its exact source files, replaces a partial one/);

  s.state.answer = compiled();
  assert.equal(await s.verify(single()), "Pass - Verified");
  assert.equal((await Q.verified(s.db, TOKEN_AT))!.match_kind, "full");

  // With the compiler told not to append its metadata, the end of the code is the contract's own.
  const bare = "0x00000000000000000000000000000000000c0de4" as Hex;
  s.chain.code.set(bare, `0x${RUNTIME}`);
  s.state.answer = compiled(BODY + metadata(HASH_B), INIT + BODY + metadata(HASH_B));
  const input = { language: "Solidity", sources: { "src/Token.sol": { content: SOURCE } }, settings: { metadata: { appendCBOR: false } } };
  assert.match(await s.verify(standard(input, { contractaddress: bare })), /The compiled bytecode is not the code at the address/);
  await s.close();
});

test("a verified source is shown only while the address holds the code it was matched against", async () => {
  const s = await serve();
  assert.equal(await s.verify(single()), "Pass - Verified");
  s.chain.code.set(TOKEN_AT, `0x${BODY}`);
  assert.equal((await s.api({ action: "getabi", address: TOKEN_AT })).json().result, "Contract source code not verified");
  assert.equal((await s.api({ action: "getsourcecode", address: TOKEN_AT })).json().result[0].SourceCode, "");
  const page = (await s.get(`/address/${TOKEN_AT}?tab=contract`)).body;
  assert.ok(page.includes("Source not verified") && !page.includes(SOURCE));
  // The new code can be verified in its place.
  s.state.answer = compiled(BODY, INIT + BODY);
  assert.equal(await s.verify(single({ sourceCode: "contract Token {}" })), "Pass - Verified");
  assert.equal((await Q.verified(s.db, TOKEN_AT))!.code_hash, keccak256(`0x${BODY}`));
  await s.close();
});

test("one compilation runs, eight wait, and the next request is refused", async () => {
  const s = await serve();
  let release = () => {};
  s.state.hold = new Promise((done) => (release = done));
  const address = (i: number) => `0x${(0xd00000 + i).toString(16).padStart(40, "0")}` as Hex;
  const guids: string[] = [];
  for (let i = 0; i <= QUEUE_LENGTH; i++) {
    s.chain.code.set(address(i), `0x${RUNTIME}`);
    const sent = (await s.api({ action: "verifysourcecode", ...single({ contractaddress: address(i) }) })).json();
    assert.equal(sent.status, "1", sent.result);
    guids.push(sent.result);
  }
  s.chain.code.set(address(99), `0x${RUNTIME}`);
  assert.equal((await s.api({ action: "verifysourcecode", ...single({ contractaddress: address(99) }) })).json().result, "The verification queue is full. Try again in a minute");
  assert.equal((await s.api({ action: "verifysourcecode", ...single({ contractaddress: address(3) }) })).json().result, "A verification of this contract is already in the queue");
  assert.equal(s.state.compiles, 1);
  assert.deepEqual((await s.api({ action: "checkverifystatus", guid: guids[5]! })).json(), { status: "0", message: "NOTOK", result: "Pending in queue" });

  release();
  s.state.hold = null;
  for (const guid of guids) assert.equal(await s.result(guid), "Pass - Verified");
  assert.equal(s.state.compiles, QUEUE_LENGTH + 1);
  await s.close();
});

test("the database takes a set amount of verified source in a day", async () => {
  const stored = JSON.stringify({ language: "Solidity", sources: { "Token.sol": { content: SOURCE } }, settings: { optimizer: { enabled: false, runs: 200 } } }).length + JSON.stringify(ABI).length;
  const s = await serve({ VERIFY_DAILY_BYTES: String(stored + 10) });
  assert.equal(await s.verify(single()), "Pass - Verified");
  const second = "0x00000000000000000000000000000000000c0de5" as Hex;
  s.chain.code.set(second, `0x${RUNTIME}`);
  const before = s.state.compiles;
  assert.equal(await s.verify(single({ contractaddress: second })), "The explorer has stored as much verified source as it takes in a day. Try again tomorrow");
  assert.equal(s.state.compiles, before, "refused before the compiler is started");
  // A day later there is room again.
  await s.db.query("UPDATE verified_contracts SET verified_at = verified_at - 86401");
  assert.equal(await s.verify(single({ contractaddress: second })), "Pass - Verified");

  // An ABI no contract could have is not kept.
  const third = "0x00000000000000000000000000000000000c0de6" as Hex;
  s.chain.code.set(third, `0x${RUNTIME}`);
  const big = await serve({}, (chain) => chain.code.set(third, `0x${RUNTIME}`));
  big.state.answer = compiled(RUNTIME, CREATION, [{ type: "function", name: "x".repeat(2 * 1024 * 1024) }]);
  assert.equal(await big.verify(single({ contractaddress: third })), "Fail - Unable to verify. The contract's ABI is too large to keep");
  await big.close();
  await s.close();
});

test("a visitor has six uploads and thirty readings of a source a minute; asking after a verification is not counted", async () => {
  const s = await serve();
  const ip = "203.0.113.50";
  const large = single({ sourceCode: `${SOURCE}\n${"// padding\n".repeat(300)}` });
  s.state.answer = compiled(`61${RUNTIME.slice(2)}`);
  let last = "";
  for (let i = 0; i < 6; i++) {
    const sent = await s.api({ action: "verifysourcecode", ...large }, ip);
    assert.equal(sent.statusCode, 200);
    last = sent.json().result;
    await s.result(last);
  }
  const refused = await s.api({ action: "verifysourcecode", ...large }, ip);
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(refused.json(), { status: "0", message: "NOTOK", result: "Max rate limit reached" });
  assert.equal(refused.headers["retry-after"], "60");
  assert.equal((await s.post("/verify", large, ip)).statusCode, 429);
  // Small requests go on being answered, and another visitor is not affected.
  for (let i = 0; i < 40; i++) assert.equal((await s.api({ action: "checkverifystatus", guid: last }, ip)).statusCode, 200);
  assert.equal((await s.api({ action: "verifysourcecode", ...large }, "203.0.113.51")).statusCode, 200);

  const reader = "203.0.113.60";
  for (let i = 0; i < 30; i++) assert.equal((await s.get(`/api?module=contract&action=getabi&address=${TOKEN_AT}`, reader)).statusCode, 200);
  assert.equal((await s.get(`/api?module=contract&action=getsourcecode&address=${TOKEN_AT}`, reader)).statusCode, 429);
  assert.equal((await s.get(`/address/${TOKEN_AT}?tab=contract`, reader)).statusCode, 429);
  assert.equal((await s.get(`/address/${TOKEN_AT}`, reader)).statusCode, 200);

  // A body larger than a verification may be is not read.
  const huge = await s.api({ action: "verifysourcecode", ...single({ sourceCode: "x".repeat(4 * 1024 * 1024) }) }, "203.0.113.70");
  assert.equal(huge.statusCode, 413);
  // Elsewhere a body stays as small as it was.
  assert.equal((await s.post("/search", { q: "x".repeat(2000) }, "203.0.113.71")).statusCode, 413);
  await s.close();
});

test("the form: a verification is sent, waited for, and ends on the contract's page or back at the form with what was wrong", async () => {
  const s = await serve();
  const ip = "203.0.113.80";
  const form = (await s.get(`/verify?address=${TOKEN_AT}`, ip)).body;
  assert.ok(form.includes(`name="contractaddress" value="${TOKEN_AT}"`));
  assert.ok(form.includes(`<option value="v${NEWEST.long}">`) && form.includes('action="/verify" method="post"'));
  assert.match((await s.get("/blocks", ip)).body, /href="\/verify">Verify contract</);

  let release = () => {};
  s.state.hold = new Promise((done) => (release = done));
  const sent = await s.post("/verify", single({ optimizationUsed: "1", runs: "200" }), ip);
  assert.equal(sent.statusCode, 303);
  const where = String(sent.headers.location);
  assert.match(where, /^\/verify\/status\/[0-9a-f]{32}$/);
  const waiting = await s.get(where, ip);
  assert.ok(waiting.body.includes('<meta http-equiv="refresh" content="3">') && waiting.body.includes("In the queue"));
  assert.equal(waiting.headers["cache-control"], "no-store");
  release();
  s.state.hold = null;
  await s.result(where.split("/").pop()!);
  const done = await s.get(where, ip);
  assert.equal(done.statusCode, 303);
  assert.equal(done.headers.location, `/address/${TOKEN_AT}?tab=contract`);

  // What was wrong comes back with the form, and with what was typed, escaped.
  const hostile = '"><script>alert(1)</script>';
  const back = await s.post("/verify", single({ contractaddress: "0x12", contractname: hostile, sourceCode: `</textarea>${hostile}` }), ip);
  assert.equal(back.statusCode, 422);
  assert.ok(back.body.includes('<p class="form-error" role="alert">Invalid address format</p>'));
  assert.ok(!back.body.includes("<script>alert(1)") && back.body.includes("&lt;/textarea&gt;&quot;&gt;&lt;script&gt;"));

  // A failed verification's page says why and leads back to the form.
  const second = "0x00000000000000000000000000000000000c0de7" as Hex;
  s.chain.code.set(second, `0x${BODY}`);
  const failed = await s.post("/verify", single({ contractaddress: second }), ip);
  await s.result(String(failed.headers.location).split("/").pop()!);
  const why = (await s.get(String(failed.headers.location), ip)).body;
  assert.ok(why.includes("Verification failed") && why.includes("The compiled bytecode is not the code at the address") && why.includes(`href="/verify?address=${second}"`));
  assert.ok(!why.includes('http-equiv="refresh"'));
  assert.equal((await s.get(`/verify/status/${"0".repeat(32)}`, ip)).statusCode, 404);
  await s.close();
});

test("with VERIFICATION off nothing new is taken, and what was verified stays readable", async () => {
  const on = await serve();
  assert.equal(await on.verify(single()), "Pass - Verified");
  const row = (await Q.verified(on.db, TOKEN_AT))!;
  await on.close();

  const s = await serve({ VERIFICATION: "false" });
  await Q.saveVerified(s.db, row);
  assert.equal((await s.api({ action: "verifysourcecode", ...single() })).json().result, "Contract verification is switched off for now");
  assert.equal((await s.get("/verify")).statusCode, 404);
  assert.equal((await s.post("/verify", single())).statusCode, 404);
  assert.ok(!(await s.get("/blocks")).body.includes('href="/verify"'));
  assert.equal(s.state.compiles, 0);
  assert.equal((await s.api({ action: "getabi", address: TOKEN_AT })).json().result, JSON.stringify(ABI));
  const page = (await s.get(`/address/${TOKEN_AT}?tab=contract`)).body;
  assert.ok(page.includes(SOURCE) && !page.includes("/verify?address="));
  await s.close();
});

test("the explorer stops without waiting for a compilation that has not ended", async () => {
  const s = await serve();
  s.state.hold = new Promise(() => undefined);
  const second = "0x00000000000000000000000000000000000c0de8" as Hex;
  s.chain.code.set(second, `0x${RUNTIME}`);
  for (const contractaddress of [TOKEN_AT, second]) {
    assert.equal((await s.api({ action: "verifysourcecode", ...single({ contractaddress }) })).json().status, "1");
  }
  assert.equal(s.state.compiles, 1);
  await s.close();
  assert.equal(s.state.compiles, 1, "the one that was waiting is not started");
});
