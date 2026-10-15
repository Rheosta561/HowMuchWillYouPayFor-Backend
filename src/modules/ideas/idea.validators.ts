import { z } from "zod";

/** Active ISO 4217 national currency codes. */
export const ISO_4217_CURRENCIES = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
  "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
  "USD", "UYU", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XCD",
  "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWL",
]);

export const MAX_TITLE_LENGTH = 120;
export const MAX_PITCH_LENGTH = 300;
export const MAX_ABSTRACT_WORDS = 120;
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 30;

export function countWords(value: string): number {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return value.trim() === "" ? 0 : words.length;
}

const currencySchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.string().refine((v) => ISO_4217_CURRENCIES.has(v), {
    message: "Currency must be a valid ISO 4217 code.",
  }),
);

const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TAG_LENGTH)
  .regex(/^[\p{L}\p{N}\s-]+$/u, { message: "Tag contains unsupported characters." })
  .transform((v) => v.toLowerCase());

const categorySlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform((v) => v.toLowerCase());

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, { message: "Invalid ObjectId." });

const countryCodeSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
  z.string().regex(/^[A-Z]{2}$/, { message: "Country must be an ISO 3166-1 alpha-2 code." }),
);

const targetMarketSchema = z
  .object({
    scope: z.enum(["global", "country", "city"]),
    countryCode: countryCodeSchema.nullable().default(null),
    cityId: objectIdSchema.nullable().default(null),
  })
  .superRefine((val, ctx) => {
    if (val.scope === "global") {
      if (val.countryCode !== null) {
        ctx.addIssue({ code: "custom", message: "Global scope must not include a countryCode." });
      }
      if (val.cityId !== null) {
        ctx.addIssue({ code: "custom", message: "Global scope must not include a cityId." });
      }
    }
    if (val.scope === "country") {
      if (val.countryCode === null) {
        ctx.addIssue({ code: "custom", message: "Country scope requires a countryCode." });
      }
      if (val.cityId !== null) {
        ctx.addIssue({ code: "custom", message: "Country scope must not include a cityId." });
      }
    }
    if (val.scope === "city") {
      if (val.countryCode === null || val.cityId === null) {
        ctx.addIssue({ code: "custom", message: "City scope requires a countryCode and a cityId." });
      }
    }
  });

/**
 * Create payload. Deliberately excludes creatorId, status, timestamps and
 * statistics: mass assignment of those fields is impossible by construction.
 */
export const createIdeaSchema = z.object({
  title: z.string().trim().min(3).max(MAX_TITLE_LENGTH),
  pitch: z.string().trim().min(10).max(MAX_PITCH_LENGTH),
  abstract: z
    .string()
    .trim()
    .min(1)
    .refine((v) => countWords(v) <= MAX_ABSTRACT_WORDS, {
      message: `Abstract must be at most ${MAX_ABSTRACT_WORDS} words.`,
    }),
  category: categorySlugSchema,
  tags: z.array(tagSchema).max(MAX_TAGS).default([]),
  targetMarket: targetMarketSchema,
  pricing: z.object({
    currency: currencySchema,
    billingPeriod: z.enum(["one_time", "weekly", "monthly", "yearly"]),
  }),
});

export type CreateIdeaInput = z.infer<typeof createIdeaSchema>;

export const ideaIdSchema = objectIdSchema;

export const listIdeasQuerySchema = z.object({
  category: categorySlugSchema.optional(),
  sort: z.enum(["newest", "popular"]).default("newest"),
  scope: z.enum(["global", "country", "city"]).default("global"),
  country: countryCodeSchema.optional(),
  cityId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

export type ListIdeasQuery = z.infer<typeof listIdeasQuerySchema>;

export const myIdeasQuerySchema = z.object({
  status: z.enum(["published", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

export type MyIdeasQuery = z.infer<typeof myIdeasQuerySchema>;

export const navigationQuerySchema = listIdeasQuerySchema.omit({ cursor: true, limit: true });

export type NavigationQuery = z.infer<typeof navigationQuerySchema>;
