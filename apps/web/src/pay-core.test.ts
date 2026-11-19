import { test } from "node:test";
import assert from "node:assert/strict";
import { explorerTxUrl, parseOrderId } from "./pay-core.ts";

test("pay page: order IDs are read strictly from the link", () => {
  const id = `0x${"ab".repeat(32)}`;
  assert.equal(parseOrderId(`?order=${id}`), id);
  assert.equal(parseOrderId(`?order=${id.toUpperCase().replace("0X", "0x")}`), id);
  for (const bad of ["", "?order=", "?order=0x12", `?order=${id}00`, `?id=${id}`, "?order=<script>"]) assert.equal(parseOrderId(bad), null, bad);
});

test("pay page: transactions link to the right BscScan", () => {
  assert.equal(explorerTxUrl(56, "0xab"), "https://bscscan.com/tx/0xab");
  assert.equal(explorerTxUrl(97, "0xab"), "https://testnet.bscscan.com/tx/0xab");
});
