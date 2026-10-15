import type { BillingPeriod } from "../ideas/idea.model.js";

export type LeaderboardScope = "global" | "country" | "city";

/** Exact comparison group: monetary values are only ever compared inside one of these. */
export interface ComparisonGroup {
  scope: LeaderboardScope;
  countryCode: string | null;
  cityId: string | null;
  currency: string;
  billingPeriod: BillingPeriod;
}

export function groupKey(group: ComparisonGroup): string {
  return [group.scope, group.countryCode ?? "-", group.cityId ?? "-", group.currency, group.billingPeriod].join("|");
}

export interface RankedEntry {
  ideaId: string;
  medianAmount: number;
  responseCount: number;
  rank: number;
}

export interface SnapshotMeta {
  snapshotId: string;
  calculatedAt: Date;
  groups: ComparisonGroup[];
}

export interface PublicLeaderboardEntry {
  rank: number;
  medianAmount: number;
  responseCount: number;
  idea: {
    id: string;
    title: string;
    pitch: string;
    abstract: string;
    category: string;
    tags: string[];
    targetMarket: {
      scope: string;
      countryCode: string | null;
      cityId: string | null;
    };
    pricing: {
      currency: string;
      billingPeriod: string;
    };
    status: string;
    createdAt: string;
    updatedAt: string;
  };
}

/** Median of a pre-sorted ascending array. Even counts use the mean of the two middles. */
export function medianOfSortedAsc(values: number[]): number {
  const n = values.length;
  if (n === 0) throw new Error("Cannot take the median of an empty array");
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return values[mid]!;
  return (values[mid - 1]! + values[mid]!) / 2;
}

/** Output precision is applied only at serialization; stored values are raw. */
export function serializeMedian(value: number): number {
  return Math.round(value * 100) / 100;
}
