import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../packages/database/dist/index.js";
import { buildServer } from "../../apps/api/src/server.js";
import { prepareDatabase, resetDatabase, rootPool, testDatabaseUrl } from "../helpers/database.js";

const suite = testDatabaseUrl ? describe : describe.skip;

suite("order API and PostgreSQL integration", () => {
  const database = testDatabaseUrl ? createDatabase(testDatabaseUrl, 20) : undefined;
  let server: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    await prepareDatabase();
    server = await buildServer({ databaseUrl: testDatabaseUrl, redisUrl: "redis://127.0.0.1:6399" });
  });
  afterEach(async () => resetDatabase());
  afterAll(async () => { await server?.close(); await database?.pool.end(); await rootPool?.pool.end(); });

  it("creates an order atomically and returns it to its authenticated owner", async () => {
    const response = await server.inject({ method: "POST", url: "/orders", payload: { userId: "user_123", productId: "iphone_16", quantity: 2, idempotencyKey: "create-1" } });
    expect(response.statusCode).toBe(202);
    expect(response.headers["x-request-id"]).toBeTruthy();
    const accepted = response.json();
    const order = await server.inject({ method: "GET", url: "/orders/" + accepted.orderId, headers: { "x-demo-user-id": "user_123" } });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ userId: "user_123", productId: "iphone_16", quantity: 2, status: "PENDING" });
    const result = await database!.pool.query("SELECT available_stock FROM products WHERE id='iphone_16'");
    expect(result.rows[0].available_stock).toBe(98);
    const durable = await database!.pool.query("SELECT count(*)::int AS count FROM outbox_events WHERE published_at IS NULL");
    expect(durable.rows[0].count).toBe(1);
  });

  it("rejects malformed requests, unknown products and insufficient inventory", async () => {
    expect((await server.inject({ method: "POST", url: "/orders", payload: { userId: "x", productId: "iphone_16", quantity: 0, idempotencyKey: "bad" } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: "/orders", payload: { userId: "x", productId: "missing", quantity: 1, idempotencyKey: "missing" } })).statusCode).toBe(404);
    await resetDatabase(1);
    expect((await server.inject({ method: "POST", url: "/orders", payload: { userId: "x", productId: "iphone_16", quantity: 2, idempotencyKey: "too-many" } })).statusCode).toBe(409);
    const result = await database!.pool.query("SELECT available_stock FROM products WHERE id='iphone_16'");
    expect(result.rows[0].available_stock).toBe(1);
  });

  it("replays the original response and returns 409 when a key is reused for a different payload", async () => {
    const payload = { userId: "u1", productId: "iphone_16", quantity: 1, idempotencyKey: "stable-key" };
    const first = await server.inject({ method: "POST", url: "/orders", payload });
    const replay = await server.inject({ method: "POST", url: "/orders", payload });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers["x-idempotency-replayed"]).toBe("true");
    expect((await server.inject({ method: "POST", url: "/orders", payload: { ...payload, quantity: 2 } })).statusCode).toBe(409);
    const result = await database!.pool.query("SELECT available_stock FROM products WHERE id='iphone_16'");
    expect(result.rows[0].available_stock).toBe(99);
  });

  it("rolls back an idempotency reservation when the order transaction fails", async () => {
    const sameKey = { userId: "u2", productId: "not-here", quantity: 1, idempotencyKey: "rolled-back" };
    expect((await server.inject({ method: "POST", url: "/orders", payload: sameKey })).statusCode).toBe(404);
    await database!.pool.query("INSERT INTO products(id, name, sku, available_stock) VALUES ('not-here', 'Temporary', 'TEMP', 1)");
    expect((await server.inject({ method: "POST", url: "/orders", payload: sameKey })).statusCode).toBe(202);
  });

  it("continues with PostgreSQL when Redis is unavailable", async () => {
    const result = await server.inject({ method: "POST", url: "/orders", payload: { userId: "u3", productId: "iphone_16", quantity: 1, idempotencyKey: "redis-down" } });
    expect(result.statusCode).toBe(202);
    const durable = await database!.pool.query("SELECT count(*)::int AS count FROM outbox_events");
    expect(durable.rows[0].count).toBe(1);
  });

  it("reserves stock independently for different products", async () => {
    await database!.pool.query("INSERT INTO products(id, name, sku, available_stock) VALUES ('ipad_mini', 'iPad mini', 'IPAD-MINI', 1)");
    const responses = await Promise.all([
      server.inject({ method: "POST", url: "/orders", payload: { userId: "multi-a", productId: "iphone_16", quantity: 1, idempotencyKey: "multi-a" } }),
      server.inject({ method: "POST", url: "/orders", payload: { userId: "multi-b", productId: "ipad_mini", quantity: 1, idempotencyKey: "multi-b" } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([202, 202]);
    const stock = await database!.pool.query("SELECT id, available_stock FROM products WHERE id IN ('iphone_16', 'ipad_mini') ORDER BY id");
    expect(stock.rows.map((row) => row.available_stock)).toEqual([0, 99]);
  });
});

describe("database connection failure behavior", () => {
  it("reports not-ready when PostgreSQL cannot be reached", async () => {
    const server = await buildServer({ databaseUrl: "postgres://flashdrop:unused@127.0.0.1:65432/unavailable", redisUrl: "" });
    try {
      const response = await server.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json().status).toBe("not_ready");
    } finally { await server.close(); }
  }, 15_000);
});
