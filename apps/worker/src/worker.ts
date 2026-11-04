import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Kafka, logLevel, type Consumer, type Producer } from "kafkajs";
import { generateAuthToken } from "aws-msk-iam-sasl-signer-js";
import pino from "pino";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import { orderCreatedSchema, backoffMs, PermanentEventError } from "@flashdrop/shared";
import { createDatabase, leaseOutboxBatch, markOutboxPublished, processOrderEvent, retryOutbox } from "@flashdrop/database";
import { runShutdownSequence } from "./lifecycle.js";

const env = {
  databaseUrl: process.env.DATABASE_URL,
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",").map((part) => part.trim()),
  clientId: process.env.KAFKA_CLIENT_ID ?? "flashdrop-worker",
  groupId: process.env.KAFKA_GROUP_ID ?? "flashdrop-orders-v1",
  topic: process.env.KAFKA_TOPIC_ORDERS ?? "orders.created.v1",
  dlqTopic: process.env.KAFKA_TOPIC_DLQ ?? "orders.created.dlq.v1",
  pollMs: Number(process.env.OUTBOX_POLL_MS ?? 500),
  batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
  leaseMs: Number(process.env.OUTBOX_LEASE_MS ?? 30_000),
  retryMs: Number(process.env.WORKER_RETRY_MS ?? 1000),
  metricsPort: Number(process.env.METRICS_PORT ?? 9464),
  dbMaxRetries: Number(process.env.WORKER_DB_MAX_RETRIES ?? 6),
  logLevel: process.env.LOG_LEVEL ?? "info",
};
if (!env.databaseUrl) throw new Error("DATABASE_URL is required");
if (!Number.isSafeInteger(env.dbMaxRetries) || env.dbMaxRetries < 1) throw new Error("WORKER_DB_MAX_RETRIES must be a positive integer");
const kafkaAuthMode = process.env.KAFKA_AUTH_MODE ?? "none";
if (kafkaAuthMode !== "none" && kafkaAuthMode !== "iam") throw new Error("KAFKA_AUTH_MODE must be none or iam");
if (kafkaAuthMode === "iam" && process.env.KAFKA_TLS !== "true") throw new Error("KAFKA_TLS=true is required for MSK IAM authentication");

const log = pino({ level: env.logLevel, redact: ["authorization", "password", "token"] });
const { db, pool } = createDatabase(env.databaseUrl);
const kafka = new Kafka({
  clientId: env.clientId, brokers: env.brokers,
  ...(process.env.KAFKA_TLS === "true" ? { ssl: true } : {}),
  ...(kafkaAuthMode === "iam" ? { sasl: {
    mechanism: "oauthbearer" as const,
    oauthBearerProvider: async () => ({ value: (await generateAuthToken({ region: process.env.AWS_REGION ?? "us-east-1" })).token }),
  } } : {}),
  logLevel: logLevel.ERROR,
  logCreator: () => ({ namespace, level, label, log: entry }) => {
    const logger = level <= logLevel.ERROR ? log.error.bind(log) : log.warn.bind(log);
    logger({ namespace, label, kafka: entry }, "Kafka client log");
  },
});
const producer: Producer = kafka.producer({ idempotent: true, maxInFlightRequests: 5, allowAutoTopicCreation: true });
const consumer: Consumer = kafka.consumer({ groupId: env.groupId, allowAutoTopicCreation: true, retry: { initialRetryTime: 300, retries: 10 } });
const admin = kafka.admin();

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "flashdrop_worker_" });
const processedEvents = new Counter({ name: "flashdrop_worker_events_processed_total", help: "Events processed", registers: [registry] });
const duplicateEvents = new Counter({ name: "flashdrop_worker_duplicate_events_total", help: "Duplicate events safely ignored", registers: [registry] });
const deadLettered = new Counter({ name: "flashdrop_worker_dead_lettered_total", help: "Invalid events sent to the DLQ", registers: [registry] });
const processingTime = new Histogram({ name: "flashdrop_worker_processing_seconds", help: "Event processing duration", buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2], registers: [registry] });
const outboxErrors = new Counter({ name: "flashdrop_outbox_publish_errors_total", help: "Outbox publication failures", registers: [registry] });
const outboxBacklog = new Gauge({ name: "flashdrop_outbox_pending", help: "Unpublished outbox events", registers: [registry] });
const consumerLag = new Gauge({ name: "flashdrop_kafka_consumer_lag", help: "Estimated Kafka messages behind the consumer group", registers: [registry] });
let shuttingDown = false;
const shutdownController = new AbortController();
let producerReady = false;
let consumerReady = false;
consumer.on(consumer.events.CONNECT, () => { consumerReady = true; });
consumer.on(consumer.events.DISCONNECT, () => { consumerReady = false; });
consumer.on(consumer.events.CRASH, ({ payload }) => { consumerReady = false; log.error({ err: payload.error }, "Kafka consumer crashed; KafkaJS will retry according to its policy"); });
producer.on(producer.events.CONNECT, () => { producerReady = true; });
producer.on(producer.events.DISCONNECT, () => { producerReady = false; });

