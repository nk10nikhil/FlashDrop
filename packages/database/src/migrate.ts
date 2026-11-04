import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./connection.js";

const { pool } = createDatabase();
const client = await pool.connect();
try {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  if (process.env.FLASHDROP_APP_PASSWORD) {
    const passwordResult = await client.query<{ literal: string }>("SELECT quote_literal($1) AS literal", [process.env.FLASHDROP_APP_PASSWORD]);
    const passwordLiteral = passwordResult.rows[0]?.literal;
    if (!passwordLiteral) throw new Error("Unable to safely quote the application database password");
    const existingRole = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'flashdrop_app'");
    await client.query((existingRole.rowCount ? "ALTER ROLE flashdrop_app" : "CREATE ROLE flashdrop_app LOGIN") + " PASSWORD " + passwordLiteral);
    const grantResult = await client.query<{ statement: string }>("SELECT format('GRANT CONNECT ON DATABASE %I TO flashdrop_app', current_database()) AS statement");
    const grantConnect = grantResult.rows[0]?.statement;
    if (!grantConnect) throw new Error("Unable to build the database CONNECT grant");
    await client.query(grantConnect);
    await client.query("GRANT USAGE ON SCHEMA public TO flashdrop_app");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flashdrop_app");
    await client.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flashdrop_app");
  }
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrations) {
    const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (alreadyApplied.rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.info("Applied migration " + file);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  console.info("Database schema is current");
} finally {
  client.release();
  await pool.end();
}
