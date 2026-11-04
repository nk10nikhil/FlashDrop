import { createDatabase } from "@flashdrop/database";

if (process.env.NODE_ENV === "production") throw new Error("Demo reset is disabled in production");
if (process.env.FLASHDROP_ALLOW_RESET !== "true") throw new Error("Set FLASHDROP_ALLOW_RESET=true to authorize deletion of demo orders and events");
const initialStock = Number(process.env.PRODUCT_INITIAL_STOCK ?? 100);
if (!Number.isSafeInteger(initialStock) || initialStock < 0) throw new Error("PRODUCT_INITIAL_STOCK must be a non-negative integer");

const { pool } = createDatabase();
try {
  await pool.query("BEGIN");
  try {
    await pool.query("TRUNCATE processed_events, outbox_events, idempotency_records, orders CASCADE");
    await pool.query("DELETE FROM products");
    await pool.query("INSERT INTO products(id, name, sku, available_stock) VALUES ('iphone_16', 'iPhone 16', 'IPHONE-16', $1)", [initialStock]);
    await pool.query("COMMIT");
  } catch (error) { await pool.query("ROLLBACK"); throw error; }
  console.info("Reset local demo data; iphone_16 stock is " + initialStock);
} finally { await pool.end(); }