function startMetricsServer() {
  const server = createServer(async (request, response) => {
    if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" })); return; }
    if (request.url === "/ready") {
      try {
        await pool.query("SELECT 1");
        const ready = producerReady && consumerReady && !shuttingDown;
        response.writeHead(ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ status: ready ? "ready" : "not_ready", postgres: "ok", broker: ready ? "ok" : "unavailable" }));
      } catch {
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ status: "not_ready", postgres: "unavailable" }));
      }
      return;
    }
    if (request.url !== "/metrics") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": registry.contentType }).end(await registry.metrics());
  });
  server.listen(env.metricsPort, "0.0.0.0", () => log.info({ port: env.metricsPort }, "Worker metrics endpoint listening"));
  return server;
}

async function publishOutbox() {
  while (!shuttingDown) {
    try {
      const { leaseToken, events } = await leaseOutboxBatch(db, env.batchSize, env.leaseMs);
      for (const event of events) {
        try {
          await producer.send({ topic: env.topic, acks: -1, messages: [{ key: event.payload.orderId, value: JSON.stringify(event.payload), headers: { eventId: event.id, correlationId: event.payload.correlationId } }] });
          await markOutboxPublished(db, event.id, leaseToken);
          log.info({ eventId: event.id, orderId: event.payload.orderId, attempts: event.attempts }, "Outbox event published");
        } catch (error) {
          outboxErrors.inc();
          const delayMs = backoffMs(event.attempts, 500, 5 * 60_000);
          await retryOutbox(db, event.id, leaseToken, delayMs, error instanceof Error ? error.message : String(error));
          log.error({ err: error, eventId: event.id, retryInMs: delayMs }, "Outbox publication failed; event retained for retry");
        }
      }
    } catch (error) {
      log.error({ err: error }, "Outbox poll failed");
    }
    try { await delay(env.pollMs, undefined, { signal: shutdownController.signal }); } catch { /* normal shutdown */ }
  }
}

async function commitMessage(topic: string, partition: number, offset: string) {
  await consumer.commitOffsets([{ topic, partition, offset: (BigInt(offset) + 1n).toString() }]);
}

async function sendToDeadLetter(topic: string, partition: number, offset: string, value: unknown) {
  await producer.send({ topic: env.dlqTopic, acks: -1, messages: [{
    key: topic + ":" + partition + ":" + offset,
    value: JSON.stringify({ sourceTopic: topic, sourcePartition: partition, sourceOffset: offset, value }),
  }] });
  await commitMessage(topic, partition, offset);
  deadLettered.inc();
}

async function processWithRetry(event: import("@flashdrop/shared").OrderCreated) {
  for (let attempt = 1; attempt <= env.dbMaxRetries; attempt++) {
    try { return await processOrderEvent(db, event); }
    catch (error) {
      if (error instanceof PermanentEventError) throw error;
      if (shuttingDown || attempt === env.dbMaxRetries) throw error;
      const retryInMs = backoffMs(attempt, env.retryMs, 30_000);
      log.warn({ err: error, eventId: event.eventId, attempt, retryInMs }, "Transient worker processing error; retrying without acknowledging Kafka");
      await delay(retryInMs, undefined, { signal: shutdownController.signal });
    }
  }
  throw new Error("Worker retry loop exhausted");
}

