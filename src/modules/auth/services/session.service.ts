import crypto from "node:crypto";
import { RefreshSessionModel } from "../models/refresh-session.model.js";
import { env } from "../../../config/env.js";
import { RefreshTokenReuseError } from "../auth.errors.js";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateRefreshToken(): string {
  // 256-bit opaque random token (never a JWT).
  return crypto.randomBytes(32).toString("hex");
}

export function generateFamilyId(): string {
  return crypto.randomBytes(16).toString("hex");
}

interface CreateSessionInput {
  userId: string;
  provider: string;
  ip?: string;
  userAgent?: string;
  deviceLabel?: string;
  ttlDays?: number;
}

export interface RotatedSession {
  userId: string;
  refreshToken: string;
  expiresAt: Date;
  sessionId: string;
}

/** Safe session view for list endpoints. Never includes the token hash. */
export interface SessionView {
  id: string;
  provider: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  rotated: boolean;
  current: boolean;
  ip?: string;
  userAgent?: string;
  deviceLabel?: string;
}

export class SessionService {
  constructor(
    private readonly model: typeof RefreshSessionModel = RefreshSessionModel,
    private readonly defaultTtlDays: number = env.REFRESH_TOKEN_TTL_DAYS,
    /** Grace window where a rotated-token retry is a transient 401, not theft. */
    private readonly reuseLeewaySeconds: number = env.REFRESH_REUSE_LEEWAY_SECONDS,
  ) {}

  async createSession(input: CreateSessionInput): Promise<{ refreshToken: string; expiresAt: Date; sessionId: string }> {
    const refreshToken = generateRefreshToken();
    const ttlDays = input.ttlDays ?? this.defaultTtlDays;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    const doc = await this.model.create({
      userId: input.userId,
      tokenHash: hashToken(refreshToken),
      familyId: generateFamilyId(),
      provider: input.provider,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      rotatedFromHash: null,
      replacedByHash: null,
      ip: input.ip,
      userAgent: input.userAgent,
      deviceLabel: input.deviceLabel,
    });
    return { refreshToken, expiresAt, sessionId: String(doc._id) };
  }

  /**
   * Rotate a refresh token. The consume is a single conditional update, so
   * concurrent refreshes with the same token cannot both succeed.
   *
   * Reuse policy: presenting a fully-rotated token (rotation completed
   * outside the leeway window) is treated as theft — the whole token
   * family is revoked and a RefreshTokenReuseError is thrown. A retry
   * inside the leeway window (e.g. a concurrent double-submit whose
   * rotation is still in flight) returns null so the caller gets a plain
   * 401 without punishing the legitimate new token.
   */
  async rotateSession(
    oldRefreshToken: string,
    meta: { ip?: string; userAgent?: string; deviceLabel?: string } = {},
  ): Promise<RotatedSession | null> {
    const now = new Date();
    const oldHash = hashToken(oldRefreshToken);

    const consumed = await this.model
      .findOneAndUpdate(
        { tokenHash: oldHash, revokedAt: null, expiresAt: { $gt: now } },
        { $set: { revokedAt: now, lastUsedAt: now } },
        { returnDocument: "after" },
      )
      .exec();

    if (!consumed) {
      await this.handleFailedRotation(oldHash, now);
      return null;
    }

    const ttlMs = consumed.expiresAt.getTime() - now.getTime();
    const ttlDays = Math.max(1, Math.ceil(ttlMs / (24 * 60 * 60 * 1000)));
    const refreshToken = generateRefreshToken();
    const newHash = hashToken(refreshToken);
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    const created = await this.model.create({
      userId: consumed.userId,
      tokenHash: newHash,
      familyId: consumed.familyId,
      provider: consumed.provider,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      rotatedFromHash: oldHash,
      replacedByHash: null,
      ip: meta.ip ?? consumed.ip,
      userAgent: meta.userAgent ?? consumed.userAgent,
      deviceLabel: meta.deviceLabel ?? consumed.deviceLabel,
    });

    // Link the chain. If this link races a logout/revocation it only
    // records metadata; revocation state is authoritative.
    await this.model.updateOne({ _id: consumed._id }, { $set: { replacedByHash: newHash } }).exec();

    return {
      userId: String(consumed.userId),
      refreshToken,
      expiresAt,
      sessionId: String(created._id),
    };
  }

  private async handleFailedRotation(oldHash: string, now: Date): Promise<void> {
    const prev = await this.model.findOne({ tokenHash: oldHash }).exec();
    if (!prev || !prev.revokedAt || !prev.replacedByHash) return; // unknown/expired/plain-revoked: plain 401
    const ageSeconds = (now.getTime() - prev.revokedAt.getTime()) / 1000;
    if (ageSeconds <= this.reuseLeewaySeconds) return; // in-flight race: transient 401, no punishment
    await this.revokeFamily(String(prev.familyId));
    throw new RefreshTokenReuseError();
  }

  /** Revoke every live session in a rotation family. Returns revoked count. */
  async revokeFamily(familyId: string): Promise<number> {
    const res = await this.model
      .updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } })
      .exec();
    return res.modifiedCount;
  }

  /**
   * Logout: revoke the token's whole rotation family so descendants created
   * by an in-flight refresh are ended too. Idempotent for unknown tokens.
   */
  async logoutByToken(refreshToken: string): Promise<{ userId: string | null; revoked: number }> {
    const doc = await this.model.findOne({ tokenHash: hashToken(refreshToken) }).exec();
    if (!doc) return { userId: null, revoked: 0 };
    const revoked = await this.revokeFamily(String(doc.familyId));
    return { userId: String(doc.userId), revoked };
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const res = await this.model
      .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } })
      .exec();
    return res.modifiedCount;
  }

  /** Revoke one session by id, scoped to the owning user. Null when not owned. */
  async revokeSessionForUser(userId: string, sessionId: string): Promise<{ revoked: number } | null> {
    const doc = await this.model.findOne({ _id: sessionId, userId }).exec();
    if (!doc) return null;
    const revoked = await this.revokeFamily(String(doc.familyId));
    return { revoked };
  }

  async listSessionsForUser(userId: string, currentTokenHash?: string): Promise<SessionView[]> {
    const docs = await this.model.find({ userId }).sort({ createdAt: -1 }).exec();
    return docs.map((d) => ({
      id: String(d._id),
      provider: d.provider,
      createdAt: d.createdAt,
      expiresAt: d.expiresAt,
      lastUsedAt: d.lastUsedAt,
      revokedAt: d.revokedAt,
      rotated: d.replacedByHash !== null,
      current: currentTokenHash !== undefined && d.tokenHash === currentTokenHash,
      ip: d.ip,
      userAgent: d.userAgent,
      deviceLabel: d.deviceLabel,
    }));
  }
}
