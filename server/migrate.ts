import { readFile } from "node:fs/promises";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = await pool.connect();
try {
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(701918)");
  await db.query(
    await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
  );
  await db.query("COMMIT");
} finally {
  db.release();
  await pool.end();
}
