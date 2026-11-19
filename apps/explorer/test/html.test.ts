import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toEventSelector } from "viem";
import { addressPath, blockPath, esc, html, tokenPath, txPath } from "../src/web/html.ts";
import { cleanText, decodeTextResult } from "../src/tokens.ts";
import { ERC20_BRIDGE_FINALIZED_TOPIC, MESSAGE_PASSED_TOPIC } from "../src/queries.ts";
import { TRANSFER_TOPIC } from "../src/indexer.ts";
import { decodeCall, decodeLog, methodName } from "../src/decode.ts";

test("every interpolated value is escaped; nested html is not escaped twice", () => {
  const evil = `<img src=x onerror="alert(1)">'\``;
  const out = html`<p title="${evil}">${evil}${html`<b>${"&"}</b>`}${[html`<i>1</i>`, "<2>"]}${null}${undefined}${false}</p>`.value;
  assert.equal(out, `<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&#96;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&#96;<b>&amp;</b><i>1</i>&lt;2&gt;</p>`);
  assert.equal(esc("a&b"), "a&amp;b");
});

test("links are built only from validated values", () => {
  const a = "0x00000000000000000000000000000000000000aa";
  assert.equal(addressPath(a), `/address/${a}`);
  assert.equal(addressPath("javascript:alert(1)"), "/");
  // Paths take the canonical lower-case form only; routes lower-case input before building them.
  assert.equal(addressPath("0x00000000000000000000000000000000000000AA"), "/");
  assert.equal(tokenPath("0xzz"), "/");
  assert.equal(txPath(`0x${"ab".repeat(32)}`), `/tx/0x${"ab".repeat(32)}`);
  assert.equal(txPath("0x1234"), "/");
  assert.equal(blockPath(12n), "/block/12");
  assert.equal(blockPath("1; DROP"), "/");
});

test("token names lose control and bidi-override characters and are capped", () => {
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);
  assert.equal(cleanText(`US${zwsp}DT${rlo}gnp.exe\n`), "USDTgnp.exe");
  assert.equal(cleanText("x".repeat(100)).length, 48);
  // ABI string and bytes32 forms.
  assert.equal(decodeTextResult(encodeAbiParameters([{ type: "string" }], ["test"])), "test");
  assert.equal(decodeTextResult(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`), "MKR");
  assert.equal(decodeTextResult("0x"), null);
});

test("well-known topics and decoding", () => {
  assert.equal(TRANSFER_TOPIC, toEventSelector("Transfer(address,address,uint256)"));
  assert.equal(MESSAGE_PASSED_TOPIC, toEventSelector("MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)"));
  assert.equal(ERC20_BRIDGE_FINALIZED_TOPIC, toEventSelector("ERC20BridgeFinalized(address,address,address,address,uint256,bytes)"));
  assert.equal(methodName("0xd764ad0b"), "relayMessage");
  assert.equal(methodName("0x0166a07a"), "finalizeBridgeERC20");
  assert.equal(methodName("0xa9059cbb"), "transfer");
  const call = decodeCall(`0xa9059cbb${"0".repeat(24)}${"11".repeat(20)}${(5n).toString(16).padStart(64, "0")}`);
  assert.equal(call?.name, "transfer");
  assert.equal(call?.args[1]?.value, 5n);
  // ERC-20 Transfer (3 topics) and ERC-721 Transfer (4 topics) share topic0.
  const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const erc20 = decodeLog([TRANSFER_TOPIC, pad("0x01"), pad("0x02"), null], `0x${(7n).toString(16).padStart(64, "0")}`);
  assert.equal(erc20?.name, "Transfer");
  assert.equal(erc20?.args[2]?.value, 7n);
  assert.equal(decodeLog([`0x${"12".repeat(32)}`, null, null, null], "0x"), null);
});
