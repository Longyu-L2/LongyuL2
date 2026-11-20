/** Read side: what the pages and the API show. All inputs are validated before they get here. */
import type { Queryable } from "./db.ts";
import { L2_BRIDGE, MESSAGE_PASSER } from "./decode.ts";
import { TRANSFER_TOPIC } from "./indexer.ts";

export interface BlockRow {
  number: bigint;
  hash: string;
  parent_hash: string;
  timestamp: bigint;
  miner: string;
  gas_used: string;
  gas_limit: string;
  base_fee: string | null;
  size: number | null;
  tx_count: number;
}

export interface TxRow {
  hash: string;
  block_number: bigint;
  tx_index: number;
  timestamp: bigint;
  from_address: string;
  to_address: string | null;
  contract_address: string | null;
  value: string;
  nonce: bigint;
  type: number;
  gas_limit: string;
  gas_used: string | null;
  gas_price: string | null;
  l1_fee: string | null;
  status: number | null;
  method_id: string | null;
  input: string;
  source_hash: string | null;
  mint: string | null;
}

/** A transaction in a list: all but its calldata, which can be large and is read on the transaction's own page. */
export type TxListRow = Omit<TxRow, "input">;

/** The first rows of a list that is cut at a limit, and how many there are in all. */
export interface Part<T> {
  rows: T[];
  total: number;
}

export interface TransferRow {
  block_number: bigint;
  log_index: number;
  tx_hash: string;
  timestamp: bigint;
  token: string;
  from_address: string;
  to_address: string;
  value: string;
  token_id: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  kind: "erc20" | "erc721";
}

export interface TokenRow {
  address: string;
  kind: "erc20" | "erc721";
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  first_block: bigint;
  holders: bigint;
  transfers: bigint;
}

export interface LogRow {
  log_index: number;
  address: string;
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  /** The event's data, or its first DATA_BYTES bytes when it has more; `data_bytes` is how many it has. */
  data: string;
  data_bytes: number;
}

/** keccak256("MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)") */
export const MESSAGE_PASSED_TOPIC = "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054";
/** keccak256("ERC20BridgeFinalized(address,address,address,address,uint256,bytes)") */
export const ERC20_BRIDGE_FINALIZED_TOPIC = "0xd59c65b35445225835c83f50b6ede06a7be047d22e357073e250d9af537518cd";

/** Most events and token transfers of one transaction that a page or an API answer carries. */
export const TX_ITEMS = 200;
/** Counts of an address's or a token's rows stop here instead of reading every row; pages show "10,000+". */
export const COUNT_CAP = 10_000;
/**
 * Most bytes of calldata or of event data that a row of a list carries. One transaction can hold
 * 128 kB of either and a list many such rows, so the rest is cut off in the database and never
 * read. A transaction's own page and `/api/v1/tx` still give its calldata whole.
 */
export const DATA_BYTES = 4096;

const txListColumns = (p = "") =>
  `${p}hash, ${p}block_number, ${p}tx_index, ${p}timestamp, ${p}from_address, ${p}to_address, ${p}contract_address, ${p}value::text AS value,
   ${p}nonce, ${p}type, ${p}gas_limit::text AS gas_limit, ${p}gas_used::text AS gas_used, ${p}gas_price::text AS gas_price,
   ${p}l1_fee::text AS l1_fee, ${p}status, ${p}method_id, ${p}source_hash, ${p}mint::text AS mint`;
const TX_LIST_COLUMNS = txListColumns();
const TX_COLUMNS = `${TX_LIST_COLUMNS}, input`;
const BLOCK_COLUMNS = "number, hash, parent_hash, timestamp, miner, gas_used::text AS gas_used, gas_limit::text AS gas_limit, base_fee::text AS base_fee, size, tx_count";
const TRANSFER_COLUMNS = `x.block_number, x.log_index, x.tx_hash, x.timestamp, x.token, x.from_address, x.to_address, x.value::text AS value,
  x.token_id::text AS token_id, t.name, t.symbol, t.decimals, t.kind`;
/** A hex column's first DATA_BYTES bytes: "0x" and two characters a byte. */
const firstBytes = (column: string) => `left(${column}, ${2 + 2 * DATA_BYTES})`;
const logColumns = (p = "") =>
  `${p}log_index, ${p}address, ${p}topic0, ${p}topic1, ${p}topic2, ${p}topic3, ${firstBytes(`${p}data`)} AS data, (octet_length(${p}data) - 2) / 2 AS data_bytes`;
