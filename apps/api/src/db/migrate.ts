import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "./index.ts";

const DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Applies every migration in order, once. Safe to run on every start. */
export async function migrate(db: Db, now: bigint): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
  );
  const done = new Set(
    (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(DIR + file, "utf8");
    await db.tx(async (q) => {
      for (const statement of splitSql(sql)) await q.query(statement);
      await q.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [file, now]);
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
