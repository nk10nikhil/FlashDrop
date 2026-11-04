import { pgTable, text, uuid, integer, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sku: text("sku").notNull().unique(),
  availableStock: integer("available_stock").notNull(),
  reservedStock: integer("reserved_stock").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("products_available_stock_nonnegative", sql`${t.availableStock} >= 0`), check("products_reserved_stock_nonnegative", sql`${t.reservedStock} >= 0`)]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  productId: text("product_id").notNull().references(() => products.id),
  quantity: integer("quantity").notNull(),
  status: text("status").notNull(),
  totalAmount: integer("total_amount"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("orders_user_idem_unique").on(t.userId, t.idempotencyKey),
  index("orders_product_created_idx").on(t.productId, t.createdAt),
  check("orders_quantity_positive", sql`${t.quantity} > 0`),
  check("orders_status_allowed", sql`${t.status} IN ('PENDING', 'CONFIRMED', 'FAILED')`),
]);

export const idempotencyRecords = pgTable("idempotency_records", {
  userId: text("user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("idempotency_user_key_unique").on(t.userId, t.idempotencyKey), uniqueIndex("idempotency_order_unique").on(t.orderId)]);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  aggregateId: uuid("aggregate_id").notNull().references(() => orders.id),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"),
  leasedUntil: timestamp("leased_until", { withTimezone: true }),
  lastError: text("last_error"),
}, (t) => [index("outbox_pending_idx").on(t.nextAttemptAt, t.createdAt), check("outbox_attempts_nonnegative", sql`${t.attempts} >= 0`)]);

export const processedEvents = pgTable("processed_events", {
  eventId: uuid("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("processed_events_at_idx").on(t.processedAt)]);