async function handleMessage(message: { value: Buffer | null; key: Buffer | null; offset: string }, topic: string, partition: number) {
  const started = process.hrtime.bigint();
  const raw = message.value?.toString("utf8") ?? "";
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { value = undefined; }
  const parsed = orderCreatedSchema.safeParse(value);
  if (!parsed.success) {
    // Dead-letter first; acknowledge the source offset only after Kafka confirms the DLQ write.
    await sendToDeadLetter(topic, partition, message.offset, { raw, error: "Invalid OrderCreated event" });
    log.error({ topic, partition, offset: message.offset }, "Invalid event sent to dead-letter topic");
    return;
  }

  let result: Awaited<ReturnType<typeof processOrderEvent>>;
  try { result = await processWithRetry(parsed.data); }
  catch (error) {
    if (!(error instanceof PermanentEventError)) throw error;
    await sendToDeadLetter(topic, partition, message.offset, { event: parsed.data, error: error.message });
    log.error({ topic, partition, offset: message.offset, eventId: parsed.data.eventId, correlationId: parsed.data.correlationId }, "Permanent event error sent to dead-letter topic");
    return;
  }
  // The consumer offset is committed only after the DB transaction succeeds.
  await commitMessage(topic, partition, message.offset);
  if (result.duplicate) duplicateEvents.inc(); else processedEvents.inc();
  processingTime.observe(Number(process.hrtime.bigint() - started) / 1e9);
  log.info({ eventId: parsed.data.eventId, orderId: parsed.data.orderId, correlationId: parsed.data.correlationId, duplicate: result.duplicate }, "Order event handled");
}

async function startConsumer() {
  let attempt = 0;
  while (!shuttingDown) {
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: env.topic, fromBeginning: false });
      consumerReady = true;
      await consumer.run({ autoCommit: false, eachMessage: async ({ topic, partition, message }) => handleMessage(message, topic, partition) });
      return;
    } catch (error) {
      if (shuttingDown) return;
      consumerReady = false;
      attempt++;
      log.error({ err: error }, "Kafka consumer setup failed; retrying");
      try { await consumer.disconnect(); } catch { /* reconnect in next pass */ }
      try { await delay(backoffMs(attempt, env.retryMs, 30_000), undefined, { signal: shutdownController.signal }); } catch { /* shutdown timer */ }
    }
  }
}

async function updateOutboxGauge() {
  try {
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox_events WHERE published_at IS NULL");
    outboxBacklog.set(Number(result.rows[0]?.count ?? 0));
  } catch (error) { log.warn({ err: error }, "Unable to update outbox backlog metric"); }
}

async function updateConsumerLag() {
  try {
    const [topicOffsets, groupOffsets] = await Promise.all([
      admin.fetchTopicOffsets(env.topic),
      admin.fetchOffsets({ groupId: env.groupId, topics: [env.topic], resolveOffsets: true }),
    ]);
    const highWater = new Map(topicOffsets.map((partition) => [partition.partition, Number(partition.high)]));
    let totalLag = 0;
    for (const topic of groupOffsets) {
      for (const partition of topic.partitions) {
        const high = highWater.get(partition.partition) ?? 0;
        const committed = Number(partition.offset);
        totalLag += committed < 0 ? high : Math.max(0, high - committed);
      }
    }
    consumerLag.set(totalLag);
  } catch (error) { log.debug({ err: error }, "Unable to update Kafka consumer lag metric"); }
}

async function main() {
  const metricsServer = startMetricsServer();
  let producerAttempts = 0;
  while (!shuttingDown && !producerReady) {
    try { await producer.connect(); producerReady = true; }
    catch (error) { producerAttempts++; log.error({ err: error }, "Kafka producer connect failed; retrying"); await delay(backoffMs(producerAttempts, env.retryMs, 30_000), undefined, { signal: shutdownController.signal }); }
  }
  if (shuttingDown) return;
  const outboxTask = publishOutbox();
  const consumerTask = startConsumer();
  const gaugeTimer = setInterval(() => { void updateOutboxGauge(); void updateConsumerLag(); }, 10_000);
  try { await admin.connect(); await updateConsumerLag(); } catch (error) { log.warn({ err: error }, "Kafka admin metrics unavailable"); }
  await updateOutboxGauge();
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort();
    log.info({ signal }, "Stopping worker; in-flight DB work will finish before offsets are committed");
    clearInterval(gaugeTimer);
    await runShutdownSequence([
      { name: "consumer stop", run: () => consumer.stop() },
      { name: "background task drain", run: async () => { await Promise.allSettled([outboxTask, consumerTask]); } },
      { name: "Kafka admin disconnect", run: () => admin.disconnect() },
      { name: "consumer disconnect", run: () => consumer.disconnect() },
      { name: "producer disconnect", run: () => producer.disconnect() },
      { name: "metrics endpoint close", run: () => new Promise<void>((resolve, reject) => metricsServer.close((error) => error ? reject(error) : resolve())) },
      { name: "database pool close", run: () => pool.end() },
    ], (name, error) => log.warn({ err: error, step: name }, "Worker shutdown step failed; continuing cleanup"));
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => { log.fatal({ err: error }, "Worker failed to start"); process.exitCode = 1; });
