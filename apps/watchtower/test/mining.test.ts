import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { buildTree, canonicalJson, DATA_FORMAT, hashJson, LEAF_ENCODING } from "@longyu/reward-engine";
import { checkFile, checkMining, type DistributorView, type MiningDeps, type RootData } from "../src/mining.ts";
import { fileRootStore } from "../src/store.ts";
import { dataFetcher } from "../src/chain.ts";

const CHAIN = 668801n;
const DIST = getAddress("0x35acf3fdc2592e218fab449697b499b5d156d886");
const E18 = 10n ** 18n;
const MAX_PER_DAY = 90n * E18;
const NOW = 1_800_000_000n;
const acct = (n: number) => getAddress(`0x${(0x1000 + n).toString(16).padStart(40, "0")}`) as Address;

/** A data file exactly as the API's settlement writes it, and its root as posted on chain. */
function file(day: bigint, entries: [Address, bigint][], opts: { total?: bigint; tamper?: (f: Record<string, unknown>) => void } = {}) {
  const tree = buildTree(CHAIN, DIST, entries.map(([account, amount]) => ({ account, amount })));
  const total = opts.total ?? entries.reduce((s, [, v]) => s + v, 0n);
  const body: Record<string, unknown> = {
    format: DATA_FORMAT, chainId: CHAIN, distributor: DIST, day, root: tree.root, totalEntitled: total,
    leafEncoding: LEAF_ENCODING, entries: entries.map(([account, cumulative]) => ({ account, cumulative })), stats: {},
  };
  opts.tamper?.(body);
  const text = canonicalJson(body);
  const r: RootData = { root: tree.root as Hex, day, postedAt: NOW - 3600n, totalEntitled: total, dataHash: hashJson(text) };
  return { text, r };
}

type File = ReturnType<typeof file>;

function setup(o: { active?: File; pending?: File; claimableAt?: bigint; noKey?: boolean; claimed?: Record<string, bigint>; freezes?: number }) {
  const files = new Map<string, string>();
  if (o.active) files.set(`https://api.test/data/${o.active.r.root}`, o.active.text);
  if (o.pending) files.set(`https://api.test/data/${o.pending.r.root}`, o.pending.text);
  const state = { pending: o.pending?.r ?? null, paused: false, actions: [] as string[] };
  const distributor: DistributorView = {
    chainId: CHAIN, address: DIST,
    active: async () => o.active?.r ?? null,
    pending: async () => state.pending,
    claimableAt: async () => o.claimableAt ?? NOW + 40_000n,
    paused: async () => state.paused,
    maxRewardPerDay: async () => MAX_PER_DAY,
    claimed: async (a) => o.claimed?.[a] ?? 0n,
    dataUri: async (_day, root) => `https://api.test/data/${root}`,
  };
  if (!o.noKey) {
    distributor.veto = async () => ((state.actions.push("veto"), state.pending = null), "0xveto" as Hex);
    distributor.pause = async () => ((state.actions.push("pause"), state.paused = true), "0xpause" as Hex);
  }
  const store = fileRootStore(mkdtempSync(join(tmpdir(), "watchtower-")));
  const deps: MiningDeps = {
    distributor, store, now: () => NOW, marginSeconds: 7200n, newAccountsPerDay: 3, freezesPerRoot: o.freezes ?? 2, log: () => {},
    fetchText: async (url) => {
      const t = files.get(url);
      if (t === undefined) throw new Error("HTTP 404");
      return t;
    },
  };
  return { deps, state, store, files };
}

const day1 = file(1n, [[acct(1), 10n * E18], [acct(2), 20n * E18]]);
const day2 = file(2n, [[acct(1), 50n * E18], [acct(2), 60n * E18], [acct(3), 5n * E18]]);

