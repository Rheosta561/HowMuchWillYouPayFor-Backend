import { z } from "zod";

export const providerSchema = z.enum(["email-otp", "google"]);

const emailSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z.email(),
);

export const requestOtpSchema = z.object({
  email: emailSchema,
  purpose: z.enum(["signup", "login"]).default("login"),
});

export const verifyOtpSchema = z.object({
  email: emailSchema,
  code: z.string().trim().min(4).max(10),
});

export const emailOtpAuthSchema = verifyOtpSchema;

export const googleAuthSchema = z.object({
  idToken: z.string().min(1),
});

export const genericSignupSchema = z.object({
  provider: providerSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const genericLoginSchema = genericSignupSchema;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
