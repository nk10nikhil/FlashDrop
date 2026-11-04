import { createClient } from "redis";
import type { FastifyBaseLogger } from "fastify";
import { redisAvailable } from "./metrics.js";

export class ProductCache {
  private client?: ReturnType<typeof createClient>;
  constructor(private readonly url: string | undefined, private readonly log: FastifyBaseLogger) {}

  private async timed<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Redis command timed out")), 250); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async start() {
    if (!this.url) return;
    const client = createClient({ url: this.url, disableOfflineQueue: true, socket: {
      connectTimeout: 1000,
      reconnectStrategy: (retries) => Math.min(5000, 250 * 2 ** Math.min(retries, 5)),
    } });
    client.on("error", (error) => this.log.warn({ err: error }, "Redis unavailable; database fallback remains active"));
    client.on("ready", () => redisAvailable.set(1));
    client.on("end", () => redisAvailable.set(0));
    this.client = client as unknown as ReturnType<typeof createClient>;
    void client.connect().catch((error) => this.log.warn({ err: error }, "Redis initial connection failed; using PostgreSQL directly"));
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      if (!this.client?.isReady) return null;
      const value = await this.timed(this.client.get(key));
      return value ? JSON.parse(value) as T : null;
    } catch (error) { this.log.debug({ err: error }, "Redis read failed"); return null; }
  }

  async set(key: string, value: unknown, ttlSeconds = 3) {
    try { if (this.client?.isReady) await this.timed(this.client.set(key, JSON.stringify(value), { EX: ttlSeconds })); }
    catch (error) { this.log.debug({ err: error }, "Redis write failed"); }
  }

  async invalidateProduct(productId: string) {
    try { if (this.client?.isReady) await this.timed(this.client.del("product:" + productId)); }
    catch (error) { this.log.warn({ err: error, productId }, "Redis invalidation failed; short TTL bounds stale product reads"); }
  }

  async close() {
    if (this.client?.isOpen) { try { await this.client.quit(); } catch { this.client.disconnect(); } }
  }
}