test("mining watch: a waiting root that rebuilds from its file and grows within limits is accepted", async () => {
  const s = setup({ active: day1, pending: day2 });
  const c = await checkMining(s.deps);
  assert.equal(c.status, "ok", c.detail);
  assert.match(c.detail, /Day 2 is waiting and checked: 3 leaves, 1 new/);
  assert.ok(s.store.get(day1.r.root) && s.store.get(day2.r.root));
  assert.deepEqual(s.state.actions, []);
  s.files.clear();
  assert.equal((await checkMining(s.deps)).status, "ok", "accepted roots are not fetched again");
});

test("mining watch: a released backlog or a moved reserve within the contract's bound is accepted", async () => {
  // Day 2 allows 270 tLONG per account; account 1 jumps by 200 at once, a new wallet arrives with 150.
  const jump = file(2n, [[acct(1), 210n * E18], [acct(2), 20n * E18], [acct(9), 150n * E18]]);
  const s = setup({ active: day1, pending: jump });
  assert.equal((await checkMining(s.deps)).status, "ok");
});

test("mining watch: a file that does not match the posted root is stopped: pause first, then veto", async () => {
  const other = file(2n, [[acct(1), 50n * E18], [acct(2), 61n * E18]]);
  const s = setup({ active: day1, pending: { text: other.text, r: { ...day2.r } } });
  const c = await checkMining(s.deps);
  assert.equal(c.status, "critical");
  assert.match(c.detail, /hash is not the one posted.*paused claims in 0xpause and vetoed it in 0xveto/);
  assert.deepEqual(s.state.actions, ["pause", "veto"]);
  assert.match((await checkMining(s.deps)).detail, /Claims are paused/);
});

test("mining watch: a file that hashes right but is not a root's file is refused, never thrown", () => {
  for (const text of ["null", "[]", "1", '"x"', '{"entries":[null]}']) {
    const r: RootData = { ...day2.r, dataHash: keccak256(stringToBytes(text)) };
    const f = checkFile(text, r, CHAIN, DIST);
    assert.equal(f.ok, false, text);
  }
});

