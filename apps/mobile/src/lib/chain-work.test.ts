import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { encodeFunctionResult, parseAbi, type Hex } from "viem";
import { chainCheck, checkChain, outputRootOf, solvePuzzle, zeroBits, type RootParts } from "./chain-work.ts";

const word = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const oracleAbi = parseAbi([
  "function latestOutputIndex() view returns (uint256)",
  "function getL2Output(uint256 index) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
]);

test("zero bits are counted from the first byte", () => {
  assert.equal(zeroBits(Uint8Array.from([0, 0, 0x10, 0xff])), 19);
  assert.equal(zeroBits(Uint8Array.from([0x80])), 0);
  assert.equal(zeroBits(Uint8Array.from([0x01, 0])), 7);
  assert.equal(zeroBits(new Uint8Array(4)), 32);
});

test("the puzzle's answer is the one the API checks: sha256 of nonce:counter", async () => {
  let pauses = 0;
  const counter = await solvePuzzle("4f2a9c", 10, async () => void pauses++);
  const digest = createHash("sha256").update(`4f2a9c:${counter}`).digest();
  assert.ok(zeroBits(digest) >= 10);
  for (let i = 0; i < Number(counter); i++) assert.ok(zeroBits(createHash("sha256").update(`4f2a9c:${i}`).digest()) < 10, "the first answer");
  assert.equal(pauses, Math.floor(Number(counter) / 2000));
});

/** BSC and LONGYU as the phone sees them: one posted state root and the block behind it. */
function chains(parts: RootParts, posted: Hex, seen: { url: string; method: string }[]) {
  return (async (url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    seen.push({ url, method });
    let result: unknown;
    if (method === "eth_call") {
      const data = (params[0] as { data: string }).data;
      result = data.startsWith("0x69f16eec")
        ? encodeFunctionResult({ abi: oracleAbi, functionName: "latestOutputIndex", result: 278n })
        : encodeFunctionResult({ abi: oracleAbi, functionName: "getL2Output", result: { outputRoot: posted, timestamp: 1n, l2BlockNumber: 1_004_400n } });
    } else if (method === "eth_getBlockByNumber") {
      assert.deepEqual(params, ["0xf5370", false]);
      result = { stateRoot: parts.stateRoot, hash: parts.blockHash };
    } else if (method === "eth_getProof") {
      assert.deepEqual(params, ["0x4200000000000000000000000000000000000016", [], "0xf5370"]);
      result = { storageHash: parts.messagePasserRoot };
    }
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  }) as unknown as typeof fetch;
}

test("the chain check reads the root on BSC itself and rebuilds it from LONGYU", async () => {
  const parts = { stateRoot: word(), messagePasserRoot: word(), blockHash: word() };
  const seen: { url: string; method: string }[] = [];
  const ok = await checkChain(undefined, chains(parts, outputRootOf(parts), seen));
  assert.deepEqual([ok.index, ok.l2Block, ok.match], [278n, 1_004_400n, true]);
  assert.deepEqual(ok.parts, parts);
  // BSC is asked directly for the posted root; LONGYU only for the block's own data.
  assert.deepEqual(seen.filter((s) => s.method === "eth_call").map((s) => s.url), [chainCheck.l1RpcUrl, chainCheck.l1RpcUrl]);
  assert.ok(seen.filter((s) => s.method !== "eth_call").every((s) => s.url === chainCheck.l2RpcUrl));

  const bad = await checkChain(277n, chains(parts, word(), []));
  assert.deepEqual([bad.index, bad.match], [277n, false]);
});

test("the state root of LONGYU block 1,000,800 is the one posted on BSC testnet at index 277", () => {
  const parts = {
    stateRoot: "0xd7eb11c67dcd2dac63b7029c068b234cb9722add627ce68877de3e11bcb10ee8",
    messagePasserRoot: "0x9b844c762b4f6a8110f4a1d1ac4fef54cd22ba406a0ec5bdc7574a6dfb98c037",
    blockHash: "0x3c1d38fa6129d18ca077caf7d130b27a889a1f4a11c150a62decd4c9362a3ba9",
  } as const;
  assert.equal(outputRootOf(parts), "0xa1b959dc22e0d03288db4a620b83e8a4217732dd42648aa0c2bea405d549cc95");
});
