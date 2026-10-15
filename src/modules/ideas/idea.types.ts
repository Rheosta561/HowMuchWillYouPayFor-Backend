import type { IdeaDoc } from "./idea.model.js";

/** Explicit response DTO. Never leaks emails, stats, or internal fields. */
export interface IdeaDTO {
  id: string;
  creatorId: string;
  title: string;
  pitch: string;
  abstract: string;
  category: string;
  tags: string[];
  targetMarket: {
    scope: IdeaDoc["targetMarket"]["scope"];
    countryCode: string | null;
    cityId: string | null;
  };
  pricing: {
    currency: string;
    billingPeriod: IdeaDoc["pricing"]["billingPeriod"];
  };
  status: IdeaDoc["status"];
  createdAt: string;
  updatedAt: string;
}

export function toIdeaDTO(doc: IdeaDoc & { _id: { toString(): string } }): IdeaDTO {
  const creatorId = doc.creatorId as unknown as { toString(): string };
  const cityId = doc.targetMarket.cityId as unknown as { toString(): string } | null;
  return {
    id: doc._id.toString(),
    creatorId: creatorId.toString(),
    title: doc.title,
    pitch: doc.pitch,
    abstract: doc.abstract,
    category: doc.category,
    tags: [...doc.tags],
    targetMarket: {
      scope: doc.targetMarket.scope,
      countryCode: doc.targetMarket.countryCode,
      cityId: cityId ? cityId.toString() : null,
    },
    pricing: {
      currency: doc.pricing.currency,
      billingPeriod: doc.pricing.billingPeriod,
    },
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export interface IdeaCursor {
  /** ISO timestamp of the anchor document. */
  t: string;
  /** Anchor document _id. */
  id: string;
}

export function encodeCursor(cursor: IdeaCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): IdeaCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { t?: unknown }).t === "string" &&
      typeof (parsed as { id?: unknown }).id === "string" &&
      !Number.isNaN(Date.parse((parsed as { t: string }).t)) &&
      /^[a-f0-9]{24}$/i.test((parsed as { id: string }).id)
    ) {
      return parsed as IdeaCursor;
    }
    return null;
  } catch {
    return null;
  }
}
