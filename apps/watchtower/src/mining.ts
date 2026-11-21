/**
 * The second mining watch. It runs apart from the API and needs nothing from it but the published
 * data file of each root, and it keeps its own copy of every file it has accepted. For each root
 * waiting out its challenge delay it checks that:
 * - the data file is the one committed on chain (its hash), and rebuilds exactly the root posted;
 * - its leaves add up to no more than the root's total, and none is above the contract's own bound
 *   per account (maxRewardPerDay for every day since day 0);
 * - against this service's own copy of the active root, which the API cannot rewrite: an account that
 *   went down or out was frozen at exactly what it has claimed on chain, at most a few per root (a
 *   freeze is a ban, and rare), so value cannot quietly move from honest accounts to others;
 * - no more new accounts appear than a fixed number per day, set here and not learned from roots.
 * A root that fails, whose file cannot be read, or whose check fails in any way, is stopped before
 * its delay runs short: claims are paused (which also stops the root maturing) and it is vetoed,
 * with this service's own guardian key. An active root that fails pauses claims.
 */
import { getAddress, type Address, type Hex } from "viem";
import { buildTree, DATA_FORMAT, hashJson, LEAF_ENCODING } from "@longyu/reward-engine";
import type { Check, Log } from "./checks.ts";

export interface RootData {
  root: Hex;
  day: bigint;
  postedAt: bigint;
  totalEntitled: bigint;
  dataHash: Hex;
}

export interface DistributorView {
  chainId: bigint;
  address: Address;
  active(): Promise<RootData | null>;
  pending(): Promise<RootData | null>;
  claimableAt(): Promise<bigint>;
  paused(): Promise<boolean>;
  maxRewardPerDay(): Promise<bigint>;
  claimed(account: Address): Promise<bigint>;
  /** The data file address posted with the root (its RootProposed event), or null if not found. */
  dataUri(day: bigint, root: Hex): Promise<string | null>;
  /** Absent without the guardian key: the service then reports and stops nothing. */
  veto?: () => Promise<Hex>;
  pause?: () => Promise<Hex>;
}

/** A root this service has checked and accepted, with its leaves. */
export interface Verified {
  day: string;
  root: Hex;
  /** account (checksummed) to cumulative entitlement, in wei as a decimal string. */
  entries: Record<string, string>;
  newAccounts: number;
}

export interface RootStore {
  get(root: Hex): Verified | null;
  put(v: Verified): void;
  /** The newest accepted roots, newest first. */
  recent(n: number): Verified[];
}

export interface MiningDeps {
  distributor: DistributorView;
  store: RootStore;
  fetchText(url: string): Promise<string>;
  now(): bigint;
  /** A waiting root not accepted this long before it becomes claimable is stopped. */
  marginSeconds: bigint;
  /** New accounts allowed per day since the active root. */
  newAccountsPerDay: number;
  /** Accounts allowed to be frozen in one root. */
  freezesPerRoot: number;
  log: Log;
}

type Parsed = { ok: true; entries: Map<Address, bigint> } | { ok: false; problem: string };

/** Checks a data file against the root posted on chain. Never throws: anything unexpected is a problem. */
export function checkFile(text: string, r: RootData, chainId: bigint, distributor: Address): Parsed {
  try {
    return parseFile(text, r, chainId, distributor);
  } catch (e) {
    return { ok: false, problem: `the data file could not be read as a root (${e instanceof Error ? e.message : String(e)})` };
  }
}

