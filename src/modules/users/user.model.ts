import mongoose, { Schema, type HydratedDocument } from "mongoose";

export type AccountStatus = "active" | "suspended" | "deleted";
export type UserRole = "user" | "admin";
export type AuthProviderName = "email-otp" | "google";

export interface ProviderIdentityDoc {
  provider: AuthProviderName;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  linkedAt: Date;
}

export interface UserDoc {
  email: string;
  emailNormalized: string;
  status: AccountStatus;
  role: UserRole;
  providers: ProviderIdentityDoc[];
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<UserDoc>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const providerIdentitySchema = new Schema<ProviderIdentityDoc>(
  {
    provider: { type: String, enum: ["email-otp", "google"], required: true },
    providerUserId: { type: String, required: true },
    email: { type: String, required: true },
    emailVerified: { type: Boolean, required: true, default: false },
    linkedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true },
    emailNormalized: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["active", "suspended", "deleted"],
      default: "active",
      index: true,
    },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    providers: { type: [providerIdentitySchema], default: [] },
  },
  { timestamps: true },
);

// Normalized-email lookup for identity resolution (unique index via `unique: true` above).
// Provider identity lookup. Unique + sparse so the same provider account can
// never belong to two users, while docs without providers stay valid.
userSchema.index(
  { "providers.provider": 1, "providers.providerUserId": 1 },
  { unique: true, sparse: true },
);

userSchema.pre("validate", function () {
  if (this.email) {
    this.emailNormalized = normalizeEmail(this.email);
  }
});

export const UserModel: mongoose.Model<UserDoc> =
  (mongoose.models.User as mongoose.Model<UserDoc> | undefined) ??
  mongoose.model<UserDoc>("User", userSchema);
