import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../../packages/database/dist/index.js";

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;
export const rootPool = testDatabaseUrl ? createDatabase(testDatabaseUrl, 30) : undefined;

export async function prepareDatabase(stock = 100) {
  if (!rootPool) throw new Error("TEST_DATABASE_URL is required");
  const path = fileURLToPath(new URL("../../packages/database/migrations/0001_init.sql", import.meta.url));
  await rootPool.pool.query(await readFile(path, "utf8"));
  await resetDatabase(stock);
}

export async function resetDatabase(stock = 100) {
  if (!rootPool) throw new Error("TEST_DATABASE_URL is required");
  await rootPool.pool.query("TRUNCATE processed_events, outbox_events, idempotency_records, orders CASCADE");
  await rootPool.pool.query("DELETE FROM products");
  await rootPool.pool.query("INSERT INTO products(id, name, sku, available_stock) VALUES ('iphone_16', 'iPhone 16', 'IPHONE-16', $1)", [stock]);
}
