import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const apiUrl = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const workerUrl = (__ENV.WORKER_METRICS_URL || "http://localhost:9464").replace(/\/$/, "");
const productId = __ENV.PRODUCT_ID || "iphone_16";
const initialStock = Number(__ENV.INITIAL_STOCK || 20000);
const rate = Number(__ENV.RATE || 500);
const duration = __ENV.DURATION || "30s";
const failed = new Counter("flashdrop_worker_load_bad_responses");

export const options = {
  scenarios: {
    order_stream: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs: Number(__ENV.PREALLOCATED_VUS || 100),
      maxVUs: Number(__ENV.MAX_VUS || 2000),
    },
  },
  thresholds: { flashdrop_worker_load_bad_responses: ["count==0"] },
};

function metric(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp("^" + escaped + "(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$", "m"));
  return match ? Number(match[1]) : 0;
}

export function setup() {
  const productResponse = http.get(apiUrl + "/products/" + encodeURIComponent(productId));
  const apiMetrics = http.get(apiUrl + "/metrics");
  const workerMetrics = http.get(workerUrl + "/metrics");
  if (productResponse.status !== 200 || apiMetrics.status !== 200 || workerMetrics.status !== 200) {
    throw new Error("API, worker metrics, and PostgreSQL must be ready for a worker throughput run");
  }
  if (Number(productResponse.json().availableStock) !== initialStock) {
    throw new Error("Reset the test product to INITIAL_STOCK=" + initialStock + " before running this scenario");
  }
  return {
    baselineAccepted: metric(apiMetrics.body, "flashdrop_orders_accepted_total"),
    baselineProcessed: metric(workerMetrics.body, "flashdrop_worker_events_processed_total"),
  };
}

export default function () {
  const key = "worker-load-" + __VU + "-" + __ITER;
  const response = http.post(apiUrl + "/orders", JSON.stringify({
    userId: "worker-load-user-" + __VU,
    productId,
    quantity: 1,
    idempotencyKey: key,
  }), { headers: { "Content-Type": "application/json" }, tags: { scenario: "order_stream" } });
  if (response.status !== 202) failed.add(1);
  check(response, { "order was accepted": (r) => r.status === 202 });
}

export function teardown(data) {
  const deadline = Date.now() + Number(__ENV.WORKER_DRAIN_TIMEOUT_MS || 120000);
  let processed = data.baselineProcessed;
  let accepted = data.baselineAccepted;
  let lag = null;
  while (Date.now() < deadline && (processed - data.baselineProcessed) < (accepted - data.baselineAccepted)) {
    const response = http.get(workerUrl + "/metrics");
    const apiResponse = http.get(apiUrl + "/metrics");
    if (response.status === 200) {
      processed = metric(response.body, "flashdrop_worker_events_processed_total");
      lag = metric(response.body, "flashdrop_kafka_consumer_lag");
    }
    if (apiResponse.status === 200) accepted = metric(apiResponse.body, "flashdrop_orders_accepted_total");
    sleep(1);
  }
  console.log(JSON.stringify({ acceptedSinceStart: accepted - data.baselineAccepted, processedSinceStart: processed - data.baselineProcessed, remainingConsumerLag: lag }));
}
