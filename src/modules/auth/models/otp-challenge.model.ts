import mongoose, { Schema, type HydratedDocument } from "mongoose";

export type OtpPurpose = "signup" | "login";

export interface OtpChallengeDoc {
  email: string;
  emailNormalized: string;
  /** HMAC-SHA256 hash of the OTP (pepper + per-challenge salt). Never plaintext. */
  codeHash: string;
  /** Per-challenge random salt for the OTP hash. */
  salt: string;
  purpose: OtpPurpose;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OtpChallengeDocument = HydratedDocument<OtpChallengeDoc>;

const otpChallengeSchema = new Schema<OtpChallengeDoc>(
  {
    email: { type: String, required: true },
    emailNormalized: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    salt: { type: String, required: true },
    purpose: { type: String, enum: ["signup", "login"], required: true, default: "login" },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 5 },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

otpChallengeSchema.index({ emailNormalized: 1, createdAt: -1 });

export const OtpChallengeModel =
  (mongoose.models.OtpChallenge as mongoose.Model<OtpChallengeDoc> | undefined) ??
  mongoose.model<OtpChallengeDoc>("OtpChallenge", otpChallengeSchema);