const TOKEN_COLUMNS = `t.address, t.kind, t.name, t.symbol, t.decimals, t.first_block,
  (SELECT count(*) FROM (SELECT 1 FROM token_balances b WHERE b.token = t.address AND b.balance > 0 LIMIT ${COUNT_CAP}) c)::bigint AS holders,
  (SELECT count(*) FROM (SELECT 1 FROM token_transfers x WHERE x.token = t.address LIMIT ${COUNT_CAP}) c)::bigint AS transfers`;

export async function stats(q: Queryable) {
  const head = (await q.query<{ number: bigint; timestamp: bigint; base_fee: string | null }>(
    "SELECT number, timestamp, base_fee::text AS base_fee FROM blocks ORDER BY number DESC LIMIT 1",
  )).rows[0];
  // Average over the last 1,000 blocks (timestamps are whole seconds and blocks come four a second),
  // or over all of them while the chain is younger.
  const past = head
    ? (await q.query<{ number: bigint; timestamp: bigint }>("SELECT number, timestamp FROM blocks WHERE number >= $1 ORDER BY number ASC LIMIT 1", [head.number - 1000n])).rows[0]
    : undefined;
  const txs = (await q.query<{ value: bigint }>("SELECT value FROM counters WHERE name = 'transactions'")).rows[0]?.value ?? 0n;
  const tokens = (await q.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM tokens")).rows[0]?.n ?? 0n;
  const blockTime = head && past && head.number > past.number ? Number(head.timestamp - past.timestamp) / Number(head.number - past.number) : null;
  return { head: head ?? null, transactions: txs, tokens, blockTime };
}

/** Transactions in the 24 hours before `now` (seconds since 1970). */
export async function lastDayTransactions(q: Queryable, now: number): Promise<bigint> {
  return (await q.query<{ n: bigint }>("SELECT count(*)::bigint AS n FROM transactions WHERE timestamp > $1", [BigInt(Math.floor(now) - 86_400)])).rows[0]?.n ?? 0n;
}

/** Transactions made in each of the last `days` UTC days, today included, oldest first. A day without any may be missing. */
export async function dailyTransactions(q: Queryable, days: number, now: number): Promise<{ day: number; count: number }[]> {
  const today = Math.floor(now / 86_400);
  const rows = (await q.query<{ day: number; count: bigint }>(
    "SELECT day, count FROM daily_transactions WHERE day > $1 AND day <= $2 ORDER BY day ASC",
    [today - days, today],
  )).rows;
  return rows.map((r) => ({ day: Number(r.day), count: Number(r.count) }));
}

export async function latestBlocks(q: Queryable, limit: number, offset = 0): Promise<BlockRow[]> {
  return (await q.query<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM blocks ORDER BY number DESC LIMIT $1 OFFSET $2`, [limit, offset])).rows;
}

export async function block(q: Queryable, id: { number?: bigint; hash?: string }): Promise<BlockRow | null> {
  const r = id.number !== undefined
    ? await q.query<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE number = $1`, [id.number])
    : await q.query<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE hash = $1`, [id.hash]);
  return r.rows[0] ?? null;
}

export async function blockTxs(q: Queryable, number: bigint, limit: number, offset = 0): Promise<TxListRow[]> {
  return (await q.query<TxListRow>(
    `SELECT ${TX_LIST_COLUMNS} FROM transactions WHERE block_number = $1 ORDER BY tx_index LIMIT $2 OFFSET $3`,
    [number, limit, offset],
  )).rows;
}

export async function latestTxs(q: Queryable, limit: number, offset = 0): Promise<TxListRow[]> {
  return (await q.query<TxListRow>(`SELECT ${TX_LIST_COLUMNS} FROM transactions ORDER BY block_number DESC, tx_index DESC LIMIT $1 OFFSET $2`, [limit, offset])).rows;
}

export async function tx(q: Queryable, hash: string): Promise<TxRow | null> {
  return (await q.query<TxRow>(`SELECT ${TX_COLUMNS} FROM transactions WHERE hash = $1`, [hash])).rows[0] ?? null;
}

/** A list that came back full was cut, and only then are its rows counted. */
async function part<T>(q: Queryable, rows: T[], limit: number, table: "logs" | "token_transfers", hash: string): Promise<Part<T>> {
  if (rows.length < limit) return { rows, total: rows.length };
  return { rows, total: (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tx_hash = $1`, [hash])).rows[0]!.n };
}

