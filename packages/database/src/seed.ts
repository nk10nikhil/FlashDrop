import { sql } from "drizzle-orm";
import { createDatabase } from "./connection.js";

const { db, pool } = createDatabase();
const stock = Number(process.env.PRODUCT_INITIAL_STOCK ?? 100);
if (!Number.isSafeInteger(stock) || stock < 0) throw new Error("PRODUCT_INITIAL_STOCK must be a non-negative integer");
try {
  await db.execute(sql`INSERT INTO products (id, name, sku, available_stock)
    VALUES ('iphone_16', 'iPhone 16', 'IPHONE-16', ${stock})
    ON CONFLICT (id) DO NOTHING`);
  console.info("Seeded iphone_16 with stock " + stock);
} finally {
  await pool.end();
}
