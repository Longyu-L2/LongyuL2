import { test } from "node:test";
import assert from "node:assert/strict";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { hexToBytes, parseTransaction, recoverMessageAddress, recoverTransactionAddress, recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { kmsAccount, parseDerSignature, type KmsLike } from "../src/services/signer.ts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function derInt(n: bigint): number[] {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = [...hexToBytes(`0x${hex}`)];
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return [0x02, bytes.length, ...bytes];
}

/** A stand-in for AWS KMS that signs with a local key and, like KMS, sometimes returns high-s. */
function fakeKms(privateKey: Hex): KmsLike & { highS: boolean } {
  const account = privateKeyToAccount(privateKey);
  const spkiPrefix = hexToBytes("0x3056301006072a8648ce3d020106052b8104000a034200");
  const state = { highS: true };
  return Object.assign(state, {
    async send(cmd: GetPublicKeyCommand | SignCommand) {
      if (cmd instanceof GetPublicKeyCommand) {
        return { PublicKey: new Uint8Array([...spkiPrefix, ...hexToBytes(account.publicKey)]) };
      }
      const hash = `0x${Buffer.from(cmd.input.Message as Uint8Array).toString("hex")}` as Hex;
      const sig = await sign({ hash, privateKey });
      let s = BigInt(sig.s);
      if (state.highS) s = N - s; // KMS does not normalise s
      const body = [...derInt(BigInt(sig.r)), ...derInt(s)];
      return { Signature: new Uint8Array([0x30, body.length, ...body]) };
    },
  });
}

test("DER parsing rejects garbage", () => {
  assert.throws(() => parseDerSignature(new Uint8Array([0x31, 0x00])));
});

test("KMS account signs messages, typed data and transactions recoverable to its address", async () => {
  const key = generatePrivateKey();
  const expected = privateKeyToAccount(key).address;
  const kms = fakeKms(key);
  const account = await kmsAccount(kms, "alias/longyu-publisher");
  assert.equal(account.address, expected);

  const message = "LONGYU";
  const msgSig = await account.signMessage({ message });
  assert.equal(await recoverMessageAddress({ message, signature: msgSig }), expected);

  const typed = {
    domain: { name: "LONGYU Faucet", version: "1", chainId: 31337, verifyingContract: "0x000000000000000000000000000000000000fa0c" as const },
    types: { Voucher: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }] },
    primaryType: "Voucher" as const,
    message: { recipient: expected, amount: 1n },
  };
  const tdSig = await account.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature: tdSig }), expected);

  for (const highS of [true, false]) {
    kms.highS = highS;
    const tx = await account.signTransaction({
      chainId: 31337, type: "eip1559", nonce: 3, to: expected, value: 1n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    });
    assert.equal(await recoverTransactionAddress({ serializedTransaction: tx as never }), expected);
    // Signatures are always low-s, as Ethereum requires.
    const parsed = parseTransaction(tx as never);
    assert.ok(BigInt(parsed.s!) <= N / 2n);
  }
});
