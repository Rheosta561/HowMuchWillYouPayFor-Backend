import crypto from "node:crypto";
import { OtpChallengeModel } from "../models/otp-challenge.model.js";
import { normalizeEmail } from "../../users/user.model.js";
import { env } from "../../../config/env.js";
import { OtpExpiredError, OtpInvalidError, OtpRateLimitedError } from "../auth.errors.js";

export type OtpGenerator = () => string;

export function defaultOtpGenerator(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/** HMAC-SHA256 over salt + normalized email + code. Pepper is server-side. */
export function hashOtp(code: string, emailNormalized: string, salt: string, pepper: string): string {
  return crypto
    .createHmac("sha256", pepper)
    .update(`${salt}:${emailNormalized}:${code}`)
    .digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export interface RequestOtpOptions {
  purpose?: "signup" | "login";
  ttlMinutes?: number;
  maxAttempts?: number;
  resendCooldownSeconds?: number;
  maxRequestsPerHour?: number;
  generateCode?: OtpGenerator;
  pepper?: string;
  /** Test hook: return the plain code instead of sending it via email. */
  returnCode?: boolean;
}

export class OtpService {
  constructor(
    private readonly model: typeof OtpChallengeModel = OtpChallengeModel,
    private readonly defaultTtlMinutes: number = env.OTP_TTL_MINUTES,
    private readonly defaultMaxAttempts: number = env.OTP_MAX_ATTEMPTS,
    private readonly defaultCooldownSeconds: number = env.OTP_RESEND_COOLDOWN_SECONDS,
    private readonly defaultMaxPerHour: number = env.OTP_MAX_REQUESTS_PER_HOUR,
    private readonly pepper: string = env.OTP_HASH_PEPPER,
  ) {}

  async requestChallenge(
    email: string,
    opts: RequestOtpOptions = {},
  ): Promise<{ expiresAt: Date; code?: string }> {
    const emailNormalized = normalizeEmail(email);
    const now = Date.now();
    const cooldownSeconds = opts.resendCooldownSeconds ?? this.defaultCooldownSeconds;
    const maxPerHour = opts.maxRequestsPerHour ?? this.defaultMaxPerHour;

    const latest = await this.model
      .findOne({ emailNormalized })
      .sort({ createdAt: -1 })
      .exec();
    if (latest && now - latest.createdAt.getTime() < cooldownSeconds * 1000) {
      throw new OtpRateLimitedError("Too many requests. Please wait before requesting another code.");
    }

    const hourAgo = new Date(now - 60 * 60 * 1000);
    const recentCount = await this.model
      .countDocuments({ emailNormalized, createdAt: { $gt: hourAgo } })
      .exec();
    if (recentCount >= maxPerHour) {
      throw new OtpRateLimitedError("Too many codes requested. Please try again later.");
    }

    const code = (opts.generateCode ?? defaultOtpGenerator)();
    const salt = crypto.randomBytes(16).toString("hex");
    const ttlMinutes = opts.ttlMinutes ?? this.defaultTtlMinutes;
    const expiresAt = new Date(now + ttlMinutes * 60 * 1000);

    // Invalidate older unconsumed challenges so only the newest code is live.
    await this.model
      .updateMany({ emailNormalized, consumedAt: null }, { $set: { consumedAt: new Date() } })
      .exec();

    await this.model.create({
      email: email.trim(),
      emailNormalized,
      codeHash: hashOtp(code, emailNormalized, salt, opts.pepper ?? this.pepper),
      salt,
      purpose: opts.purpose ?? "login",
      expiresAt,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? this.defaultMaxAttempts,
      consumedAt: null,
    });

    return opts.returnCode ? { expiresAt, code } : { expiresAt };
  }

  /**
   * Verify the latest unconsumed challenge and consume it atomically.
   * The consume is a single conditional update, so concurrent requests
   * cannot redeem the same challenge twice: exactly one wins.
   */
  async verifyChallenge(email: string, code: string): Promise<void> {
    const emailNormalized = normalizeEmail(email);
    const now = new Date();
    const candidate = await this.model
      .findOne({ emailNormalized, consumedAt: null })
      .sort({ createdAt: -1 })
      .exec();

    if (!candidate) throw new OtpInvalidError("Invalid or expired code");
    if (candidate.expiresAt.getTime() < now.getTime()) {
      throw new OtpExpiredError("Invalid or expired code");
    }
    if (candidate.attempts >= candidate.maxAttempts) {
      throw new OtpRateLimitedError();
    }

    const expected = hashOtp(code.trim(), emailNormalized, candidate.salt, this.pepper);
    if (timingSafeEqualHex(expected, candidate.codeHash)) {
      // Atomic single-use consume: only succeeds while still unconsumed.
      const consumed = await this.model
        .findOneAndUpdate(
          { _id: candidate._id, consumedAt: null },
          { $set: { consumedAt: now } },
          { returnDocument: "after" },
        )
        .exec();
      if (consumed) return;
      // Lost the race: another request consumed it first.
      throw new OtpInvalidError("Invalid or expired code");
    }

    // Wrong code: atomically count the attempt for brute-force protection.
    const updated = await this.model
      .findOneAndUpdate(
        { _id: candidate._id, consumedAt: null },
        { $inc: { attempts: 1 } },
        { returnDocument: "after" },
      )
      .exec();
    const attempts = updated?.attempts ?? candidate.attempts + 1;
    if (attempts >= candidate.maxAttempts) throw new OtpRateLimitedError();
    throw new OtpInvalidError("Invalid or expired code");
  }
}
