import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../../config/env.js";
import { CsrfError } from "./auth.errors.js";

export function issueCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function timingSafeEqualText(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Double-submit CSRF check for cookie-authenticated requests.
 * The CSRF cookie is readable by browser JS; the refresh cookie is not.
 * The client echoes the CSRF value in the configured header on every
 * cookie-based state-changing request. Non-browser clients using body
 * tokens skip this entirely (no ambient credentials, nothing to forge).
 */
export function csrfTokenMatches(req: Request): boolean {
  const headerName = env.AUTH_CSRF_HEADER.toLowerCase();
  const header = req.get(headerName) ?? "";
  const cookie = req.cookies?.[env.AUTH_CSRF_COOKIE_NAME] ?? "";
  if (typeof header !== "string" || typeof cookie !== "string") return false;
  return timingSafeEqualText(header, cookie);
}

/** Enforce CSRF only when the credential arrived via cookie. */
export function requireCsrfWhenCookie(req: Request, _res: Response, next: NextFunction): void {
  if (!csrfTokenMatches(req)) {
    next(new CsrfError());
    return;
  }
  next();
}
