import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanInviteCode, inviteCodeFrom, inviteLink } from "./invite.ts";

test("an invite code is trimmed and upper-cased, and anything that cannot be a code is dropped", () => {
  assert.equal(cleanInviteCode(" 3ufrcysj "), "3UFRCYSJ");
  assert.equal(cleanInviteCode("LY7K2Q"), "LY7K2Q");
  assert.equal(cleanInviteCode("A".repeat(16)), "A".repeat(16));
  for (const bad of [undefined, null, "", "abc", "A".repeat(17), "AB CD", "ABCD-EFGH", "<script>", "ABCD%20", "邀请码邀请码"]) {
    assert.equal(cleanInviteCode(bad), "", String(bad));
  }
});

test("the code is read from the page address", () => {
  assert.equal(inviteCodeFrom("?invite=3UFRCYSJ"), "3UFRCYSJ");
  assert.equal(inviteCodeFrom("?utm_source=x&invite=3ufrcysj"), "3UFRCYSJ");
  assert.equal(inviteCodeFrom("?invite=%203UFRCYSJ%20"), "3UFRCYSJ");
  assert.equal(inviteCodeFrom(""), "");
  assert.equal(inviteCodeFrom("?invite="), "");
  assert.equal(inviteCodeFrom("?invited=3UFRCYSJ"), "");
  assert.equal(inviteCodeFrom("?invite=%3Cscript%3E"), "");
});

test("the link an account shares is read back as its code", () => {
  const link = inviteLink("https://mine-testnet.longyu.network", "3UFRCYSJ");
  assert.equal(link, "https://mine-testnet.longyu.network/?invite=3UFRCYSJ");
  assert.equal(inviteCodeFrom(new URL(link).search), "3UFRCYSJ");
});
