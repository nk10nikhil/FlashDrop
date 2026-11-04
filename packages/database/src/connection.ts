import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;
export function createDatabase(databaseUrl = process.env.DATABASE_URL, max = Number(process.env.DATABASE_POOL_MAX ?? 20)) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "flashdrop",
    ...(process.env.NODE_ENV === "production" ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  pool.on("error", (err) => console.error(JSON.stringify({ level: "error", msg: "unexpected postgres pool error", error: err.message })));
  return { pool, db: drizzle(pool, { schema }) };
}
export type Database = ReturnType<typeof createDatabase>;
