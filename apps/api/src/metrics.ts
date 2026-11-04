import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "flashdrop_api_" });
export const httpRequests = new Counter({ name: "flashdrop_http_requests_total", help: "HTTP requests", labelNames: ["method", "route", "status"], registers: [registry] });
export const httpDuration = new Histogram({ name: "flashdrop_http_request_duration_seconds", help: "HTTP request latency", labelNames: ["method", "route"], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers: [registry] });
export const acceptedOrders = new Counter({ name: "flashdrop_orders_accepted_total", help: "Newly accepted orders", registers: [registry] });
export const stockRejections = new Counter({ name: "flashdrop_stock_rejections_total", help: "Insufficient stock rejections", registers: [registry] });
export const idempotencyHits = new Counter({ name: "flashdrop_idempotency_replays_total", help: "Idempotent request replays", registers: [registry] });
export const transactionFailures = new Counter({ name: "flashdrop_transaction_failures_total", help: "Database transaction failures", registers: [registry] });
export const dbPoolTotal = new Gauge({ name: "flashdrop_db_pool_total", help: "Total PostgreSQL pool clients", registers: [registry] });
export const dbPoolIdle = new Gauge({ name: "flashdrop_db_pool_idle", help: "Idle PostgreSQL pool clients", registers: [registry] });
export const dbPoolWaiting = new Gauge({ name: "flashdrop_db_pool_waiting", help: "Requests waiting for a PostgreSQL client", registers: [registry] });
export const redisAvailable = new Gauge({ name: "flashdrop_redis_available", help: "Redis connection availability (zero means PostgreSQL fallback)", registers: [registry] });
