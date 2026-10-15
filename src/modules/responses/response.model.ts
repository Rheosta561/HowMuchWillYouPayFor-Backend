import mongoose, { Schema, type HydratedDocument, type Types } from "mongoose";
import type { BillingPeriod } from "../ideas/idea.model.js";

/** Documented product bound: amounts above this are rejected. */
export const MAX_RESPONSE_AMOUNT = 100_000_000;
/** Minor-unit precision: at most 2 decimal places. */
export const MAX_AMOUNT_DECIMALS = 2;

export interface PricingResponseDoc {
  _id: Types.ObjectId;
  ideaId: Types.ObjectId;
  userId: Types.ObjectId;
  /** Major-unit amount (e.g. dollars). See docs/responses.md for representation notes. */
  amount: number;
  /** Uppercase ISO 4217 code, always copied from the idea. */
  currency: string;
  /** Always copied from the idea. */
  billingPeriod: BillingPeriod;
  createdAt: Date;
  updatedAt: Date;
}

export type PricingResponseDocument = HydratedDocument<PricingResponseDoc>;

const responseSchema = new Schema<PricingResponseDoc>(
  {
    ideaId: { type: Schema.Types.ObjectId, ref: "Idea", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: (v: number) => typeof v === "number" && Number.isFinite(v) && v > 0,
        message: "Amount must be a finite positive number.",
      },
    },
    currency: { type: String, required: true },
    billingPeriod: {
      type: String,
      enum: ["one_time", "weekly", "monthly", "yearly"],
      required: true,
    },
  },
  { timestamps: true },
);

// One response per user per idea. This index (not application checks) is the
// concurrency-safe enforcement of the business rule.
responseSchema.index({ ideaId: 1, userId: 1 }, { unique: true });
// Authenticated user's history, newest first with _id tie-break.
responseSchema.index({ userId: 1, createdAt: -1, _id: -1 });

export const PricingResponseModel: mongoose.Model<PricingResponseDoc> =
  (mongoose.models.PricingResponse as mongoose.Model<PricingResponseDoc> | undefined) ??
  mongoose.model<PricingResponseDoc>("PricingResponse", responseSchema);
