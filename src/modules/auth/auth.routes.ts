import { Router, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { createAuthController } from "./auth.controller.js";
import { createSessionController } from "./session.controller.js";
import { defaultAuthService, type AuthService } from "./auth.service.js";
import {
  genericLoginSchema,
  genericSignupSchema,
  googleAuthSchema,
  refreshSchema,
  requestOtpSchema,
  verifyOtpSchema,
} from "./validators/auth.validators.js";
import { SessionService } from "./services/session.service.js";
import { TokenService } from "./services/token.service.js";
import { UserService } from "../users/user.service.js";
import { createRequireAuth } from "./middleware/require-auth.js";
import { resolveTokenDeliveryPolicy, type TokenDeliveryPolicy } from "./token-delivery.js";
import { env } from "../../config/env.js";

function validate<T>(schema: { parse: (v: unknown) => T }) {
  return (req: { body: unknown }, _res: unknown, next: (err?: unknown) => void) => {
    try {
      // Cookie-based flows may send no JSON body at all.
      (req as { body: unknown }).body = schema.parse((req as { body: unknown }).body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

function tooManyRequests(message = "Too many requests. Please try again later."): RequestHandler {
  return (_req, res) => {
    res.status(429).json({ code: "TOO_MANY_REQUESTS", message });
  };
}

export function ipLimiter(max: number): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: tooManyRequests(),
  });
}

export interface AuthRouterOptions {
  authService?: AuthService;
  sessions?: SessionService;
  tokens?: TokenService;
  users?: UserService;
  tokenDelivery?: TokenDeliveryPolicy;
  /** Per-IP caps (requests per 15 min). Overridable for tests. */
  requestIpMax?: number;
  verifyIpMax?: number;
  googleIpMax?: number;
  refreshIpMax?: number;
  /** Fully custom limiter middleware (tests). */
  requestLimiter?: RequestHandler;
  verifyLimiter?: RequestHandler;
  googleLimiter?: RequestHandler;
  refreshLimiter?: RequestHandler;
}

export function createAuthRouter(opts: AuthRouterOptions = {}): Router {
  const authService = opts.authService ?? defaultAuthService;
  const sessions = opts.sessions ?? new SessionService();
  const tokens = opts.tokens ?? new TokenService();
  const users = opts.users ?? new UserService();
  const tokenDelivery = opts.tokenDelivery ?? resolveTokenDeliveryPolicy();
  const router = Router();
  const controller = createAuthController(authService, { tokenDelivery });
  const sessionController = createSessionController({ sessions, tokens, users, tokenDelivery });
  const requireAuth = createRequireAuth({ tokens, users });

  const requestLimiter =
    opts.requestLimiter ?? ipLimiter(opts.requestIpMax ?? env.OTP_REQUEST_IP_MAX);
  const verifyLimiter =
    opts.verifyLimiter ?? ipLimiter(opts.verifyIpMax ?? env.OTP_VERIFY_IP_MAX);
  const googleLimiter =
    opts.googleLimiter ?? ipLimiter(opts.googleIpMax ?? env.GOOGLE_AUTH_IP_MAX);
  const refreshLimiter =
    opts.refreshLimiter ?? ipLimiter(opts.refreshIpMax ?? env.REFRESH_IP_MAX);

  router.post("/signup", validate(genericSignupSchema), controller.signup);
  router.post("/login", validate(genericLoginSchema), controller.login);

  // Canonical versioned endpoints.
  router.post("/email/otp/request", requestLimiter, validate(requestOtpSchema), controller.requestEmailOtp);
  router.post("/email/otp/verify", verifyLimiter, validate(verifyOtpSchema), controller.verifyEmailOtp);

  // Legacy aliases (pre-v1 paths).
  router.post("/email-otp/request", requestLimiter, validate(requestOtpSchema), controller.requestEmailOtp);
  router.post("/email-otp/verify", verifyLimiter, validate(verifyOtpSchema), controller.verifyEmailOtp);

  router.post("/google", googleLimiter, validate(googleAuthSchema), controller.googleAuth);
  router.post("/google/callback", googleLimiter, validate(googleAuthSchema), controller.googleAuth);

  // Shared session endpoints (used by every strategy).
  router.post("/refresh", refreshLimiter, validate(refreshSchema), sessionController.refresh);
  router.post("/logout", sessionController.logout);
  router.post("/logout-all", requireAuth, sessionController.logoutAll);
  router.get("/sessions", requireAuth, sessionController.listSessions);
  router.delete("/sessions/:sessionId", requireAuth, sessionController.revokeSession);

  return router;
}

export const authRouter = createAuthRouter();
