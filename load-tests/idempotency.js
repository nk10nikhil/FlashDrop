import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const baseUrl = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const duplicateReplays = new Counter("flashdrop_idempotency_replays");
const unexpected = new Counter("flashdrop_unexpected_responses");

export const options = {
  scenarios: {
    same_key: { executor: "per-vu-iterations", vus: Number(__ENV.VUS || 100), iterations: 1, maxDuration: "1m" },
  },
  thresholds: { flashdrop_unexpected_responses: ["count==0"] },
};

export function setup() { return { key: "same-key-run-" + Date.now() }; }

export default function (data) {
  const response = http.post(baseUrl + "/orders", JSON.stringify({
    userId: "same-key-customer", productId: __ENV.PRODUCT_ID || "iphone_16", quantity: 1, idempotencyKey: data.key,
  }), { headers: { "Content-Type": "application/json" } });
  if (response.status !== 202) unexpected.add(1);
  else if (response.headers["X-Idempotency-Replayed"] === "true") duplicateReplays.add(1);
  check(response, { "same-key request returned accepted response": (r) => r.status === 202 });
}