test("mining watch: leaves that do not rebuild the root, exceed the total or the bound are refused", async () => {
  const wrongRoot = file(2n, [[acct(1), 11n * E18], [acct(2), 21n * E18]], { tamper: (f) => { f.root = day2.r.root; } });
  wrongRoot.r.root = day2.r.root;
  let s = setup({ active: day1, pending: wrongRoot });
  assert.match((await checkMining(s.deps)).detail, /do not rebuild the root/);
  s = setup({ active: day1, pending: file(2n, [[acct(1), 11n * E18], [acct(2), 21n * E18]], { total: 31n * E18 }) });
  assert.match((await checkMining(s.deps)).detail, /add up to more than the root's total/);
  s = setup({ active: day1, pending: file(2n, [[acct(1), 270n * E18 + 1n], [acct(2), 20n * E18]]) });
  assert.match((await checkMining(s.deps)).detail, /1 leaf\(s\) above the contract's bound/);
});

test("mining watch: a lowered or dropped account must be frozen at exactly what it claimed", async () => {
  // Account 2 is frozen at its 5 claimed: accepted.
  let s = setup({ active: day1, pending: file(2n, [[acct(1), 50n * E18], [acct(2), 5n * E18]]), claimed: { [acct(2)]: 5n * E18 } });
  assert.equal((await checkMining(s.deps)).status, "ok");
  // Account 2 lowered to 5 with nothing claimed: its value moved elsewhere.
  s = setup({ active: day1, pending: file(2n, [[acct(1), 50n * E18], [acct(2), 5n * E18]]) });
  assert.match((await checkMining(s.deps)).detail, /was lowered to 5000000000000000000 wei, not to the 0/);
  // Account 2 dropped with 3 claimed and 17 unclaimed.
  s = setup({ active: day1, pending: file(2n, [[acct(1), 50n * E18]]), claimed: { [acct(2)]: 3n * E18 } });
  assert.match((await checkMining(s.deps)).detail, /lowered to 0 wei, not to the 3000000000000000000/);
  // More freezes than allowed in one root.
  s = setup({ active: day1, pending: file(2n, [[acct(1), 0n], [acct(2), 0n], [acct(3), 1n]]), freezes: 1 });
  assert.match((await checkMining(s.deps)).detail, /2 accounts lowered or dropped, more than the 1 freezes/);
});

test("mining watch: the new-account limit is fixed, not raised by accepted roots", async () => {
  const flood = file(2n, [[acct(1), 10n * E18], [acct(2), 20n * E18], ...Array.from({ length: 4 }, (_, i) => [acct(100 + i), E18] as [Address, bigint])]);
  const s = setup({ active: day1, pending: flood });
  assert.match((await checkMining(s.deps)).detail, /4 new accounts, more than the limit of 3/);
});

test("mining watch: a file that cannot be read waits, then is stopped before the root matures", async () => {
  let s = setup({ active: day1, pending: day2 });
  s.files.delete(`https://api.test/data/${day2.r.root}`);
  assert.equal((await checkMining(s.deps)).status, "warning");
  assert.deepEqual(s.state.actions, []);
  s = setup({ active: day1, pending: day2, claimableAt: NOW + 3600n });
  s.files.delete(`https://api.test/data/${day2.r.root}`);
  const c = await checkMining(s.deps);
  assert.match(c.detail, /could not be checked in time/);
  assert.deepEqual(s.state.actions, ["pause", "veto"]);
});

test("mining watch: a check that throws inside the margin still stops the root", async () => {
  const s = setup({ active: day1, pending: day2, claimableAt: NOW + 3600n });
  s.deps.store.put({ day: "1", root: day1.r.root, entries: { [acct(1)]: String(10n * E18), [acct(2)]: String(20n * E18) }, newAccounts: 0 });
  s.deps.distributor.maxRewardPerDay = async () => { throw new Error("node down"); };
  const c = await checkMining(s.deps);
  assert.match(c.detail, /could not be checked in time: node down/);
  assert.deepEqual(s.state.actions, ["pause", "veto"]);
});

test("mining watch: an unreadable active root does not stop the waiting root's check", async () => {
  const s = setup({ active: day1, pending: day2, claimableAt: NOW + 3600n });
  s.files.delete(`https://api.test/data/${day1.r.root}`);
  const c = await checkMining(s.deps);
  assert.match(c.detail, /the active root it follows is not checked/);
  assert.deepEqual(s.state.actions, ["pause", "veto"]);
});

test("mining watch: a wrong active root pauses claims", async () => {
  const s = setup({ active: { text: day2.text, r: { ...day1.r } } });
  const c = await checkMining(s.deps);
  assert.match(c.detail, /The active root for day 1 is wrong/);
  assert.deepEqual(s.state.actions, ["pause"]);
});

test("mining watch: without the guardian key it reports and stops nothing", async () => {
  const s = setup({ active: day1, pending: { text: day1.text, r: { ...day2.r } }, noKey: true });
  const c = await checkMining(s.deps);
  assert.equal(c.status, "critical");
  assert.match(c.detail, /guardian key is not set/);
});

test("mining watch: the first root is judged against the contract's bound for the days since launch", async () => {
  assert.equal((await checkMining(setup({ pending: file(0n, [[acct(1), 10n * E18]]) }).deps)).status, "ok");
  const s = setup({ pending: file(0n, [[acct(1), MAX_PER_DAY + 1n]]) });
  assert.match((await checkMining(s.deps)).detail, /above the contract's bound/);
});

test("data fetcher: only allowed origins, no redirects, bounded size", async () => {
  const get = dataFetcher(["https://api.longyu.network"], 10);
  await assert.rejects(get("https://evil.example/x"), /not an allowed origin/);
  await assert.rejects(get("http://api.longyu.network/x"), /not an allowed origin/);
  await assert.rejects(get("not a url"), /not a URL/);
});
