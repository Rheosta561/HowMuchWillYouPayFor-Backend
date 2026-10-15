import { z } from "zod";
import { ISO_4217_CURRENCIES } from "../ideas/idea.validators.js";

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, { message: "Invalid ObjectId." });

const countryCodeSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.string().regex(/^[A-Z]{2}$/, { message: "Country must be an ISO 3166-1 alpha-2 code." }),
);

// No product-wide currency/billing defaults exist, so both are required.
const currencySchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.string().refine((v) => ISO_4217_CURRENCIES.has(v), {
    message: "Currency must be a valid ISO 4217 code.",
  }),
);

const dimensionsSchema = z.object({
  scope: z.enum(["global", "country", "city"]).default("global"),
  countryCode: countryCodeSchema.optional(),
  cityId: objectIdSchema.optional(),
  currency: currencySchema,
  billingPeriod: z.enum(["one_time", "weekly", "monthly", "yearly"]),
});

export const leaderboardQuerySchema = dimensionsSchema
  .extend({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.scope === "global" && (val.countryCode !== undefined || val.cityId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Global scope takes no countryCode or cityId." });
    }
    if (val.scope === "country") {
      if (val.countryCode === undefined) {
        ctx.addIssue({ code: "custom", message: "Country scope requires countryCode." });
      }
      if (val.cityId !== undefined) {
        ctx.addIssue({ code: "custom", message: "Country scope takes no cityId." });
      }
    }
    if (val.scope === "city" && (val.countryCode === undefined || val.cityId === undefined)) {
      ctx.addIssue({ code: "custom", message: "City scope requires countryCode and cityId." });
    }
  });

export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

export const leaderboardPositionQuerySchema = dimensionsSchema.superRefine((val, ctx) => {
  if (val.scope === "global" && (val.countryCode !== undefined || val.cityId !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Global scope takes no countryCode or cityId." });
  }
  if (val.scope === "country") {
    if (val.countryCode === undefined) {
      ctx.addIssue({ code: "custom", message: "Country scope requires countryCode." });
    }
    if (val.cityId !== undefined) {
      ctx.addIssue({ code: "custom", message: "Country scope takes no cityId." });
    }
  }
  if (val.scope === "city" && (val.countryCode === undefined || val.cityId === undefined)) {
    ctx.addIssue({ code: "custom", message: "City scope requires countryCode and cityId." });
  }
});

export type LeaderboardPositionQuery = z.infer<typeof leaderboardPositionQuerySchema>;

export interface RankCursor {
  rank: number;
}

export function encodeRankCursor(cursor: RankCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeRankCursor(cursor: string): RankCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Number.isInteger((parsed as { rank?: unknown }).rank) &&
      (parsed as { rank: number }).rank >= 1
    ) {
      return { rank: (parsed as { rank: number }).rank };
    }
    return null;
  } catch {
    return null;
  }
}
