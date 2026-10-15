import { normalizeEmail } from "../../users/user.model.js";
import type { UserService } from "../../users/user.service.js";
import type { AuthProvider, AuthResult, RequestMeta, SafeUser, StrategyInput } from "../auth.types.js";
import { AccountSuspendedError, OtpInvalidError } from "../auth.errors.js";
import type { AuthenticationStrategy } from "./authentication-strategy.js";
import type { TokenService } from "../services/token.service.js";
import type { SessionService } from "../services/session.service.js";
import type { OtpService } from "../services/otp.service.js";
import type { EmailSender } from "../services/email.service.js";
import { env } from "../../../config/env.js";

export interface EmailOtpDeps {
  users: UserService;
  tokens: TokenService;
  sessions: SessionService;
  otp: OtpService;
  email: EmailSender;
  otpTtlMinutes?: number;
}

export function toSafeUser(doc: { id: string; email: string; role: SafeUser["role"]; status: SafeUser["status"] }): SafeUser {
  return { id: doc.id, email: doc.email, role: doc.role, status: doc.status };
}

export class EmailOtpStrategy implements AuthenticationStrategy {
  readonly provider: AuthProvider = "email-otp";

  constructor(private readonly deps: EmailOtpDeps) {}

  /**
   * Provider-specific step 1: issue an OTP challenge and deliver the code.
   * The caller always receives the same outcome shape; whether a user
   * exists for the email is checked internally for audit only and never
   * influences the response, so the endpoint cannot be used to enumerate
   * registered addresses. No account is created here.
   */
  async requestOtp(email: string, purpose: "signup" | "login" = "login"): Promise<{ expiresAt: Date }> {
    const normalized = normalizeEmail(email);
    // Internal existence check only (audit/observability hook). The result
    // is intentionally unused so the response stays generic.
    await this.deps.users.findByEmail(normalized);
    const { expiresAt, code } = await this.deps.otp.requestChallenge(email, {
      purpose,
      returnCode: true,
    });
    const ttl = this.deps.otpTtlMinutes ?? env.OTP_TTL_MINUTES;
    if (code) {
      await this.deps.email.sendOtp({ to: normalized, code, expiresInMinutes: ttl });
    }
    return { expiresAt };
  }

  /** Internal existence probe. Used by the controller to select the
   * explicit login vs signup path; never exposed in API responses. */
  async userExists(email: string): Promise<boolean> {
    const found = await this.deps.users.findByEmail(normalizeEmail(email));
    return found !== null;
  }

  /**
   * Provider-specific step 2: verify OTP and return a full AuthResult.
   * The user is created only after successful verification, and the
   * session is issued only after the user record is resolved.
   */
  async verifyOtp(email: string, code: string, meta: RequestMeta = {}): Promise<AuthResult> {
    if (!code || !code.trim()) throw new OtpInvalidError("Invalid or expired code");
    await this.deps.otp.verifyChallenge(email, code);
    const normalized = normalizeEmail(email);

    const { user, isNewUser } = await this.deps.users.findOrCreateForVerifiedIdentity({
      provider: "email-otp",
      providerUserId: normalized,
      email: email.trim(),
      emailVerified: true, // proven by successful OTP challenge
    });

    if (user.status !== "active") throw new AccountSuspendedError();

    const accessToken = this.deps.tokens.issueAccessToken(user.id, user.role);
    const { refreshToken, expiresAt } = await this.deps.sessions.createSession({
      userId: user.id,
      provider: this.provider,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      user: toSafeUser(user),
      accessToken,
      refreshToken,
      refreshExpiresAt: expiresAt,
      isNewUser,
    };
  }

  // Shared interface: signup/login both complete via verified OTP code.
  // The controller selects which one to call based on prior existence so
  // semantics stay explicit; both are safe under concurrent use.
  async signup(input: StrategyInput, meta?: RequestMeta): Promise<AuthResult> {
    const { email, code } = this.parseEmailCode(input);
    return this.verifyOtp(email, code, meta);
  }

  async login(input: StrategyInput, meta?: RequestMeta): Promise<AuthResult> {
    const { email, code } = this.parseEmailCode(input);
    return this.verifyOtp(email, code, meta);
  }

  private parseEmailCode(input: StrategyInput): { email: string; code: string } {
    const email = typeof input.email === "string" ? input.email : "";
    const code = typeof input.code === "string" ? input.code : "";
    if (!email || !code) throw new OtpInvalidError("Invalid or expired code");
    return { email, code };
  }
}
