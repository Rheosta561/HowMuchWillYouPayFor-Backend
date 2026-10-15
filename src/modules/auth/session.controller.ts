import type { Request, Response, NextFunction } from "express";
import { SessionService, hashToken } from "./services/session.service.js";
import { TokenService } from "./services/token.service.js";
import { UserService } from "../users/user.service.js";
import { toSafeUser } from "./strategies/email-otp.strategy.js";
import { InvalidRefreshTokenError, RefreshTokenReuseError } from "./auth.errors.js";
import { csrfTokenMatches } from "./csrf.js";
import {
  clearAuthCookies,
  deliverAuthResult,
  readRefreshToken,
  type TokenDeliveryPolicy,
} from "./token-delivery.js";
import type { AuthResult } from "./auth.types.js";

export interface SessionControllerDeps {
  sessions: SessionService;
  tokens: TokenService;
  users: UserService;
  tokenDelivery?: TokenDeliveryPolicy;
}

function unauthorized(res: Response): void {
  res.status(401).json({ code: "INVALID_REFRESH_TOKEN", message: "Invalid refresh token" });
}

/** Thin controller: rotation/revocation live in SessionService. */
export function createSessionController(deps: SessionControllerDeps) {
  const { sessions, tokens, users } = deps;

  async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, fromCookie } = readRefreshToken(req);
      if (!token) {
        unauthorized(res);
        return;
      }
      if (fromCookie && !csrfTokenMatches(req)) {
        res.status(403).json({ code: "CSRF_INVALID", message: "CSRF validation failed" });
        return;
      }
      let rotated;
      try {
        rotated = await sessions.rotateSession(token, {
          ip: req.ip,
          userAgent: req.get("user-agent") ?? undefined,
          deviceLabel: req.get("x-device-label") ?? undefined,
        });
      } catch (err) {
        if (err instanceof RefreshTokenReuseError) {
          clearAuthCookies(res);
          res.status(401).json({ code: "REFRESH_TOKEN_REUSED", message: "Session revoked for security. Please sign in again." });
          return;
        }
        throw err;
      }
      if (!rotated) {
        unauthorized(res);
        return;
      }
      const user = await users.findById(rotated.userId);
      if (!user || user.status !== "active") {
        unauthorized(res);
        return;
      }
      const accessToken = tokens.issueAccessToken(user.id, user.role);
      const result: AuthResult = {
        user: toSafeUser(user),
        accessToken,
        refreshToken: rotated.refreshToken,
        refreshExpiresAt: rotated.expiresAt,
        isNewUser: false,
      };
      deliverAuthResult(res, result, deps.tokenDelivery);
    } catch (err) {
      next(err);
    }
  }

  async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token, fromCookie } = readRefreshToken(req);
      if (fromCookie && !csrfTokenMatches(req)) {
        res.status(403).json({ code: "CSRF_INVALID", message: "CSRF validation failed" });
        return;
      }
      // Idempotent: unknown tokens still clear cookies and succeed.
      if (token) await sessions.logoutByToken(token);
      clearAuthCookies(res);
      res.status(200).json({ message: "Signed out." });
    } catch (err) {
      next(err);
    }
  }

  async function logoutAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        next(new InvalidRefreshTokenError("Authentication required"));
        return;
      }
      const revoked = await sessions.revokeAllForUser(userId);
      clearAuthCookies(res);
      res.status(200).json({ message: "Signed out everywhere.", revoked });
    } catch (err) {
      next(err);
    }
  }

  async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        next(new InvalidRefreshTokenError("Authentication required"));
        return;
      }
      const { token } = readRefreshToken(req);
      const currentHash = token ? hashToken(token) : undefined;
      const presentedSessions = await sessions.listSessionsForUser(userId, currentHash);
      res.status(200).json({ sessions: presentedSessions });
    } catch (err) {
      next(err);
    }
  }

  async function revokeSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        next(new InvalidRefreshTokenError("Authentication required"));
        return;
      }
      const { sessionId } = req.params as { sessionId: string };
      if (!/^[a-f0-9]{24}$/i.test(sessionId ?? "")) {
        res.status(404).json({ code: "SESSION_NOT_FOUND", message: "Session not found." });
        return;
      }
      // Scoped to the caller's own sessions: other users' ids look identical.
      const outcome = await sessions.revokeSessionForUser(userId, sessionId);
      if (!outcome) {
        res.status(404).json({ code: "SESSION_NOT_FOUND", message: "Session not found." });
        return;
      }
      res.status(200).json({ message: "Session revoked.", revoked: outcome.revoked });
    } catch (err) {
      next(err);
    }
  }

  return { refresh, logout, logoutAll, listSessions, revokeSession };
}
