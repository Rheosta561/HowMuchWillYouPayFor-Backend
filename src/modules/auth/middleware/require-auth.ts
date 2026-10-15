import type { Request, Response, NextFunction } from "express";
import { TokenService } from "../services/token.service.js";
import type { UserService } from "../../users/user.service.js";
import { InvalidTokenError } from "../auth.errors.js";

export interface TrustedIdentity {
  userId: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: TrustedIdentity;
    }
  }
}

export interface RequireAuthOptions {
  tokens?: TokenService;
  users?: UserService;
}

/**
 * Access-token middleware. Verifies signature, expiry, issuer and audience,
 * rejects bad credentials with a consistent 401, and attaches the trusted
 * identity to `req.auth`. The user record is re-checked so suspended or
 * deleted accounts lose API access when their tokens are used. User IDs in
 * bodies or query params are never trusted — handlers must use req.auth.
 */
export function createRequireAuth(opts: RequireAuthOptions = {}) {
  const tokens = opts.tokens ?? new TokenService();
  const users = opts.users;

  return async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const header = req.get("authorization") ?? "";
      const match = /^Bearer (.+)$/.exec(header);
      if (!match) throw new InvalidTokenError();
      let payload;
      try {
        payload = tokens.verifyAccessToken(match[1]!.trim());
      } catch {
        throw new InvalidTokenError();
      }
      if (users) {
        const user = await users.findById(payload.sub);
        if (!user || user.status !== "active") throw new InvalidTokenError();
        req.auth = { userId: user.id, role: user.role };
      } else {
        req.auth = { userId: payload.sub, role: payload.role };
      }
      next();
    } catch (err) {
      next(err instanceof InvalidTokenError ? err : new InvalidTokenError());
    }
  };
}