/** A transaction's first events: one transaction can emit thousands. */
export async function txLogs(q: Queryable, hash: string, limit = TX_ITEMS): Promise<Part<LogRow>> {
  const rows = (await q.query<LogRow>(
    `SELECT ${logColumns()} FROM logs WHERE tx_hash = $1 ORDER BY log_index LIMIT $2`,
    [hash, limit],
  )).rows;
  return part(q, rows, limit, "logs", hash);
}

export async function txTransfers(q: Queryable, hash: string, limit = TX_ITEMS): Promise<Part<TransferRow>> {
  const rows = (await q.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM token_transfers x JOIN tokens t ON t.address = x.token WHERE x.tx_hash = $1 ORDER BY x.log_index LIMIT $2`,
    [hash, limit],
  )).rows;
  return part(q, rows, limit, "token_transfers", hash);
}

export async function addressTxs(q: Queryable, address: string, limit: number, offset = 0): Promise<TxListRow[]> {
  return (await q.query<TxListRow>(
    `SELECT ${TX_LIST_COLUMNS} FROM transactions WHERE hash IN (
       SELECT hash FROM (
         (SELECT hash, block_number, tx_index FROM transactions WHERE from_address = $1 ORDER BY block_number DESC, tx_index DESC LIMIT $2::int + $3::int)
         UNION
         (SELECT hash, block_number, tx_index FROM transactions WHERE to_address = $1 ORDER BY block_number DESC, tx_index DESC LIMIT $2::int + $3::int)
         UNION
         (SELECT hash, block_number, tx_index FROM transactions WHERE contract_address = $1)
       ) u ORDER BY block_number DESC, tx_index DESC LIMIT $2 OFFSET $3)
     ORDER BY block_number DESC, tx_index DESC`,
    [address, limit, offset],
  )).rows;
}

/** An address's transactions, counted up to COUNT_CAP: each index is read no further than that. */
export async function addressTxCount(q: Queryable, address: string): Promise<bigint> {
  return (await q.query<{ n: bigint }>(
    `SELECT count(*)::bigint AS n FROM (
       SELECT hash FROM (
         (SELECT hash FROM transactions WHERE from_address = $1 LIMIT $2)
         UNION
         (SELECT hash FROM transactions WHERE to_address = $1 LIMIT $2)
         UNION
         (SELECT hash FROM transactions WHERE contract_address = $1 LIMIT $2)
       ) u LIMIT $2) c`,
    [address, COUNT_CAP],
  )).rows[0]!.n;
}

export async function addressTransfers(q: Queryable, address: string, limit: number, offset = 0): Promise<TransferRow[]> {
  return (await q.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM token_transfers x JOIN tokens t ON t.address = x.token
     WHERE (x.block_number, x.log_index) IN (
       SELECT block_number, log_index FROM (
         (SELECT block_number, log_index FROM token_transfers WHERE from_address = $1 ORDER BY block_number DESC, log_index DESC LIMIT $2::int + $3::int)
         UNION
         (SELECT block_number, log_index FROM token_transfers WHERE to_address = $1 ORDER BY block_number DESC, log_index DESC LIMIT $2::int + $3::int)
       ) u ORDER BY block_number DESC, log_index DESC LIMIT $2 OFFSET $3)
     ORDER BY x.block_number DESC, x.log_index DESC`,
    [address, limit, offset],
  )).rows;
}

export async function addressTokens(q: Queryable, address: string) {
  return (await q.query<{ token: string; balance: string; name: string | null; symbol: string | null; decimals: number | null; kind: "erc20" | "erc721" }>(
    `SELECT b.token, b.balance::text AS balance, t.name, t.symbol, t.decimals, t.kind FROM token_balances b JOIN tokens t ON t.address = b.token
     WHERE b.holder = $1 AND b.balance > 0 ORDER BY t.symbol NULLS LAST, b.token LIMIT 200`,
    [address],
  )).rows;
}

/** The transaction that created a contract, if LONGYU Scan has indexed it. */
export async function creation(q: Queryable, address: string) {
  return (await q.query<{ hash: string; from_address: string; block_number: bigint }>(
    "SELECT hash, from_address, block_number FROM transactions WHERE contract_address = $1 LIMIT 1",
    [address],
  )).rows[0] ?? null;
}

