import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { AppError, PermanentEventError, requestHash, type CreateOrderInput, type OrderAccepted, type OrderCreated } from "@flashdrop/shared";
import type { Database } from "./connection.js";
import { idempotencyRecords, orders, outboxEvents, products } from "./schema.js";

type QueryRows<T> = { rows: T[] };

export async function createOrder(database: Database["db"], input: CreateOrderInput, correlationId: string): Promise<{ body: OrderAccepted; replayed: boolean }> {
  const hash = requestHash(input);
  return database.transaction(async (tx) => {
    // This unique insert is the serialization point for same-key requests. A concurrent
    // insert waits for the first transaction, then either observes its committed row or wins.
    const inserted = await tx.execute(sql`INSERT INTO idempotency_records
      (user_id, idempotency_key, request_hash) VALUES (${input.userId}, ${input.idempotencyKey}, ${hash})
      ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING user_id`);

    if ((inserted as unknown as QueryRows<{ user_id: string }>).rows.length === 0) {
      const [existing] = await tx.select().from(idempotencyRecords).where(and(
        eq(idempotencyRecords.userId, input.userId), eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (!existing) throw new Error("Idempotency conflict row disappeared");
      if (existing.requestHash !== hash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used with a different request");
      if (!existing.responseBody) throw new Error("Committed idempotency record has no response body");
      return { body: existing.responseBody as OrderAccepted, replayed: true };
    }

    // This conditional UPDATE, rather than a read/check/write sequence, is the global
    // inventory correctness boundary across all database connections and API replicas.
    const reservation = await tx.execute(sql`UPDATE products SET
      available_stock = available_stock - ${input.quantity}, updated_at = now()
      WHERE id = ${input.productId} AND available_stock >= ${input.quantity}
      RETURNING id`);
    if ((reservation as unknown as QueryRows<{ id: string }>).rows.length === 0) {
      const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.id, input.productId)).limit(1);
      if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product was not found");
      throw new AppError(409, "INSUFFICIENT_STOCK", "There is not enough available stock");
    }

    const [order] = await tx.insert(orders).values({
      userId: input.userId, productId: input.productId, quantity: input.quantity,
      status: "PENDING", idempotencyKey: input.idempotencyKey, requestHash: hash,
    }).returning({ id: orders.id });
    if (!order) throw new Error("Order insert returned no row");
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    const event: OrderCreated = {
      eventId, eventType: "OrderCreated", orderId: order.id, userId: input.userId,
      productId: input.productId, quantity: input.quantity, occurredAt, correlationId,
    };
    await tx.insert(outboxEvents).values({
      id: eventId, aggregateId: order.id, eventType: event.eventType, payload: event,
    });
    const body: OrderAccepted = { orderId: order.id, status: "PENDING" };
    const updatedIdempotency = await tx.update(idempotencyRecords).set({
      orderId: order.id, responseStatus: 202, responseBody: body,
    }).where(and(
      eq(idempotencyRecords.userId, input.userId), eq(idempotencyRecords.idempotencyKey, input.idempotencyKey),
    )).returning({ userId: idempotencyRecords.userId });
    if (updatedIdempotency.length !== 1) throw new Error("Idempotency response could not be saved");
    return { body, replayed: false };
  });
}

export async function getOrder(database: Database["db"], orderId: string, userId: string) {
  const [order] = await database.select({
    orderId: orders.id, userId: orders.userId, productId: orders.productId,
    quantity: orders.quantity, status: orders.status, createdAt: orders.createdAt,
  }).from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, userId))).limit(1);
  return order ?? null;
}

export async function getProduct(database: Database["db"], productId: string) {
  const [product] = await database.select({
    productId: products.id, name: products.name, sku: products.sku,
    availableStock: products.availableStock, updatedAt: products.updatedAt,
  }).from(products).where(eq(products.id, productId)).limit(1);
  return product ?? null;
}

export async function processOrderEvent(database: Database["db"], event: OrderCreated): Promise<{ duplicate: boolean }> {
  return database.transaction(async (tx) => {
    const inserted = await tx.execute(sql`INSERT INTO processed_events (event_id, event_type)
      VALUES (${event.eventId}, ${event.eventType}) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`);
    if ((inserted as unknown as QueryRows<{ event_id: string }>).rows.length === 0) return { duplicate: true };
    const updated = await tx.update(orders).set({ status: "CONFIRMED", updatedAt: new Date() })
      .where(and(
        eq(orders.id, event.orderId), eq(orders.status, "PENDING"),
        eq(orders.userId, event.userId), eq(orders.productId, event.productId), eq(orders.quantity, event.quantity),
      )).returning({ id: orders.id });
    if (updated.length === 0) {
      const [order] = await tx.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, event.orderId)).limit(1);
      if (!order) throw new PermanentEventError("OrderCreated references an unknown or mismatched order");
    }
    return { duplicate: false };
  });
}

export async function leaseOutboxBatch(database: Database["db"], batchSize: number, leaseMs: number) {
  const leaseToken = randomUUID();
  const result = await database.execute(sql`WITH selected AS (
      SELECT id FROM outbox_events
      WHERE published_at IS NULL AND next_attempt_at <= now()
        AND (leased_until IS NULL OR leased_until < now())
      ORDER BY created_at LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events AS event SET lease_token = ${leaseToken}::uuid,
      leased_until = now() + (${leaseMs}::text || ' milliseconds')::interval,
      attempts = event.attempts + 1
    FROM selected WHERE event.id = selected.id
    RETURNING event.id, event.event_type, event.payload, event.attempts, event.lease_token`);
  return { leaseToken, events: (result as unknown as QueryRows<{ id: string; event_type: string; payload: OrderCreated; attempts: number; lease_token: string }>).rows };
}

export async function markOutboxPublished(database: Database["db"], eventId: string, leaseToken: string) {
  await database.execute(sql`UPDATE outbox_events SET published_at = now(), lease_token = NULL,
    leased_until = NULL, last_error = NULL WHERE id = ${eventId} AND lease_token = ${leaseToken}::uuid AND published_at IS NULL`);
}

export async function retryOutbox(database: Database["db"], eventId: string, leaseToken: string, nextAttemptMs: number, error: string) {
  await database.execute(sql`UPDATE outbox_events SET next_attempt_at = now() + (${nextAttemptMs}::text || ' milliseconds')::interval,
    lease_token = NULL, leased_until = NULL, last_error = ${error.slice(0, 2000)}
    WHERE id = ${eventId} AND lease_token = ${leaseToken}::uuid AND published_at IS NULL`);
}
