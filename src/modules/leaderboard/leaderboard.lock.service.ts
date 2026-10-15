import crypto from "node:crypto";
import mongoose, { Schema, type HydratedDocument } from "mongoose";
import { env } from "../../config/env.js";

export interface LeaderboardLockDoc {
  _id: string;
  owner: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const lockSchema = new Schema<LeaderboardLockDoc>(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

lockSchema.index({ expiresAt: 1 });

export const LeaderboardLockModel: mongoose.Model<LeaderboardLockDoc> =
  (mongoose.models.LeaderboardLock as mongoose.Model<LeaderboardLockDoc> | undefined) ??
  mongoose.model<LeaderboardLockDoc>("LeaderboardLock", lockSchema);

export type LeaderboardLockModelLike = typeof LeaderboardLockModel;

export function newOwnerId(): string {
  return `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
}

export interface AcquiredLock {
  owner: string;
  expiresAt: Date;
}

/**
 * MongoDB-backed distributed refresh lock.
 * - Acquisition is one atomic findOneAndUpdate (upsert): only an expired or
 *   absent lock can be taken, so two replicas cannot both hold it.
 * - Release deletes only the row owned by this execution (safe release).
 * - A crashed holder's lease expires and becomes recoverable automatically.
 */
export class LeaderboardLockService {
  constructor(
    private readonly model: LeaderboardLockModelLike = LeaderboardLockModel,
    private readonly leaseSeconds: number = env.LEADERBOARD_LOCK_TTL_SECONDS,
  ) {}

  async acquire(key = "refresh", owner: string = newOwnerId()): Promise<AcquiredLock | null> {
    const now = new Date();
    const doc = (await this.model
      .findOneAndUpdate(
        { _id: key, $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }] },
        { $set: { owner, expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000) } },
        { upsert: false, returnDocument: "after" },
      )
      .exec()) as (HydratedDocument<LeaderboardLockDoc> & AcquiredLock) | null;
    if (doc) return { owner: doc.owner, expiresAt: doc.expiresAt };
    // Absent lock: create it atomically; a duplicate-key loss means another
    // replica won the race.
    try {
      const created = await this.model.create({
        _id: key,
        owner,
        expiresAt: new Date(now.getTime() + this.leaseSeconds * 1000),
      });
      return { owner: created.owner, expiresAt: created.expiresAt };
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000) {
        return null;
      }
      throw err;
    }
  }

  /** Deletes the lock only if still owned by this execution. */
  async release(key = "refresh", owner?: string): Promise<boolean> {
    if (!owner) return false;
    const res = await this.model.deleteOne({ _id: key, owner }).exec();
    return res.deletedCount === 1;
  }

  /** Inspects the lock row (used by the status endpoint). */
  async peek(key = "refresh"): Promise<{ owner: string; expiresAt: Date } | null> {
    const doc = await this.model.findOne({ _id: key }).lean().exec();
    if (!doc) return null;
    return { owner: doc.owner, expiresAt: doc.expiresAt };
  }
}