/** A token with its holders and its transfers, each counted up to COUNT_CAP. */
export async function token(q: Queryable, address: string): Promise<TokenRow | null> {
  return (await q.query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM tokens t WHERE t.address = $1`, [address])).rows[0] ?? null;
}

export async function tokens(q: Queryable, limit: number, offset = 0): Promise<TokenRow[]> {
  return (await q.query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM tokens t ORDER BY holders DESC, t.first_block ASC LIMIT $1 OFFSET $2`, [limit, offset])).rows;
}

export async function tokenTransfers(q: Queryable, address: string, limit: number, offset = 0): Promise<TransferRow[]> {
  return (await q.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM token_transfers x JOIN tokens t ON t.address = x.token
     WHERE x.token = $1 ORDER BY x.block_number DESC, x.log_index DESC LIMIT $2 OFFSET $3`,
    [address, limit, offset],
  )).rows;
}

export async function tokenHolders(q: Queryable, address: string, limit: number, offset = 0) {
  return (await q.query<{ holder: string; balance: string }>(
    "SELECT holder, balance::text AS balance FROM token_balances WHERE token = $1 AND balance > 0 ORDER BY balance DESC, holder LIMIT $2 OFFSET $3",
    [address, limit, offset],
  )).rows;
}

/** Deposits from BSC: deposit transactions (type 126). The per-block system deposit is never indexed. */
export async function deposits(q: Queryable, limit: number, offset = 0): Promise<TxListRow[]> {
  return (await q.query<TxListRow>(
    `SELECT ${TX_LIST_COLUMNS} FROM transactions WHERE type = 126 ORDER BY block_number DESC, tx_index DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  )).rows;
}

/**
 * The bridge's own record of the token each of these deposits brought, for those that brought one
 * (decode.ts reads it). Only the bridge emits at its address, so no deposit can claim a token.
 */
export async function depositTokenLogs(q: Queryable, hashes: string[]) {
  if (!hashes.length) return [];
  return (await q.query<LogRow & { tx_hash: string }>(
    `SELECT DISTINCT ON (tx_hash) tx_hash, ${logColumns()} FROM logs
     WHERE tx_hash = ANY($1) AND address = $2 AND topic0 = $3 ORDER BY tx_hash, log_index`,
    [hashes, L2_BRIDGE, ERC20_BRIDGE_FINALIZED_TOPIC],
  )).rows;
}

/** Withdrawals to BSC: MessagePassed events of the message passer predeploy. */
export async function withdrawals(q: Queryable, limit: number, offset = 0) {
  return (await q.query<LogRow & { tx_hash: string; block_number: bigint; timestamp: bigint }>(
    `SELECT l.block_number, l.tx_hash, ${logColumns("l.")}, b.timestamp
     FROM logs l JOIN blocks b ON b.number = l.block_number
     WHERE l.address = $1 AND l.topic0 = $2 ORDER BY l.block_number DESC, l.log_index DESC LIMIT $3 OFFSET $4`,
    [MESSAGE_PASSER, MESSAGE_PASSED_TOPIC, limit, offset],
  )).rows;
}

/**
 * Etherscan's txlist: an account's transactions in a block range, oldest or newest first, each
 * with its calldata up to DATA_BYTES bytes.
 */
export async function accountTxList(q: Queryable, address: string, start: bigint, end: bigint, asc: boolean, limit: number, offset: number) {
  return (await q.query<TxRow & { block_hash: string }>(
    `SELECT ${txListColumns("t.")}, ${firstBytes("t.input")} AS input, b.hash AS block_hash FROM transactions t JOIN blocks b ON b.number = t.block_number
     WHERE (t.from_address = $1 OR t.to_address = $1 OR t.contract_address = $1) AND t.block_number BETWEEN $2 AND $3
     ORDER BY t.block_number ${asc ? "ASC" : "DESC"}, t.tx_index ${asc ? "ASC" : "DESC"} LIMIT $4 OFFSET $5`,
    [address, start, end, limit, offset],
  )).rows;
}

