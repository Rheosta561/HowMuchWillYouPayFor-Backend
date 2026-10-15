import mongoose, { Schema, type HydratedDocument, type Types } from "mongoose";

export type MarketScope = "global" | "country" | "city";
export type BillingPeriod = "one_time" | "weekly" | "monthly" | "yearly";
export type IdeaStatus = "published" | "archived";

export interface TargetMarketDoc {
  scope: MarketScope;
  /** ISO 3166-1 alpha-2, uppercase. Null unless scope is country or city. */
  countryCode: string | null;
  /** Canonical City ObjectId. Null unless scope is city. */
  cityId: Types.ObjectId | null;
}

export interface PricingDoc {
  /** Uppercase ISO 4217 currency code. */
  currency: string;
  billingPeriod: BillingPeriod;
}

export interface IdeaDoc {
  _id: Types.ObjectId;
  creatorId: Types.ObjectId;
  title: string;
  pitch: string;
  /** Full text; word-count limit enforced at validation. */
  abstract: string;
  /** Canonical category slug, lowercase. */
  category: string;
  /** Normalized lowercase tags. */
  tags: string[];
  targetMarket: TargetMarketDoc;
  pricing: PricingDoc;
  status: IdeaStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type IdeaDocument = HydratedDocument<IdeaDoc>;

const targetMarketSchema = new Schema<TargetMarketDoc>(
  {
    scope: { type: String, enum: ["global", "country", "city"], required: true },
    countryCode: { type: String, default: null },
    cityId: { type: Schema.Types.ObjectId, ref: "City", default: null },
  },
  { _id: false },
);

const pricingSchema = new Schema<PricingDoc>(
  {
    currency: { type: String, required: true },
    billingPeriod: { type: String, enum: ["one_time", "weekly", "monthly", "yearly"], required: true },
  },
  { _id: false },
);

const ideaSchema = new Schema<IdeaDoc>(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    pitch: { type: String, required: true, trim: true, maxlength: 300 },
    abstract: { type: String, required: true, trim: true },
    category: { type: String, required: true, lowercase: true, trim: true },
    tags: { type: [String], default: [] },
    targetMarket: { type: targetMarketSchema, required: true },
    pricing: { type: pricingSchema, required: true },
    // MVP: ideas publish immediately. Clients cannot set this (see validators);
    // only published <-> archived transitions owned by the service exist.
    status: { type: String, enum: ["published", "archived"], required: true, default: "published" },
  },
  { timestamps: true },
);

// Published listing: newest first with _id tie-break.
ideaSchema.index({ status: 1, createdAt: -1, _id: -1 });
// Published listing filtered by category.
ideaSchema.index({ status: 1, category: 1, createdAt: -1, _id: -1 });
// Published listing filtered by location (countryCode is null for global ideas).
ideaSchema.index({ status: 1, "targetMarket.countryCode": 1, createdAt: -1, _id: -1 });
// Personal history.
ideaSchema.index({ creatorId: 1, status: 1, createdAt: -1, _id: -1 });

export const IdeaModel: mongoose.Model<IdeaDoc> =
  (mongoose.models.Idea as mongoose.Model<IdeaDoc> | undefined) ??
  mongoose.model<IdeaDoc>("Idea", ideaSchema);
