import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  REDIS_URL: z.string().optional(),
  AUTH_MODE: z.enum(["development", "jwt"]).default("development"),
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_ISSUER: z.string().url().optional(),
  AUTH_AUDIENCE: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.string().default("info"),
});

export function loadConfig(env = process.env) {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && config.AUTH_MODE !== "jwt") throw new Error("Production requires AUTH_MODE=jwt");
  if (config.AUTH_MODE === "jwt" && (!config.AUTH_JWKS_URL || !config.AUTH_ISSUER || !config.AUTH_AUDIENCE)) {
    throw new Error("JWT mode requires AUTH_JWKS_URL, AUTH_ISSUER and AUTH_AUDIENCE");
  }
  return config;
}
