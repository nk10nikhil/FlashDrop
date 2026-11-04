import { z } from "zod";

export const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const createOrderSchema = z.object({
  userId: identifierSchema,
  productId: identifierSchema,
  quantity: z.number().int().positive().max(1000),
  idempotencyKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderCreatedSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal("OrderCreated"),
  orderId: z.string().uuid(),
  userId: identifierSchema,
  productId: identifierSchema,
  quantity: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  correlationId: z.string().min(1).max(128),
}).strict();
export type OrderCreated = z.infer<typeof orderCreatedSchema>;

export type OrderAccepted = { orderId: string; status: "PENDING" };
export type ApiErrorBody = { error: { code: string; message: string; requestId: string } };

export class AppError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEventError";
  }
}

export function requestHash(input: CreateOrderInput): string {
  // Deliberately hash normalized semantic fields, not JSON key order or headers.
  return JSON.stringify({ productId: input.productId, quantity: input.quantity });
}

export function backoffMs(attempt: number, base = 500, cap = 60_000): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp * (0.75 + Math.random() * 0.5));
}