function parseFile(text: string, r: RootData, chainId: bigint, distributor: Address): Parsed {
  if (hashJson(text).toLowerCase() !== r.dataHash.toLowerCase()) return { ok: false, problem: "the data file's hash is not the one posted" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: "the data file is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, problem: "the data file is not a root's file" };
  const f = parsed as Record<string, unknown>;
  const fields: [string, unknown, unknown][] = [
    ["format", f.format, DATA_FORMAT],
    ["chainId", f.chainId, String(chainId)],
    ["day", f.day, String(r.day)],
    ["root", typeof f.root === "string" ? f.root.toLowerCase() : f.root, r.root.toLowerCase()],
    ["totalEntitled", f.totalEntitled, String(r.totalEntitled)],
    ["leafEncoding", JSON.stringify(f.leafEncoding), JSON.stringify(LEAF_ENCODING)],
  ];
  for (const [k, got, want] of fields) if (got !== want) return { ok: false, problem: `the data file's ${k} is not the root's` };
  if (typeof f.distributor !== "string" || f.distributor.toLowerCase() !== distributor.toLowerCase()) return { ok: false, problem: "the data file is for another contract" };
  if (!Array.isArray(f.entries) || f.entries.length === 0) return { ok: false, problem: "the data file has no leaves" };
  const entries = new Map<Address, bigint>();
  let sum = 0n;
  for (const e of f.entries as unknown[]) {
    const { account, cumulative } = (e !== null && typeof e === "object" ? e : {}) as { account?: unknown; cumulative?: unknown };
    if (typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account) || typeof cumulative !== "string" || !/^\d{1,78}$/.test(cumulative)) {
      return { ok: false, problem: "the data file has a malformed leaf" };
    }
    const a = getAddress(account);
    if (entries.has(a)) return { ok: false, problem: `the data file lists ${a} twice` };
    entries.set(a, BigInt(cumulative));
    sum += BigInt(cumulative);
  }
  if (sum > r.totalEntitled) return { ok: false, problem: "the leaves add up to more than the root's total" };
  const rebuilt = buildTree(chainId, distributor, [...entries].map(([account, amount]) => ({ account, amount }))).root;
  if (rebuilt.toLowerCase() !== r.root.toLowerCase()) return { ok: false, problem: "the leaves do not rebuild the root posted" };
  return { ok: true, entries };
}

const toVerified = (r: RootData, entries: Map<Address, bigint>, newAccounts: number): Verified => ({
  day: String(r.day),
  root: r.root,
  entries: Object.fromEntries([...entries].map(([a, v]) => [a, v.toString()])),
  newAccounts,
});

type Loaded = { kind: "ok"; entries: Map<Address, bigint> } | { kind: "unavailable"; why: string } | { kind: "wrong"; problem: string };

