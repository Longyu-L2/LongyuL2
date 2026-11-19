import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

/** Minimal query surface shared by node-postgres and PGlite. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /**
   * The same database for reads made on a visitor's behalf: the server cancels a statement that
   * runs longer than `timeoutMs`. Absent where nothing can cancel one (PGlite).
   */
  timed?(timeoutMs: number): Queryable;
}

const INT8 = 20;

/**
 * Postgres via node-postgres. BIGINT columns come back as bigint; NUMERIC stays a string. The
 * `timed` side has connections of its own, each opened with the time limit as a setting of its
 * session: the indexer's statements have no limit, and visitors' slow ones cannot take its
 * connections.
 */
export function createPgDb(url: string): Db {
  const options = {
    connectionString: url,
    max: 10,
    types: {
      getTypeParser: ((oid: number, format?: string) =>
        oid === INT8 ? (v: string) => BigInt(v) : pg.types.getTypeParser(oid, format as "text")) as never,
    },
  };
  const pool = new pg.Pool(options);
  const timed = new Map<number, pg.Pool>();
  return {
    query: (sql, params) => pool.query(sql, params) as never,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (s, p) => client.query(s, p) as never });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    timed(timeoutMs) {
      const limited = timed.get(timeoutMs) ?? new pg.Pool({ ...options, statement_timeout: timeoutMs });
      timed.set(timeoutMs, limited);
      return { query: (sql, params) => limited.query(sql, params) as never };
    },
    async close() {
      await Promise.all([pool, ...timed.values()].map((p) => p.end()));
    },
  };
}

/** In-process Postgres (WASM) for development and tests. */
export async function createPgliteDb(dir?: string): Promise<Db> {
  const db = await PGlite.create({ dataDir: dir, parsers: { [INT8]: (v: string) => BigInt(v) } });
  return {
    query: (sql, params) => db.query(sql, params) as never,
    tx: (fn) => db.transaction((t) => fn({ query: (s, p) => t.query(s, p) as never })),
    close: () => db.close(),
  };
}

/**
 * Makes sure the explorer's own database exists on the server in `serverUrl` and returns a URL
 * for it. Its tables never mix with the API's, and it can be dropped and re-indexed on its own.
 */
export async function ensureDatabase(serverUrl: string, name: string): Promise<string> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("invalid database name");
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    // The name is validated above; identifiers cannot be bound as parameters.
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const MIGRATIONS = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Applies every migration in order, once. Safe to run on every start. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(MIGRATIONS + file, "utf8");
    await db.tx(async (q) => {
      for (const statement of splitSql(sql)) await q.query(statement);
      await q.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}

/** Splits on semicolons at line ends, ignoring comment lines. Migrations contain no functions. */
function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
