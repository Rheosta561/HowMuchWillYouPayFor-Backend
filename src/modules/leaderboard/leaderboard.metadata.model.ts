import mongoose, { Schema, type HydratedDocument } from "mongoose";

export interface LeaderboardMetadataDoc {
  /** Singleton key; always "active". */
  _id: string;
  /** Snapshot id currently served by readers. Null until the first publish. */
  snapshotId: string | null;
  /** Monotonic fencing generation, incremented on every publish. */
  generation: number;
  publishedAt: Date | null;
  calculatedAt: Date | null;
  /** Number of entries in the active snapshot. */
  entryCount: number;
  /** Comparison groups present in the active snapshot. */
  groups: Array<{
    scope: string;
    countryCode: string | null;
    cityId: string | null;
    currency: string;
    billingPeriod: string;
    entryCount: number;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

export type LeaderboardMetadataDocument = HydratedDocument<LeaderboardMetadataDoc>;

const groupSchema = new Schema(
  {
    scope: { type: String, required: true },
    countryCode: { type: String, default: null },
    cityId: { type: String, default: null },
    currency: { type: String, required: true },
    billingPeriod: { type: String, required: true },
    entryCount: { type: Number, required: true },
  },
  { _id: false },
);

const metadataSchema = new Schema<LeaderboardMetadataDoc>(
  {
    _id: { type: String, required: true },
    snapshotId: { type: String, default: null },
    generation: { type: Number, required: true, default: 0 },
    publishedAt: { type: Date, default: null },
    calculatedAt: { type: Date, default: null },
    entryCount: { type: Number, required: true, default: 0 },
    groups: { type: [groupSchema], default: [] },
  },
  { timestamps: true },
);

export const LeaderboardMetadataModel: mongoose.Model<LeaderboardMetadataDoc> =
  (mongoose.models.LeaderboardMetadata as mongoose.Model<LeaderboardMetadataDoc> | undefined) ??
  mongoose.model<LeaderboardMetadataDoc>("LeaderboardMetadata", metadataSchema);
