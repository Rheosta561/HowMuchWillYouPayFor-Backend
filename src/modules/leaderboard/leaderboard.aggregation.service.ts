import crypto from "node:crypto";
import { IdeaModel, type IdeaDoc } from "../ideas/idea.model.js";
import { PricingResponseModel } from "../responses/response.model.js";
import type { ActiveSnapshotGroup, StagedEntry } from "./leaderboard.repository.js";
import { groupKey, medianOfSortedAsc, type ComparisonGroup } from "./leaderboard.types.js";
import { env } from "../../config/env.js";

export interface AggregationOptions {
  minResponses?: number;
  ideaBatchSize?: number;
}

export interface AggregationResult {
  snapshotId: string;
  calculatedAt: Date;
  entries: StagedEntry[];
  groups: ActiveSnapshotGroup[];
}

/**
 * Bounded aggregation: ideas stream in batches and only one idea's amounts
 * are held in memory at a time. The PricingResponse collection is never
 * loaded wholesale. Expected cost is O(ideas) queries; suitable for small to
 * medium catalogs. At very large scale this should move to a MongoDB
 * aggregation pipeline with $sortByCount-style grouping or incremental
 * map-reduce.
 *
 * Deterministic and idempotent for a fixed dataset and configuration:
 * ordering ties always resolve on ideaId ascending.
 */
export class LeaderboardAggregationService {
  constructor(
    private readonly ideas: typeof IdeaModel = IdeaModel,
    private readonly responses: typeof PricingResponseModel = PricingResponseModel,
    private readonly minResponses: number = env.LEADERBOARD_MIN_RESPONSES,
    private readonly ideaBatchSize: number = 200,
  ) {}

  async aggregate(opts: AggregationOptions = {}): Promise<AggregationResult> {
    const minResponses = opts.minResponses ?? this.minResponses;
    const batchSize = opts.ideaBatchSize ?? this.ideaBatchSize;
    const snapshotId = `lb_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
    const calculatedAt = new Date();

    const grouped = new Map<string, { group: ComparisonGroup; rows: StagedEntry[] }>();
    const record = (group: ComparisonGroup, entry: StagedEntry) => {
      const key = groupKey(group);
      const bucket = grouped.get(key);
      if (bucket) bucket.rows.push(entry);
      else grouped.set(key, { group, rows: [entry] });
    };

    let lastId: string | null = null;
    for (;;) {
      const filter: Record<string, unknown> = { status: "published" };
      if (lastId) filter._id = { $gt: lastId };
      const ideas = await this.ideas
        .find(filter)
        .sort({ _id: 1 })
        .limit(batchSize)
        .select("_id pricing targetMarket")
        .lean()
        .exec();
      if (ideas.length === 0) break;
      for (const idea of ideas as Array<Pick<IdeaDoc, "_id" | "pricing" | "targetMarket">>) {
        const amounts = await this.eligibleAmounts(String(idea._id), idea.pricing);
        if (amounts.length < minResponses) continue;
        const median = medianOfSortedAsc(amounts);
        for (const group of this.groupsForIdea(idea)) {
          record(group, {
            ideaId: String(idea._id),
            group,
            medianAmount: median,
            responseCount: amounts.length,
            rank: 0,
            calculatedAt,
          });
        }
      }
      lastId = String(ideas[ideas.length - 1]!._id);
      if (ideas.length < batchSize) break;
    }

    const entries: StagedEntry[] = [];
    const groups: ActiveSnapshotGroup[] = [];
    for (const { group, rows } of grouped.values()) {
      rows.sort(
        (a, b) =>
          b.medianAmount - a.medianAmount || b.responseCount - a.responseCount || (a.ideaId < b.ideaId ? -1 : 1),
      );
      rows.forEach((row, index) => {
        row.rank = index + 1;
        entries.push(row);
      });
      groups.push({
        scope: group.scope,
        countryCode: group.countryCode,
        cityId: group.cityId,
        currency: group.currency,
        billingPeriod: group.billingPeriod,
        entryCount: rows.length,
      });
    }
    groups.sort((a, b) =>
      `${a.scope}|${a.countryCode ?? ""}|${a.cityId ?? ""}|${a.currency}|${a.billingPeriod}` <
      `${b.scope}|${b.countryCode ?? ""}|${b.cityId ?? ""}|${b.currency}|${b.billingPeriod}`
        ? -1
        : 1,
    );
    return { snapshotId, calculatedAt, entries, groups };
  }

  /**
   * Exact-scope grouping: an idea ranks only in the group matching its own
   * target scope (global ideas in the global group, country ideas in their
   * country group, city ideas in their city group). Scopes are never mixed
   * inside one ranking, mirroring the rule that money is only compared
   * within identical currency/billing/dimension tuples.
   */
  private groupsForIdea(idea: Pick<IdeaDoc, "pricing" | "targetMarket">): ComparisonGroup[] {
    const base = { currency: idea.pricing.currency, billingPeriod: idea.pricing.billingPeriod };
    const tm = idea.targetMarket;
    if (tm.scope === "country" && tm.countryCode) {
      return [{ scope: "country", countryCode: tm.countryCode, cityId: null, ...base }];
    }
    if (tm.scope === "city" && tm.countryCode && tm.cityId) {
      return [{ scope: "city", countryCode: tm.countryCode, cityId: String(tm.cityId), ...base }];
    }
    return [{ scope: "global", countryCode: null, cityId: null, ...base }];
  }

  /** Eligible amounts for one idea, ascending. Applies every eligibility rule. */
  private async eligibleAmounts(
    ideaId: string,
    pricing: { currency: string; billingPeriod: string },
  ): Promise<number[]> {
    const filter: Record<string, unknown> = {
      ideaId: ideaId as unknown as IdeaDoc["_id"],
      currency: pricing.currency,
      billingPeriod: pricing.billingPeriod,
      amount: { $gt: 0, $lt: Number.MAX_VALUE },
    };
    const docs = await this.responses.find(filter).sort({ amount: 1 }).select("amount").lean().exec();
    const amounts: number[] = [];
    for (const doc of docs) {
      const amount = (doc as { amount?: unknown }).amount;
      if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) amounts.push(amount);
    }
    return amounts;
  }
}
