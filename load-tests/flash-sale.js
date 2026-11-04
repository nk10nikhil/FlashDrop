import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const baseUrl = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const productId = __ENV.PRODUCT_ID || "iphone_16";
const initialStock = Number(__ENV.INITIAL_STOCK || 100);
const virtualUsers = Number(__ENV.VUS || 10000);
const expectedAccepted = Math.min(virtualUsers, initialStock);
const expectedRejected = Math.max(0, virtualUsers - initialStock);
const acceptedOrders = new Counter("flashdrop_order_accepted");
const stockRejections = new Counter("flashdrop_stock_rejected");
const badResponses = new Counter("flashdrop_bad_responses");
const duplicateRequests = new Counter("flashdrop_duplicate_requests");
const finalInventory = new Trend("flashdrop_final_inventory");

export const options = {
  scenarios: {
    flash_sale: {
      executor: "per-vu-iterations",
      vus: virtualUsers,
      iterations: 1,
      maxDuration: __ENV.MAX_DURATION || "2m",
    },
  },
  thresholds: {
    flashdrop_order_accepted: ["count==" + expectedAccepted],
    flashdrop_stock_rejected: ["count==" + expectedRejected],
    flashdrop_bad_responses: ["count==0"],
    flashdrop_duplicate_requests: ["count==0"],
    flashdrop_final_inventory: ["max==" + (initialStock - expectedAccepted)],
  },
};

export function setup() {
  const response = http.get(baseUrl + "/products/" + encodeURIComponent(productId));
  if (response.status !== 200) throw new Error("Product lookup failed; verify API and seed data");
  const product = response.json();
  if (product.availableStock !== initialStock) {
    throw new Error("Expected initial stock " + initialStock + " but found " + product.availableStock + ". Reset the local demo product before this run.");
  }
  return { runId: String(Date.now()) };
}

export default function (data) {
  const vu = __VU;
  const response = http.post(baseUrl + "/orders", JSON.stringify({
    userId: "load-user-" + vu,
    productId,
    quantity: 1,
    idempotencyKey: "flash-sale-" + data.runId + "-" + vu,
  }), {
    headers: { "Content-Type": "application/json", "X-Request-Id": "k6-" + data.runId + "-" + vu },
    tags: { scenario: "flash_sale" },
  });

  let body;
  try { body = response.json(); } catch { body = undefined; }
  if (response.status === 202 && body?.status === "PENDING") {
    acceptedOrders.add(1);
  } else if (response.status === 409 && body?.error?.code === "INSUFFICIENT_STOCK") {
    stockRejections.add(1);
  } else if (response.status === 202 && body?.error?.code === "IDEMPOTENCY_KEY_REUSED") {
    duplicateRequests.add(1);
  } else {
    badResponses.add(1);
  }
  check(response, { "accepted or rejected for insufficient stock": (r) => r.status === 202 || (r.status === 409 && body?.error?.code === "INSUFFICIENT_STOCK") });
}

export function teardown() {
  const response = http.get(baseUrl + "/products/" + encodeURIComponent(productId));
  if (response.status !== 200) {
    finalInventory.add(-1);
    return;
  }
  finalInventory.add(Number(response.json().availableStock));
}

export function handleSummary(data) {
  const metrics = data.metrics;
  const value = (name, key) => metrics[name]?.values?.[key] ?? null;
  const accepted = value("flashdrop_order_accepted", "count") ?? 0;
  const report = {
    totalRequests: value("http_reqs", "count"),
    successfulOrders: accepted,
    rejectedOrders: value("flashdrop_stock_rejected", "count") ?? 0,
    duplicateRequests: value("flashdrop_duplicate_requests", "count") ?? 0,
    errorCount: value("flashdrop_bad_responses", "count") ?? 0,
    expectedAcceptedOrders: expectedAccepted,
    expectedStockRejections: expectedRejected,
    responseLatencyMs: {
      p50: value("http_req_duration", "p(50)"),
      p95: value("http_req_duration", "p(95)"),
      p99: value("http_req_duration", "p(99)"),
    },
    throughputRequestsPerSecond: value("http_reqs", "rate"),
    finalInventory: value("flashdrop_final_inventory", "max"),
    oversellingCount: Math.max(0, accepted - initialStock),
    environment: {
      virtualUsers,
      initialStock,
      baseUrl,
      runDurationMs: data.state?.testRunDurationMs ?? null,
    },
  };
  const content = JSON.stringify(report, null, 2) + "\n";
  return { stdout: content, "load-tests/results/flash-sale-report.json": content };
}
