import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prepareDatabase, resetDatabase, rootPool, testDatabaseUrl } from "../helpers/database.js";

const suite = testDatabaseUrl ? describe : describe.skip;
const children: ChildProcess[] = [];

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startApi(port: number) {
  const child = spawn(process.execPath, ["apps/api/dist/server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl!, DATABASE_POOL_MAX: "5", PORT: String(port), HOST: "127.0.0.1", REDIS_URL: "", NODE_ENV: "test", AUTH_MODE: "development" },
    stdio: "ignore",
  });
  children.push(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("API process exited before becoming ready");
    try { if ((await fetch("http://127.0.0.1:" + port + "/ready", { signal: AbortSignal.timeout(500) })).ok) return child; }
    catch { await delay(200); }
  }
  throw new Error("API process did not become ready");
}

suite("cross-process inventory concurrency", () => {
  let ports: number[];
  beforeAll(async () => {
    await prepareDatabase(1);
    ports = [await freePort(), await freePort()];
    await Promise.all(ports.map(startApi));
  });
  beforeEach(async () => resetDatabase(1));
  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await rootPool?.pool.end();
  });

  it("two API processes cannot oversell the last item", async () => {
    const requests = ports.map((port, index) => fetch("http://127.0.0.1:" + port + "/orders", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "buyer-" + index, productId: "iphone_16", quantity: 1, idempotencyKey: "last-item-" + index }),
    }));
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const database = await rootPool!.pool.query("SELECT available_stock FROM products WHERE id='iphone_16'");
    const orders = await rootPool!.pool.query("SELECT count(*)::int AS count FROM orders");
    expect(database.rows[0].available_stock).toBe(0);
    expect(orders.rows[0].count).toBe(1);
  });

  it("simultaneous same-key requests on separate API processes return the same order", async () => {
    const payload = { userId: "same-buyer", productId: "iphone_16", quantity: 1, idempotencyKey: "shared-request-key" };
    const responses = await Promise.all(ports.map((port) => fetch("http://127.0.0.1:" + port + "/orders", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    })));
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    const stock = await rootPool!.pool.query("SELECT available_stock FROM products WHERE id='iphone_16'");
    const orders = await rootPool!.pool.query("SELECT count(*)::int AS count FROM orders");
    expect(stock.rows[0].available_stock).toBe(0);
    expect(orders.rows[0].count).toBe(1);
  });
});
