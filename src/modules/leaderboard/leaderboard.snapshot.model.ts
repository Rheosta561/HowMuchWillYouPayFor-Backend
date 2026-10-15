import mongoose, { Schema, type HydratedDocument, type Types } from "mongoose";
import type { BillingPeriod } from "../ideas/idea.model.js";
import type { LeaderboardScope } from "./leaderboard.types.js";

export interface LeaderboardEntryDoc {
  _id: Types.ObjectId;
  /** Stable id of the calculation run that produced this entry. */
  snapshotId: string;
  ideaId: Types.ObjectId;
  scope: LeaderboardScope;
  countryCode: string | null;
  cityId: Types.ObjectId | null;
  currency: string;
  billingPeriod: BillingPeriod;
  medianAmount: number;
  responseCount: number;
  /** 1-based rank inside the exact comparison group. */
  rank: number;
  calculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type LeaderboardEntryDocument = HydratedDocument<LeaderboardEntryDoc>;

const entrySchema = new Schema<LeaderboardEntryDoc>(
  {
    snapshotId: { type: String, required: true, index: true },
    ideaId: { type: Schema.Types.ObjectId, ref: "Idea", required: true },
    scope: { type: String, enum: ["global", "country", "city"], required: true },
    countryCode: { type: String, default: null },
    cityId: { type: Schema.Types.ObjectId, ref: "City", default: null },
    currency: { type: String, required: true },
    billingPeriod: {
      type: String,
      enum: ["one_time", "weekly", "monthly", "yearly"],
      required: true,
    },
    medianAmount: { type: Number, required: true },
    responseCount: { type: Number, required: true, min: 1 },
    rank: { type: Number, required: true, min: 1 },
    calculatedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Listing: one active snapshot + comparison group, in ranking order.
// (Served by the unique rank index below; no separate index needed.)
// Position lookup: idea inside a snapshot.
entrySchema.index({ snapshotId: 1, ideaId: 1 });
// One entry per idea per comparison group per snapshot.
entrySchema.index(
  { snapshotId: 1, scope: 1, countryCode: 1, cityId: 1, currency: 1, billingPeriod: 1, ideaId: 1 },
  { unique: true },
);
// Rank uniqueness inside a comparison group (contiguous 1..n ranks).
entrySchema.index(
  { snapshotId: 1, scope: 1, countryCode: 1, cityId: 1, currency: 1, billingPeriod: 1, rank: 1 },
  { unique: true },
);

export const LeaderboardEntryModel: mongoose.Model<LeaderboardEntryDoc> =
  (mongoose.models.LeaderboardEntry as mongoose.Model<LeaderboardEntryDoc> | undefined) ??
  mongoose.model<LeaderboardEntryDoc>("LeaderboardEntry", entrySchema);
