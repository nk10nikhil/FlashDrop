import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, leaseOutboxBatch, markOutboxPublished, processOrderEvent } from "../../packages/database/dist/index.js";
import { orderCreatedSchema } from "../../packages/shared/dist/index.js";
import { buildServer } from "../../apps/api/src/server.js";
import { prepareDatabase, resetDatabase, rootPool, testDatabaseUrl } from "../helpers/database.js";

const suite = testDatabaseUrl ? describe : describe.skip;

suite("durability and at-least-once failure scenarios", () => {
  const { db, pool } = testDatabaseUrl ? createDatabase(testDatabaseUrl, 10) : { db: undefined as never, pool: undefined as never };
  let server: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    await prepareDatabase();
    server = await buildServer({ databaseUrl: testDatabaseUrl, redisUrl: "redis://127.0.0.1:6399" });
  });
  afterAll(async () => { await server?.close(); await pool?.end(); await rootPool?.pool.end(); });

  it("accepts requests while broker delivery is unavailable because the outbox is durable", async () => {
    const response = await server.inject({ method: "POST", url: "/orders", payload: { userId: "outage-user", productId: "iphone_16", quantity: 1, idempotencyKey: "broker-outage" } });
    expect(response.statusCode).toBe(202);
    const row = await pool.query("SELECT published_at, payload FROM outbox_events WHERE aggregate_id=$1", [response.json().orderId]);
    expect(row.rows[0].published_at).toBeNull();
    expect(row.rows[0].payload.eventType).toBe("OrderCreated");
  });

  it("handles duplicate delivery and worker crash after commit before acknowledgement", async () => {
    const response = await server.inject({ method: "POST", url: "/orders", payload: { userId: "worker-user", productId: "iphone_16", quantity: 1, idempotencyKey: "worker-replay" } });
    const event = (await pool.query("SELECT payload FROM outbox_events WHERE aggregate_id=$1", [response.json().orderId])).rows[0].payload;
    expect(await processOrderEvent(db, event)).toEqual({ duplicate: false });
    // Simulates a process dying after DB commit but before Kafka offset commit.
    expect(await processOrderEvent(db, event)).toEqual({ duplicate: true });
    const status = await pool.query("SELECT status FROM orders WHERE id=$1", [event.orderId]);
    const count = await pool.query("SELECT count(*)::int AS count FROM processed_events WHERE event_id=$1", [event.eventId]);
    expect(status.rows[0].status).toBe("CONFIRMED");
    expect(count.rows[0].count).toBe(1);
  });

  it("replays an outbox publication after publisher crash, while worker deduplication stays safe", async () => {
    const response = await server.inject({ method: "POST", url: "/orders", payload: { userId: "publisher-user", productId: "iphone_16", quantity: 1, idempotencyKey: "publisher-crash" } });
    const firstLease = await leaseOutboxBatch(db, 10, 5);
    const event = firstLease.events.find((item) => item.payload.orderId === response.json().orderId)!.payload;
    await processOrderEvent(db, event);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const secondLease = await leaseOutboxBatch(db, 10, 1000);
    expect(secondLease.events.some((item) => item.payload.orderId === event.orderId)).toBe(true);
    expect(await processOrderEvent(db, event)).toEqual({ duplicate: true });
    await markOutboxPublished(db, event.eventId, secondLease.leaseToken);
  });

  it("returns a committed order on retry after the first response is lost", async () => {
    const payload = { userId: "client-retry", productId: "iphone_16", quantity: 1, idempotencyKey: "lost-response" };
    // The first call reaches commit; dropping its HTTP response is equivalent to an API
    // process crash between commit and write to the client socket.
    const committed = await server.inject({ method: "POST", url: "/orders", payload });
    const retry = await server.inject({ method: "POST", url: "/orders", payload });
    expect(retry.json()).toEqual(committed.json());
    const count = await pool.query("SELECT count(*)::int AS count FROM orders WHERE user_id='client-retry'");
    expect(count.rows[0].count).toBe(1);
  });

  it("rejects invalid event payloads at the shared contract boundary", async () => {
    const malformed = { eventId: "not-a-uuid", eventType: "OrderCreated" };
    expect(orderCreatedSchema.safeParse(malformed).success).toBe(false);
  });

  it("does not record an outbox event as published unless the lease token matches", async () => {
    await resetDatabase();
    const response = await server.inject({ method: "POST", url: "/orders", payload: { userId: "lease-user", productId: "iphone_16", quantity: 1, idempotencyKey: "wrong-lease" } });
    const claim = await leaseOutboxBatch(db, 1, 1000);
    const event = claim.events.find((item) => item.payload.orderId === response.json().orderId)!;
    await markOutboxPublished(db, event.id, "00000000-0000-0000-0000-000000000000");
    const status = await pool.query("SELECT published_at FROM outbox_events WHERE id=$1", [event.id]);
    expect(status.rows[0].published_at).toBeNull();
  });

  it("leases different outbox rows to concurrent publisher connections", async () => {
    await resetDatabase();
    for (let index = 0; index < 4; index++) {
      const response = await server.inject({ method: "POST", url: "/orders", payload: { userId: "publisher-" + index, productId: "iphone_16", quantity: 1, idempotencyKey: "lease-batch-" + index } });
      expect(response.statusCode).toBe(202);
    }
    const [publisherA, publisherB] = await Promise.all([
      leaseOutboxBatch(db, 2, 1000),
      leaseOutboxBatch(rootPool!.db, 2, 1000),
    ]);
    const ids = [...publisherA.events, ...publisherB.events].map((event) => event.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});
