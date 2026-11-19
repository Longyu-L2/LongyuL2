import { createPgDb, createPgliteDb } from "./index.ts";
import { migrate } from "./migrate.ts";
import { systemClock } from "../lib/util.ts";

const db = process.env.DATABASE_URL ? createPgDb(process.env.DATABASE_URL) : await createPgliteDb(process.env.PGLITE_DIR);
const applied = await migrate(db, systemClock.now());
console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
await db.close();
