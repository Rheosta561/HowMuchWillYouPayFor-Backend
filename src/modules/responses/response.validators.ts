import { z } from "zod";
import { MAX_RESPONSE_AMOUNT } from "./response.model.js";

function hasAtMostTwoDecimals(v: number): boolean {
  // epsilon-tolerant minor-unit check (avoids binary float artifacts).
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

/**
 * Strict body: only `amount` is accepted. userId, currency, billingPeriod,
 * _id, timestamps, and any leaderboard fields are rejected with 400 rather
 * than silently stripped.
 */
export const submitResponseSchema = z.strictObject({
  amount: z
    .number()
    .finite({ message: "Amount must be finite." })
    .positive({ message: "Amount must be positive." })
    .max(MAX_RESPONSE_AMOUNT, { message: `Amount must not exceed ${MAX_RESPONSE_AMOUNT}.` })
    .refine(hasAtMostTwoDecimals, { message: "Amount must have at most 2 decimal places." }),
});

export type SubmitResponseInput = z.infer<typeof submitResponseSchema>;

export const ideaIdParamSchema = z.object({
  ideaId: z.string().regex(/^[a-f0-9]{24}$/i, { message: "Invalid idea ID." }),
});

export const myResponsesQuerySchema = z.object({
  ideaId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i, { message: "Invalid idea ID." })
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});

export type MyResponsesQuery = z.infer<typeof myResponsesQuerySchema>;