async function load(d: MiningDeps, r: RootData): Promise<Loaded> {
  let uri: string | null;
  try {
    uri = await d.distributor.dataUri(r.day, r.root);
  } catch (e) {
    return { kind: "unavailable", why: `its RootProposed event could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!uri) return { kind: "unavailable", why: "its RootProposed event was not found" };
  let text: string;
  try {
    text = await d.fetchText(uri);
  } catch (e) {
    return { kind: "unavailable", why: `its data file could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
  const f = checkFile(text, r, d.distributor.chainId, d.distributor.address);
  return f.ok ? { kind: "ok", entries: f.entries } : { kind: "wrong", problem: f.problem };
}

/** Problems with a root's leaves, against the contract's bound and this service's copy of an older root. */
export async function leafProblems(
  d: MiningDeps,
  r: RootData,
  entries: Map<Address, bigint>,
  base: Verified | null,
): Promise<{ problems: string[]; newAccounts: number }> {
  const problems: string[] = [];
  const bound = (await d.distributor.maxRewardPerDay()) * (r.day + 1n);
  const over = [...entries].filter(([, v]) => v > bound).map(([a]) => a);
  if (over.length > 0) problems.push(`${over.length} leaf(s) above the contract's bound of ${bound} wei, such as ${over.slice(0, 3).join(", ")}`);

  let newAccounts = 0;
  for (const a of entries.keys()) if (base?.entries[a] === undefined) newAccounts++;
  const days = base ? r.day - BigInt(base.day) : r.day + 1n;
  const limit = BigInt(d.newAccountsPerDay) * (days > 0n ? days : 1n);
  if (BigInt(newAccounts) > limit) problems.push(`${newAccounts} new accounts, more than the limit of ${limit}`);

  // Accounts that went down or out: each frozen at exactly what it has claimed.
  if (base) {
    const lowered: Address[] = [];
    for (const [a, v] of Object.entries(base.entries)) {
      const now = entries.get(a as Address) ?? 0n;
      if (now < BigInt(v)) lowered.push(a as Address);
    }
    if (lowered.length > d.freezesPerRoot) {
      problems.push(`${lowered.length} accounts lowered or dropped, more than the ${d.freezesPerRoot} freezes allowed in one root`);
    } else {
      for (const a of lowered) {
        const claimed = await d.distributor.claimed(a);
        if ((entries.get(a) ?? 0n) !== claimed) problems.push(`${a} was lowered to ${entries.get(a) ?? 0n} wei, not to the ${claimed} it has claimed`);
      }
    }
  }
  return { problems, newAccounts };
}

export async function checkMining(d: MiningDeps): Promise<Check> {
  const name = "mining roots";
  const dist = d.distributor;
  const [active, pending, paused] = await Promise.all([dist.active(), dist.pending(), dist.paused()]);

  // The active root: one this service accepted, or one it checks now against the newest it holds.
  let base: Verified | null = null;
  let activeNote = "";
  if (active) {
    base = d.store.get(active.root);
    if (!base) {
      const got = await load(d, active);
      if (got.kind === "wrong") return stop(d, `The active root for day ${active.day} is wrong: ${got.problem}.`, pending, paused);
      if (got.kind === "unavailable") {
        activeNote = ` The active root for day ${active.day} is not checked: ${got.why}.`;
      } else {
        const older = d.store.recent(1)[0] ?? null;
        const { problems, newAccounts } = await leafProblems(d, active, got.entries, older && BigInt(older.day) < active.day ? older : null);
        if (problems.length > 0) return stop(d, `The active root for day ${active.day} is refused: ${problems.join("; ")}.`, pending, paused);
        base = toVerified(active, got.entries, newAccounts);
        d.store.put(base);
        d.log("root_accepted", { day: base.day, root: base.root, leaves: got.entries.size, as: "active" });
      }
    }
  }

  if (!pending) {
    if (paused) return { name, status: "critical", detail: `Claims are paused. Only the admin unpauses.${activeNote}` };
    if (activeNote) return { name, status: "warning", detail: activeNote.trim() };
    return { name, status: "ok", detail: active ? `Day ${active.day} is active and checked; no root waiting.` : "No root posted yet." };
  }
  if (d.store.get(pending.root)) {
    if (paused) return { name, status: "critical", detail: `Day ${pending.day} is waiting and checked, and claims are paused.` };
    return { name, status: activeNote ? "warning" : "ok", detail: `Day ${pending.day} is waiting and checked.${activeNote}` };
  }

  // Any failure from here on, if it lasts into the margin, stops the root.
  const late = async () => d.now() + d.marginSeconds >= (await dist.claimableAt());
  try {
    const got = await load(d, pending);
    if (got.kind === "wrong") return stop(d, `The waiting root for day ${pending.day} is wrong: ${got.problem}.`, pending, paused);
    if (got.kind === "unavailable") {
      if (await late()) return stop(d, `The waiting root for day ${pending.day} could not be checked in time: ${got.why}.`, pending, paused);
      return { name, status: "warning", detail: `The waiting root for day ${pending.day} cannot be checked yet: ${got.why}.${activeNote}` };
    }
    if (active && !base) {
      if (await late()) return stop(d, `The waiting root for day ${pending.day} could not be checked in time: the active root it follows is not checked.`, pending, paused);
      return { name, status: "warning", detail: `The waiting root for day ${pending.day} waits for the active root to be checked.${activeNote}` };
    }
    const { problems, newAccounts } = await leafProblems(d, pending, got.entries, base);
    if (problems.length > 0) return stop(d, `The waiting root for day ${pending.day} is refused: ${problems.join("; ")}.`, pending, paused);
    d.store.put(toVerified(pending, got.entries, newAccounts));
    d.log("root_accepted", { day: String(pending.day), root: pending.root, leaves: got.entries.size, newAccounts });
    return { name, status: "ok", detail: `Day ${pending.day} is waiting and checked: ${got.entries.size} leaves, ${newAccounts} new.` };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (await late().catch(() => true)) return stop(d, `The waiting root for day ${pending.day} could not be checked in time: ${why}.`, pending, paused);
    throw e;
  }
}

async function stop(d: MiningDeps, found: string, pending: RootData | null, paused: boolean): Promise<Check> {
  const name = "mining roots";
  d.log("mining_root_refused", { found });
  if (!d.distributor.veto || !d.distributor.pause) {
    return { name, status: "critical", detail: `${found} The guardian key is not set: pause and veto by hand.` };
  }
  const done: string[] = [];
  let failed = "";
  // The pause first: while paused no root matures, so the veto that follows cannot come too late.
  if (!paused) {
    try {
      done.push(`paused claims in ${await d.distributor.pause()}`);
    } catch (e) {
      failed += ` The pause failed: ${e instanceof Error ? e.message : String(e)}.`;
    }
  }
  if (pending) {
    try {
      done.push(`vetoed it in ${await d.distributor.veto()}`);
    } catch (e) {
      failed += ` The veto failed: ${e instanceof Error ? e.message : String(e)}.`;
    }
  }
  d.log("mining_root_stopped", { done, failed: failed || null });
  return { name, status: "critical", detail: `${found}${done.length ? ` The watchtower ${done.join(" and ")}.` : ""}${failed} Only the admin unpauses.` };
}
