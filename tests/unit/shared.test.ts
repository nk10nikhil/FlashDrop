import { describe, expect, it } from "vitest";
import { backoffMs, createOrderSchema, requestHash } from "../../packages/shared/dist/index.js";

describe("shared contracts", () => {
  it("accepts the assessment order shape and rejects invalid quantities/extra fields", () => {
    const valid = { userId: "user_123", productId: "iphone_16", quantity: 1, idempotencyKey: "request_abc123" };
    expect(createOrderSchema.parse(valid)).toEqual(valid);
    expect(createOrderSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });

  it("hashes semantic payload and bounds exponential retry delay", () => {
    expect(requestHash({ userId: "u", productId: "p", quantity: 1, idempotencyKey: "a" }))
      .toBe(requestHash({ userId: "u", productId: "p", quantity: 1, idempotencyKey: "b" }));
    expect(backoffMs(20, 500, 1000)).toBeGreaterThanOrEqual(750);
    expect(backoffMs(20, 500, 1000)).toBeLessThanOrEqual(1250);
  });
});
