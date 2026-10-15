import mongoose, { Schema, type HydratedDocument, type Types } from "mongoose";

export interface RefreshSessionDoc {
  userId: Types.ObjectId;
  /** SHA-256 hash of the opaque refresh token. Plaintext is never stored. */
  tokenHash: string;
  /** Rotation family: all sessions descended from one login share this id. */
  familyId: string;
  provider: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** Hash this session was rotated from (predecessor), if any. */
  rotatedFromHash: string | null;
  /** Hash this session was rotated into (successor), if any. */
  replacedByHash: string | null;
  ip?: string;
  userAgent?: string;
  deviceLabel?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type RefreshSessionDocument = HydratedDocument<RefreshSessionDoc>;

const refreshSessionSchema = new Schema<RefreshSessionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    provider: { type: String, required: true },
    // TTL index: removes stale documents for hygiene. Expiry and
    // revocation are always enforced in application logic, never by TTL.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    rotatedFromHash: { type: String, default: null },
    replacedByHash: { type: String, default: null },
    ip: { type: String },
    userAgent: { type: String },
    deviceLabel: { type: String },
  },
  { timestamps: true },
);

refreshSessionSchema.index({ userId: 1, revokedAt: 1 });
refreshSessionSchema.index({ familyId: 1, revokedAt: 1 });

export const RefreshSessionModel =
  (mongoose.models.RefreshSession as mongoose.Model<RefreshSessionDoc> | undefined) ??
  mongoose.model<RefreshSessionDoc>("RefreshSession", refreshSessionSchema);
