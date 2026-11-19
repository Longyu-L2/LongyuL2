import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, en, pickLanguage, translator } from "./i18n.ts";

test("every language defines every string", () => {
  const keys = Object.keys(en).sort();
  for (const [lang, table] of Object.entries(LANGUAGES)) {
    assert.deepEqual(Object.keys(table).sort(), keys, lang);
    for (const k of keys) assert.ok((table as Record<string, string>)[k]?.trim(), `${lang}.${k} is empty`);
  }
});

test("language selection", () => {
  assert.equal(pickLanguage(["zh-Hant-TW"]), "zh-Hant");
  assert.equal(pickLanguage(["zh-HK"]), "zh-Hant");
  assert.equal(pickLanguage(["zh-CN"]), "zh-Hans");
  assert.equal(pickLanguage(["fr-FR", "en-GB"]), "en");
  assert.equal(pickLanguage(["fr-FR"]), "en");
  assert.equal(translator("zh-Hans")("claim"), "领取到我的钱包");
});
