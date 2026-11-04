import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError } from "@flashdrop/shared";
import type { loadConfig } from "./config.js";

type Config = ReturnType<typeof loadConfig>;
let remoteKeys: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function authenticatedUser(
  request: FastifyRequest,
  config: Config,
  bodyUserId?: string,
): Promise<string> {
  if (config.AUTH_MODE === "development") {
    const headerUser = request.headers["x-demo-user-id"];
    const userId =
      (Array.isArray(headerUser) ? headerUser[0] : headerUser) ?? bodyUserId;
    if (!userId)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication is required");
    if (bodyUserId && bodyUserId !== userId)
      throw new AppError(
        403,
        "IDENTITY_MISMATCH",
        "Request user does not match authenticated identity",
      );
    return userId;
  }
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer "))
    throw new AppError(401, "UNAUTHENTICATED", "A bearer token is required");
  remoteKeys ??= createRemoteJWKSet(new URL(config.AUTH_JWKS_URL!));
  if (!config.AUTH_ISSUER || !config.AUTH_AUDIENCE) {
    throw new AppError(
      500,
      "AUTH_CONFIG_ERROR",
      "Authentication is misconfigured; issuer and audience must be set",
    );
  }
  try {
    const { payload } = await jwtVerify(authorization.slice(7), remoteKeys, {
      issuer: config.AUTH_ISSUER!,
      audience: config.AUTH_AUDIENCE!,
    });
    if (typeof payload.sub !== "string" || !payload.sub)
      throw new Error("JWT subject is missing");
    if (bodyUserId && bodyUserId !== payload.sub)
      throw new AppError(
        403,
        "IDENTITY_MISMATCH",
        "Request user does not match authenticated identity",
      );
    return payload.sub;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      401,
      "INVALID_TOKEN",
      "Bearer token is invalid or expired",
    );
  }
}
