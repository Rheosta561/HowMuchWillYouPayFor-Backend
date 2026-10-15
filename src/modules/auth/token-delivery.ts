import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { issueCsrfToken } from "./csrf.js";
import type { AuthResult } from "./auth.types.js";

export type TokenDeliveryPolicy = "body" | "cookie" | "both";

export function resolveTokenDeliveryPolicy(): TokenDeliveryPolicy {
  return env.AUTH_TOKEN_DELIVERY;
}

function cookieBaseOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: env.AUTH_REFRESH_COOKIE_SAMESITE as "strict" | "lax" | "none",
    path: "/",
    expires,
  };
}

/**
 * Token-delivery policy for auth responses.
 * - "body" (default): access + refresh tokens are returned in the JSON body.
 *   For non-browser clients: store the refresh token in secure app storage
 *   (Keychain/Keystore, never localStorage on shared machines) and submit it
 *   as `{ "refreshToken": "<token>" }` in the POST /v1/auth/refresh body.
 * - "cookie": the refresh token is set as an HttpOnly cookie (invisible to
 *   browser JS) and omitted from the JSON body; the access token stays in
 *   the body. A readable CSRF cookie is set alongside; cookie-based refresh
 *   and logout must echo it in the configured CSRF header.
 * - "both": cookies are set and tokens are also returned in the body.
 */
export function deliverAuthResult(
  res: Response,
  result: AuthResult,
  policy: TokenDeliveryPolicy = resolveTokenDeliveryPolicy(),
): void {
  const status = result.isNewUser ? 201 : 200;
  if (policy === "body") {
    res.status(status).json(result);
    return;
  }
  res.cookie(env.AUTH_REFRESH_COOKIE_NAME, result.refreshToken, cookieBaseOptions(result.refreshExpiresAt));
  res.cookie(env.AUTH_CSRF_COOKIE_NAME, issueCsrfToken(), {
    httpOnly: false,
    secure: env.NODE_ENV === "production",
    sameSite: env.AUTH_REFRESH_COOKIE_SAMESITE as "strict" | "lax" | "none",
    path: "/",
    expires: result.refreshExpiresAt,
  });
  if (policy === "cookie") {
    const { refreshToken: _omitted, ...rest } = result;
    res.status(status).json(rest);
    return;
  }
  res.status(status).json(result);
}

export function clearAuthCookies(res: Response): void {
  const opts = { path: "/" };
  res.clearCookie(env.AUTH_REFRESH_COOKIE_NAME, opts);
  res.clearCookie(env.AUTH_CSRF_COOKIE_NAME, opts);
}

export interface ResolvedRefreshToken {
  token: string | null;
  fromCookie: boolean;
}

/** Body token wins; otherwise the HttpOnly cookie. CSRF applies iff cookie. */
export function readRefreshToken(req: Request): ResolvedRefreshToken {
  const bodyToken = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  if (typeof bodyToken === "string" && bodyToken.length > 0) {
    return { token: bodyToken, fromCookie: false };
  }
  const cookieToken = req.cookies?.[env.AUTH_REFRESH_COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken.length > 0) {
    return { token: cookieToken, fromCookie: true };
  }
  return { token: null, fromCookie: false };
}
