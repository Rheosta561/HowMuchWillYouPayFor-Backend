import type { Types } from "mongoose";
import {
  LeaderboardEntryModel,
  type LeaderboardEntryDoc,
} from "./leaderboard.snapshot.model.js";
import { LeaderboardMetadataModel } from "./leaderboard.metadata.model.js";
import type { ComparisonGroup } from "./leaderboard.types.js";

export interface StagedEntry {
  ideaId: string;
  group: ComparisonGroup;
  medianAmount: number;
  responseCount: number;
  rank: number;
  calculatedAt: Date;
}

export interface ActiveSnapshot {
  snapshotId: string;
  generation: number;
  publishedAt: Date | null;
  calculatedAt: Date | null;
  entryCount: number;
}

const ACTIVE_KEY = "active";

export class LeaderboardRepository {
  constructor(
    private readonly entries: typeof LeaderboardEntryModel = LeaderboardEntryModel,
    private readonly metadata: typeof LeaderboardMetadataModel = LeaderboardMetadataModel,
  ) {}

  async getActive(): Promise<ActiveSnapshot | null> {
    const doc = await this.metadata.findOne({ _id: ACTIVE_KEY }).lean().exec();
    if (!doc || !doc.snapshotId) return null;
    return {
      snapshotId: doc.snapshotId,
      generation: doc.generation,
      publishedAt: doc.publishedAt,
      calculatedAt: doc.calculatedAt,
      entryCount: doc.entryCount,
    };
  }

  /** Readers always scope to one snapshot id: snapshots never mix. */
  async listEntries(
    snapshotId: string,
    group: ComparisonGroup,
    opts: { afterRank?: number; limit: number },
  ): Promise<LeaderboardEntryDoc[]> {
    const filter: Record<string, unknown> = {
      snapshotId,
      scope: group.scope,
      countryCode: group.countryCode,
      cityId: group.cityId as unknown as Types.ObjectId | null,
      currency: group.currency,
      billingPeriod: group.billingPeriod,
    };
    if (opts.afterRank !== undefined) filter.rank = { $gt: opts.afterRank };
    return this.entries.find(filter).sort({ rank: 1 }).limit(opts.limit + 1).lean().exec();
  }

  async findPosition(
    snapshotId: string,
    group: ComparisonGroup,
    ideaId: string,
  ): Promise<LeaderboardEntryDoc | null> {
    return this.entries
      .findOne({
        snapshotId,
        ideaId: ideaId as unknown as Types.ObjectId,
        scope: group.scope,
        countryCode: group.countryCode,
        cityId: group.cityId as unknown as Types.ObjectId | null,
        currency: group.currency,
        billingPeriod: group.billingPeriod,
      })
      .lean()
      .exec();
  }

  /** Stage a full snapshot under a fresh id. The active pointer is untouched. */
  async stageEntries(snapshotId: string, entries: StagedEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const docs = entries.map((e) => ({
      snapshotId,
      ideaId: e.ideaId as unknown as Types.ObjectId,
      scope: e.group.scope,
      countryCode: e.group.countryCode,
      cityId: e.group.cityId as unknown as Types.ObjectId | null,
      currency: e.group.currency,
      billingPeriod: e.group.billingPeriod,
      medianAmount: e.medianAmount,
      responseCount: e.responseCount,
      rank: e.rank,
      calculatedAt: e.calculatedAt,
    }));
    const inserted = await this.entries.insertMany(docs, { ordered: false });
    return inserted.length;
  }

  /**
   * Validate a staged snapshot from the database (not from memory):
   * every comparison group must hold contiguous ranks 1..n.
   */
  async validateStaged(snapshotId: string): Promise<{ groups: number; entries: number }> {
    const rows = (await this.entries
      .aggregate([
        { $match: { snapshotId } },
        {
          $group: {
            _id: {
              scope: "$scope",
              countryCode: "$countryCode",
              cityId: "$cityId",
              currency: "$currency",
              billingPeriod: "$billingPeriod",
            },
            count: { $sum: 1 },
            minRank: { $min: "$rank" },
            maxRank: { $max: "$rank" },
          },
        },
      ])
      .exec()) as Array<{ count: number; minRank: number; maxRank: number }>;
    let entries = 0;
    for (const row of rows) {
      if (row.minRank !== 1 || row.maxRank !== row.count) {
        throw new Error(
          `Staged snapshot ${snapshotId} is inconsistent: ranks are not contiguous 1..${row.count}`,
        );
      }
      entries += row.count;
    }
    return { groups: rows.length, entries };
  }

  /**
   * Publish only if the generation still matches (fencing): a stale run
   * whose lease expired can never overwrite a newer snapshot. Atomic
   * single-document update; returns false when fenced out.
   */
  async publishIfCurrent(
    snapshotId: string,
    expectedGeneration: number,
    summary: { calculatedAt: Date; entryCount: number; groups: ActiveSnapshotGroup[] },
  ): Promise<boolean> {
    const now = new Date();
    try {
      const updated = await this.metadata
        .findOneAndUpdate(
          { _id: ACTIVE_KEY, generation: expectedGeneration },
          {
            $set: {
              snapshotId,
              generation: expectedGeneration + 1,
              publishedAt: now,
              calculatedAt: summary.calculatedAt,
              entryCount: summary.entryCount,
              groups: summary.groups,
            },
            $setOnInsert: { _id: ACTIVE_KEY },
          },
          { upsert: true, returnDocument: "after" },
        )
        .exec();
      return updated !== null && updated.snapshotId === snapshotId;
    } catch (err) {
      // Lost a concurrent first-publish upsert race: treat as fenced out.
      if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Snapshots that are neither active nor recently staged are safe to delete.
   * Never call this for the active snapshot id.
   */
  async deleteSnapshot(snapshotId: string): Promise<number> {
    const res = await this.entries.deleteMany({ snapshotId }).exec();
    return res.deletedCount;
  }

  /** Candidate ids for safe cleanup: staged but never activated and older than the cutoff. */
  async listAbandonedSnapshotIds(olderThan: Date, activeSnapshotId: string | null): Promise<string[]> {
    const rows = (await this.entries
      .aggregate([
        { $match: { createdAt: { $lt: olderThan } } },
        { $group: { _id: "$snapshotId" } },
      ])
      .exec()) as Array<{ _id: string }>;
    return rows.map((r) => r._id).filter((id) => id !== activeSnapshotId);
  }
}

export interface ActiveSnapshotGroup {
  scope: string;
  countryCode: string | null;
  cityId: string | null;
  currency: string;
  billingPeriod: string;
  entryCount: number;
}
