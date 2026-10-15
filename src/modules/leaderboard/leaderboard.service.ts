import { IdeaModel } from "../ideas/idea.model.js";
import { toIdeaDTO } from "../ideas/idea.types.js";
import { IdeaError } from "../ideas/api-envelope.js";
import { LocationService } from "../locations/location.service.js";
import { LeaderboardRepository } from "./leaderboard.repository.js";
import { LeaderboardLockService } from "./leaderboard.lock.service.js";
import {
  serializeMedian,
  type ComparisonGroup,
  type PublicLeaderboardEntry,
} from "./leaderboard.types.js";
import type { LeaderboardPositionQuery, LeaderboardQuery } from "./leaderboard.validators.js";
import { decodeRankCursor, encodeRankCursor } from "./leaderboard.validators.js";

export interface LeaderboardPage {
  available: boolean;
  entries: PublicLeaderboardEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  snapshotId: string | null;
  calculatedAt: string | null;
  group: ComparisonGroup | null;
}

export class LeaderboardService {
  constructor(
    private readonly repository: LeaderboardRepository = new LeaderboardRepository(),
    private readonly locations: LocationService = new LocationService(),
    private readonly ideas: typeof IdeaModel = IdeaModel,
    private readonly locks: LeaderboardLockService = new LeaderboardLockService(),
  ) {}

  async resolveGroup(query: LeaderboardPositionQuery): Promise<ComparisonGroup> {
    if (query.scope === "global") {
      return {
        scope: "global",
        countryCode: null,
        cityId: null,
        currency: query.currency,
        billingPeriod: query.billingPeriod,
      };
    }
    const country = await this.locations.findActiveCountry(query.countryCode!);
    if (!country) throw new IdeaError(404, "COUNTRY_NOT_FOUND", "Country not found.");
    if (query.scope === "country") {
      return {
        scope: "country",
        countryCode: country._id,
        cityId: null,
        currency: query.currency,
        billingPeriod: query.billingPeriod,
      };
    }
    const city = await this.locations.findActiveCityById(query.cityId!);
    if (!city) throw new IdeaError(404, "CITY_NOT_FOUND", "City not found.");
    if (city.countryCode !== country._id) {
      throw new IdeaError(400, "CITY_COUNTRY_MISMATCH", "The city does not belong to the given country.");
    }
    return {
      scope: "city",
      countryCode: country._id,
      cityId: String(city._id),
      currency: query.currency,
      billingPeriod: query.billingPeriod,
    };
  }

  async list(query: LeaderboardQuery): Promise<LeaderboardPage> {
    const group = await this.resolveGroup(query);
    const active = await this.repository.getActive();
    if (!active) {
      return { available: false, entries: [], nextCursor: null, hasMore: false, snapshotId: null, calculatedAt: null, group };
    }
    let afterRank: number | undefined;
    if (query.cursor) {
      const decoded = decodeRankCursor(query.cursor);
      if (!decoded) throw new IdeaError(400, "VALIDATION_ERROR", "Invalid pagination cursor.");
      afterRank = decoded.rank;
    }
    const docs = await this.repository.listEntries(active.snapshotId, group, {
      afterRank,
      limit: query.limit,
    });
    const page = docs.slice(0, query.limit);
    const hasMore = docs.length > query.limit;
    const last = page[page.length - 1];
    return {
      available: true,
      entries: await this.withIdeas(page),
      nextCursor: hasMore && last ? encodeRankCursor({ rank: last.rank }) : null,
      hasMore,
      snapshotId: active.snapshotId,
      calculatedAt: active.calculatedAt ? active.calculatedAt.toISOString() : null,
      group,
    };
  }

  async position(ideaId: string, query: LeaderboardPositionQuery): Promise<PublicLeaderboardEntry> {
    if (!/^[a-f0-9]{24}$/i.test(ideaId)) throw new IdeaError(404, "IDEA_NOT_FOUND", "Idea not found.");
    const group = await this.resolveGroup(query);
    const active = await this.repository.getActive();
    if (!active) throw new IdeaError(404, "NOT_RANKED", "Idea is not ranked in the selected snapshot.");
    const doc = await this.repository.findPosition(active.snapshotId, group, ideaId);
    if (!doc) throw new IdeaError(404, "NOT_RANKED", "Idea is not ranked in the selected snapshot.");
    const entries = await this.withIdeas([doc]);
    const entry = entries[0];
    if (!entry) throw new IdeaError(404, "NOT_RANKED", "Idea is not ranked in the selected snapshot.");
    return entry;
  }

  async status(): Promise<{
    active: boolean;
    snapshotId: string | null;
    calculatedAt: string | null;
    generation: number | null;
    entryCount: number;
    refreshRunning: boolean;
  }> {
    const active = await this.repository.getActive();
    const running = await this.isRefreshRunning();
    if (!active) {
      return { active: false, snapshotId: null, calculatedAt: null, generation: null, entryCount: 0, refreshRunning: running };
    }
    return {
      active: true,
      snapshotId: active.snapshotId,
      calculatedAt: active.calculatedAt ? active.calculatedAt.toISOString() : null,
      generation: active.generation,
      entryCount: active.entryCount,
      refreshRunning: running,
    };
  }

  private async isRefreshRunning(): Promise<boolean> {
    const lock = await this.locks.peek();
    return !!lock && lock.expiresAt.getTime() > Date.now();
  }

  private async withIdeas(
    docs: Array<{ ideaId: unknown; medianAmount: number; responseCount: number; rank: number }>,
  ): Promise<PublicLeaderboardEntry[]> {
    const ids = [...new Set(docs.map((d) => String(d.ideaId)))];
    const ideas = await this.ideas.find({ _id: { $in: ids } }).lean().exec();
    const byId = new Map(ideas.map((i) => [String(i._id), i]));
    const out: PublicLeaderboardEntry[] = [];
    for (const doc of docs) {
      const idea = byId.get(String(doc.ideaId));
      if (!idea) continue; // idea removed after the snapshot: skip, never fabricate
      out.push({
        rank: doc.rank,
        medianAmount: serializeMedian(doc.medianAmount),
        responseCount: doc.responseCount,
        idea: toIdeaDTO(idea as Parameters<typeof toIdeaDTO>[0]),
      });
    }
    return out;
  }
}