/** Etherscan's tokentx: transfers by account and/or token in a block range. */
export async function accountTokenTx(q: Queryable, f: { address?: string; token?: string }, start: bigint, end: bigint, asc: boolean, limit: number, offset: number) {
  const where = ["x.block_number BETWEEN $1 AND $2"];
  const params: unknown[] = [start, end];
  if (f.address) {
    params.push(f.address);
    where.push(`(x.from_address = $${params.length} OR x.to_address = $${params.length})`);
  }
  if (f.token) {
    params.push(f.token);
    where.push(`x.token = $${params.length}`);
  }
  params.push(limit, offset);
  return (await q.query<TransferRow>(
    `SELECT ${TRANSFER_COLUMNS} FROM token_transfers x JOIN tokens t ON t.address = x.token WHERE ${where.join(" AND ")}
     ORDER BY x.block_number ${asc ? "ASC" : "DESC"}, x.log_index ${asc ? "ASC" : "DESC"} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )).rows;
}

export async function tokenBalance(q: Queryable, token: string, holder: string): Promise<string> {
  return (await q.query<{ balance: string }>("SELECT balance::text AS balance FROM token_balances WHERE token = $1 AND holder = $2", [token, holder])).rows[0]?.balance ?? "0";
}

export async function tokensByAddress(q: Queryable, addresses: string[]): Promise<Map<string, { decimals: number | null; symbol: string | null }>> {
  if (!addresses.length) return new Map();
  const rows = (await q.query<{ address: string; decimals: number | null; symbol: string | null }>(
    "SELECT address, decimals, symbol FROM tokens WHERE address = ANY($1) AND kind = 'erc20'",
    [addresses],
  )).rows;
  return new Map(rows.map((r) => [r.address, { decimals: r.decimals, symbol: r.symbol }]));
}

export async function searchTokens(q: Queryable, text: string, limit = 10) {
  const like = `${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return (await q.query<{ address: string; name: string | null; symbol: string | null }>(
    "SELECT address, name, symbol FROM tokens WHERE lower(symbol) LIKE $1 OR lower(name) LIKE $1 ORDER BY first_block LIMIT $2",
    [like, limit],
  )).rows;
}

/** A contract whose source was published and matched (verify/). */
export interface VerifiedRow {
  address: string;
  name: string;
  file: string;
  compiler: string;
  optimizer: boolean;
  runs: bigint | null;
  evm_version: string | null;
  match_kind: "full" | "partial";
  creation_checked: boolean;
  constructor_args: string | null;
  abi: string;
  input: string;
  code_hash: string;
  verified_at: bigint;
}

export async function verified(q: Queryable, address: string): Promise<VerifiedRow | null> {
  return (await q.query<VerifiedRow>("SELECT * FROM verified_contracts WHERE address = $1", [address])).rows[0] ?? null;
}

/** What a verification may replace: nothing at all, or a partial match when it is a full one. Returns whether the row was written. */
export async function saveVerified(q: Queryable, v: VerifiedRow): Promise<boolean> {
  const written = await q.query<{ address: string }>(
    `INSERT INTO verified_contracts (address, name, file, compiler, optimizer, runs, evm_version, match_kind, creation_checked, constructor_args, abi, input, code_hash, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, file = EXCLUDED.file, compiler = EXCLUDED.compiler, optimizer = EXCLUDED.optimizer, runs = EXCLUDED.runs,
       evm_version = EXCLUDED.evm_version, match_kind = EXCLUDED.match_kind, creation_checked = EXCLUDED.creation_checked, constructor_args = EXCLUDED.constructor_args,
       abi = EXCLUDED.abi, input = EXCLUDED.input, code_hash = EXCLUDED.code_hash, verified_at = EXCLUDED.verified_at
     WHERE verified_contracts.code_hash <> EXCLUDED.code_hash OR (verified_contracts.match_kind = 'partial' AND EXCLUDED.match_kind = 'full')
     RETURNING address`,
    [v.address, v.name, v.file, v.compiler, v.optimizer, v.runs === null ? null : v.runs.toString(), v.evm_version, v.match_kind, v.creation_checked, v.constructor_args, v.abi, v.input, v.code_hash, v.verified_at.toString()],
  );
  return written.rows.length === 1;
}

/** Bytes of source and ABI taken in since a time (seconds), for the limit on what a day may add. */
export async function verifiedBytesSince(q: Queryable, since: bigint): Promise<bigint> {
  const row = (await q.query<{ bytes: bigint | string }>("SELECT COALESCE(SUM(OCTET_LENGTH(input) + OCTET_LENGTH(abi)), 0) AS bytes FROM verified_contracts WHERE verified_at >= $1", [since.toString()])).rows[0];
  return BigInt(row?.bytes ?? 0);
}

export { MESSAGE_PASSER, TRANSFER_TOPIC };
