import type { PricingResponseDoc } from "./response.model.js";

/** Explicit response DTO. No emails, no aggregates, no internal fields. */
export interface PricingResponseDTO {
  id: string;
  ideaId: string;
  userId: string;
  amount: number;
  currency: string;
  billingPeriod: PricingResponseDoc["billingPeriod"];
  createdAt: string;
}

export function toResponseDTO(
  doc: PricingResponseDoc & { _id: { toString(): string } },
): PricingResponseDTO {
  const ideaId = doc.ideaId as unknown as { toString(): string };
  const userId = doc.userId as unknown as { toString(): string };
  return {
    id: doc._id.toString(),
    ideaId: ideaId.toString(),
    userId: userId.toString(),
    amount: doc.amount,
    currency: doc.currency,
    billingPeriod: doc.billingPeriod,
    createdAt: doc.createdAt.toISOString(),
  };
}
