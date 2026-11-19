import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

/** Minimal query surface shared by node-postgres and PGlite. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const INT8 = 20;

/** Postgres via node-postgres. BIGINT columns come back as bigint; NUMERIC stays a string. */
export function createPgDb(url: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 20,
    types: {
      getTypeParser: ((oid: number, format?: string) =>
        oid === INT8 ? (v: string) => BigInt(v) : pg.types.getTypeParser(oid, format as "text")) as never,
    },
  });
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
    close: () => pool.end(),
  };
}

/** In-process Postgres (WASM) for development and tests. */
export async function createPgliteDb(dir?: string): Promise<Db> {
  // Options must be the only argument: PGlite ignores parsers passed after a data directory.
  const db = await PGlite.create({ dataDir: dir, parsers: { [INT8]: (v: string) => BigInt(v) } });
  return {
    query: (sql, params) => db.query(sql, params) as never,
    tx: (fn) => db.transaction((t) => fn({ query: (s, p) => t.query(s, p) as never })),
    close: () => db.close(),
  };
}
