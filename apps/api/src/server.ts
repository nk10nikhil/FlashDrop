import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { AppError, createOrderSchema, identifierSchema } from "@flashdrop/shared";
import { createDatabase, createOrder, getOrder, getProduct } from "@flashdrop/database";
import { loadConfig } from "./config.js";
import { authenticatedUser } from "./auth.js";
import { ProductCache } from "./cache.js";
import { acceptedOrders, dbPoolIdle, dbPoolTotal, dbPoolWaiting, httpDuration, httpRequests, idempotencyHits, registry, stockRejections, transactionFailures } from "./metrics.js";

export async function buildServer(options: { databaseUrl?: string; authMode?: "development" | "jwt"; redisUrl?: string } = {}): Promise<FastifyInstance> {
  const config = loadConfig({ ...process.env, ...(options.databaseUrl ? { DATABASE_URL: options.databaseUrl } : {}), ...(options.authMode ? { AUTH_MODE: options.authMode } : {}), ...(options.redisUrl ? { REDIS_URL: options.redisUrl } : {}) });
  const { db, pool } = createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX);
  const server = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie"] },
    bodyLimit: 16 * 1024,
    trustProxy: config.NODE_ENV === "production",
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      return typeof incoming === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    },
  });
  const cache = new ProductCache(config.REDIS_URL, server.log);
  await cache.start();

  await server.register(helmet);
  await server.register(cors, { origin: process.env.CORS_ORIGINS?.split(",").map((value) => value.trim()) ?? false });
  await server.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW_MS, allowList: (request) => ["/health", "/ready", "/metrics"].includes(request.url) });

  server.addHook("onRequest", async (request, reply) => { reply.header("x-request-id", request.id); });

  server.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unknown";
    httpRequests.labels(request.method, route, String(reply.statusCode)).inc();
    httpDuration.labels(request.method, route).observe(reply.elapsedTime / 1000);
    dbPoolTotal.set(pool.totalCount);
    dbPoolIdle.set(pool.idleCount);
    dbPoolWaiting.set(pool.waitingCount);
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, requestId: request.id } });
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", requestId: request.id } });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) return reply.code(413).send({ error: { code: "REQUEST_TOO_LARGE", message: "Request body exceeds the 16 KiB limit", requestId: request.id } });
    if (statusCode === 429) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests", requestId: request.id } });
    if (statusCode === 400) return reply.code(400).send({ error: { code: "INVALID_REQUEST", message: "The request could not be parsed", requestId: request.id } });
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "An internal error occurred", requestId: request.id } });
  });

  server.get("/health", async () => ({ status: "ok" }));
  server.get("/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready", dependencies: { postgres: "ok", redis: "optional" } };
    } catch {
      return reply.code(503).send({ status: "not_ready", dependencies: { postgres: "unavailable" } });
    }
  });
  server.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });

  server.post<{ Body: unknown }>("/orders", async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Request body does not match the order schema");
    const userId = await authenticatedUser(request, config, parsed.data.userId);
    try {
      const result = await createOrder(db, { ...parsed.data, userId }, request.id);
      if (result.replayed) idempotencyHits.inc(); else acceptedOrders.inc();
      void cache.invalidateProduct(parsed.data.productId);
      request.log.info({ orderId: result.body.orderId, idempotencyReplay: result.replayed }, "Order request accepted");
      reply.header("x-idempotency-replayed", String(result.replayed));
      return reply.code(202).send(result.body);
    } catch (error) {
      if (error instanceof AppError && error.code === "INSUFFICIENT_STOCK") stockRejections.inc();
      if (!(error instanceof AppError)) transactionFailures.inc();
      throw error;
    }
  });

  server.get<{ Params: { orderId: string } }>("/orders/:orderId", async (request) => {
    const parsed = identifierSchema.safeParse(request.params.orderId);
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid order identifier");
    const userId = await authenticatedUser(request, config);
    const order = await getOrder(db, parsed.data, userId);
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order was not found");
    return { ...order, createdAt: order.createdAt.toISOString() };
  });

  server.get<{ Params: { productId: string } }>("/products/:productId", async (request) => {
    const parsed = identifierSchema.safeParse(request.params.productId);
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid product identifier");
    const key = "product:" + parsed.data;
    const cached = await cache.get<{ productId: string; name: string; sku: string; availableStock: number; updatedAt: string }>(key);
    if (cached) return cached;
    const product = await getProduct(db, parsed.data);
    if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product was not found");
    const body = { ...product, updatedAt: product.updatedAt.toISOString() };
    await cache.set(key, body);
    return body;
  });

  server.addHook("onClose", async () => { await cache.close(); await pool.end(); });
  return server;
}

async function main() {
  const server = await buildServer();
  const config = loadConfig();
  await server.listen({ port: config.PORT, host: config.HOST });
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, "Shutting down API");
    await server.close();
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
