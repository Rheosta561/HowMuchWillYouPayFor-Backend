import type { Request, Response, NextFunction } from "express";
import { AuthService } from "./auth.service.js";
import type { AuthProvider, RequestMeta } from "./auth.types.js";
import {
  AccountSuspendedError,
  AuthError,
  EmailNotVerifiedError,
  GoogleVerificationError,
  OtpExpiredError,
  OtpInvalidError,
  OtpRateLimitedError,
} from "./auth.errors.js";
import { EmailOtpStrategy } from "./strategies/email-otp.strategy.js";
import { deliverAuthResult, resolveTokenDeliveryPolicy, type TokenDeliveryPolicy } from "./token-delivery.js";

function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip, userAgent: req.get("user-agent") ?? undefined };
}

function requireEmailOtpStrategy(authService: AuthService): EmailOtpStrategy {
  const strategy = authService.getStrategy("email-otp");
  if (!(strategy instanceof EmailOtpStrategy)) throw new AuthError("Email OTP unavailable");
  return strategy;
}

/** Generic verify failure: same status/body for unknown, wrong, or expired codes. */
function sendGenericVerifyFailure(res: Response): void {
  res.status(401).json({
    code: "INVALID_OR_EXPIRED_CODE",
    message: "Invalid or expired code",
  });
}

/** Thin controller: validation happens in routes, logic in strategies/services. */
export function createAuthController(authService: AuthService, opts: { tokenDelivery?: TokenDeliveryPolicy } = {}) {
  const policy = () => opts.tokenDelivery ?? resolveTokenDeliveryPolicy();

  async function signup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const provider = (req.body as { provider: AuthProvider }).provider;
      const result = await authService.signup(provider, req.body.payload ?? {}, requestMeta(req));
      deliverAuthResult(res, result, policy());
    } catch (err) {
      next(err);
    }
  }

  async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const provider = (req.body as { provider: AuthProvider }).provider;
      const result = await authService.login(provider, req.body.payload ?? {}, requestMeta(req));
      deliverAuthResult(res, result, policy());
    } catch (err) {
      next(err);
    }
  }

  async function requestEmailOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const strategy = requireEmailOtpStrategy(authService);
      const { email, purpose } = req.body as { email: string; purpose: "signup" | "login" };
      await strategy.requestOtp(email, purpose);
      // Generic response: identical whether or not the email is registered.
      res.status(200).json({
        message: "If this email address can receive mail, a sign-in code has been sent.",
      });
    } catch (err) {
      next(err);
    }
  }

  async function verifyEmailOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const strategy = requireEmailOtpStrategy(authService);
      const { email, code } = req.body as { email: string; code: string };
      const meta = requestMeta(req);
      // Explicit login vs signup selection. Both verify the OTP first and
      // create the user only after verification; the branch is safe under
      // races because creation is idempotent on unique indexes.
      const exists = await strategy.userExists(email);
      const payload = { email, code };
      const result = exists
        ? await strategy.login(payload, meta)
        : await strategy.signup(payload, meta);
      deliverAuthResult(res, result, policy());
    } catch (err) {
      if (err instanceof OtpInvalidError || err instanceof OtpExpiredError) {
        sendGenericVerifyFailure(res);
        return;
      }
      if (err instanceof OtpRateLimitedError) {
        res.status(429).json({ code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Please try again later." });
        return;
      }
      if (err instanceof AccountSuspendedError) {
        res.status(403).json({ code: "ACCOUNT_UNAVAILABLE", message: "Account is unavailable." });
        return;
      }
      next(err);
    }
  }

  async function googleAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { idToken } = req.body as { idToken: string };
      const result = await authService.login("google", { idToken }, requestMeta(req));
      deliverAuthResult(res, result, policy());
    } catch (err) {
      // Safe handling: verification internals (expiry, audience, signature)
      // never leak to the client; all failures share one generic shape.
      if (err instanceof GoogleVerificationError) {
        res.status(401).json({ code: "GOOGLE_AUTH_FAILED", message: "Google authentication failed." });
        return;
      }
      if (err instanceof EmailNotVerifiedError) {
        res.status(403).json({ code: "EMAIL_NOT_VERIFIED", message: "Email ownership is not verified." });
        return;
      }
      if (err instanceof AccountSuspendedError) {
        res.status(403).json({ code: "ACCOUNT_UNAVAILABLE", message: "Account is unavailable." });
        return;
      }
      next(err);
    }
  }

  return { signup, login, requestEmailOtp, verifyEmailOtp, googleAuth };
}
