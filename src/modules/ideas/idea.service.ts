import { IdeaRepository, type IdeaFilter } from "./idea.repository.js";
import type { IdeaDoc } from "./idea.model.js";
import { IdeaError } from "./api-envelope.js";
import { decodeCursor, encodeCursor, toIdeaDTO, type IdeaDTO } from "./idea.types.js";
import type {
  CreateIdeaInput,
  ListIdeasQuery,
  MyIdeasQuery,
  NavigationQuery,
} from "./idea.validators.js";
import { CategoryService } from "../categories/category.service.js";
import { LocationService } from "../locations/location.service.js";
import { normalizeCategorySlug } from "../categories/category.model.js";

export interface IdeaPage {
  ideas: IdeaDTO[];
  nextCursor: string | null;
  hasMore: boolean;
}

function toDTOs(docs: IdeaDoc[]): IdeaDTO[] {
  return docs.map((d) => toIdeaDTO(d as IdeaDoc & { _id: { toString(): string } }));
}

export class IdeaService {
  constructor(
    private readonly ideas: IdeaRepository = new IdeaRepository(),
    private readonly categories: CategoryService = new CategoryService(),
    private readonly locations: LocationService = new LocationService(),
  ) {}

  /**
   * Visibility rule (documented contract):
   * - scope=global filter: every published idea, no location constraint.
   * - scope=country (code X): global ideas plus ideas targeted at X
   *   (country-scoped with countryCode X, or city-scoped whose stored
   *   countryCode is X).
   * - scope=city (country X, city Y): global ideas, country-scoped ideas of
   *   X, and the city-scoped idea Y itself.
   */
  private locationClauses(scope: string, country?: string, cityId?: string): IdeaFilter | undefined {
    if (scope === "global") return undefined;
    if (scope === "country") {
      return {
        $or: [
          { "targetMarket.scope": "global" },
          { "targetMarket.scope": "country", "targetMarket.countryCode": country },
          { "targetMarket.scope": "city", "targetMarket.countryCode": country },
        ],
      };
    }
    return {
      $or: [
        { "targetMarket.scope": "global" },
        { "targetMarket.scope": "country", "targetMarket.countryCode": country },
        { "targetMarket.cityId": cityId as unknown as IdeaDoc["targetMarket"]["cityId"] },
      ],
    };
  }

  private async resolveListingFilter(query: ListIdeasQuery | NavigationQuery): Promise<{
    category?: string;
    location?: IdeaFilter;
  }> {
    let category: string | undefined;
    if (query.category) {
      const slug = normalizeCategorySlug(query.category);
      const found = await this.categories.findActiveBySlug(slug);
      if (!found) throw new IdeaError(400, "UNKNOWN_CATEGORY", `Unknown category: ${slug}.`);
      category = found.slug;
    }

    let location: IdeaFilter | undefined;
    if (query.scope === "country") {
      if (!query.country) throw new IdeaError(400, "VALIDATION_ERROR", "Country filter requires a country code.");
      const country = await this.locations.findActiveCountry(query.country);
      if (!country) throw new IdeaError(404, "COUNTRY_NOT_FOUND", "Country not found.");
      location = this.locationClauses(query.scope, country._id);
    } else if (query.scope === "city") {
      if (!query.country || !query.cityId) {
        throw new IdeaError(400, "VALIDATION_ERROR", "City filter requires a country code and a cityId.");
      }
      const country = await this.locations.findActiveCountry(query.country);
      if (!country) throw new IdeaError(404, "COUNTRY_NOT_FOUND", "Country not found.");
      const city = await this.locations.findActiveCityById(query.cityId);
      if (!city) throw new IdeaError(404, "CITY_NOT_FOUND", "City not found.");
      if (city.countryCode !== country._id) {
        throw new IdeaError(400, "CITY_COUNTRY_MISMATCH", "The city does not belong to the given country.");
      }
      location = this.locationClauses(query.scope, country._id, String(city._id));
    } else if (query.country || query.cityId) {
      throw new IdeaError(400, "VALIDATION_ERROR", "Country/city parameters require scope=country or scope=city.");
    }
    return { category, location };
  }

  async listIdeas(query: ListIdeasQuery): Promise<IdeaPage> {
    if (query.sort === "popular") {
      // No popularity statistics exist yet (leaderboard module is out of
      // scope). Explicit error instead of invented scores.
      throw new IdeaError(
        400,
        "POPULAR_SORT_UNAVAILABLE",
        "Sorting by popularity is not available yet. Use sort=newest.",
      );
    }
    const filter = await this.resolveListingFilter(query);
    let cursor;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded) throw new IdeaError(400, "VALIDATION_ERROR", "Invalid pagination cursor.");
      cursor = decoded;
    }
    const { docs, hasMore } = await this.ideas.findPublishedPage(filter, { cursor, limit: query.limit });
    const last = docs[docs.length - 1];
    return {
      ideas: toDTOs(docs),
      nextCursor:
        hasMore && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: String(last._id) })
          : null,
      hasMore,
    };
  }

  async getPublishedIdea(id: string): Promise<IdeaDTO> {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new IdeaError(404, "IDEA_NOT_FOUND", "Idea not found.");
    const doc = await this.ideas.findPublishedById(id);
    if (!doc) throw new IdeaError(404, "IDEA_NOT_FOUND", "Idea not found.");
    return toIdeaDTO(doc as IdeaDoc & { _id: { toString(): string } });
  }

  async createIdea(creatorId: string, input: CreateIdeaInput): Promise<IdeaDTO> {
    const category = await this.categories.requireActiveBySlug(
      normalizeCategorySlug(input.category),
      class extends IdeaError {
        constructor(slug: string) {
          super(400, "UNKNOWN_CATEGORY", `Unknown category: ${slug}.`);
        }
      },
    );

    // Referential location checks before saving.
    const tm = input.targetMarket;
    if (tm.scope === "country" || tm.scope === "city") {
      const country = await this.locations.findActiveCountry(tm.countryCode!);
      if (!country) throw new IdeaError(404, "COUNTRY_NOT_FOUND", "Country not found.");
    }
    if (tm.scope === "city") {
      const city = await this.locations.findActiveCityById(tm.cityId!);
      if (!city) throw new IdeaError(404, "CITY_NOT_FOUND", "City not found.");
      if (city.countryCode !== tm.countryCode) {
        throw new IdeaError(400, "CITY_COUNTRY_MISMATCH", "The city does not belong to the given country.");
      }
    }

    const doc = await this.ideas.create({
      creatorId: creatorId as unknown as IdeaDoc["creatorId"],
      title: input.title,
      pitch: input.pitch,
      abstract: input.abstract,
      category: category.slug,
      tags: [...new Set(input.tags)],
      targetMarket: {
        scope: tm.scope,
        countryCode: tm.countryCode,
        cityId: (tm.cityId as unknown as IdeaDoc["targetMarket"]["cityId"]) ?? null,
      },
      pricing: { currency: input.pricing.currency, billingPeriod: input.pricing.billingPeriod },
      // Status is service-owned: MVP ideas publish immediately.
      status: "published",
    });
    return toIdeaDTO(doc as unknown as IdeaDoc & { _id: { toString(): string } });
  }

  async navigation(
    id: string,
    query: NavigationQuery,
  ): Promise<{ previousId: string | null; currentId: string; nextId: string | null }> {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new IdeaError(404, "IDEA_NOT_FOUND", "Idea not found.");
    const current = await this.ideas.findPublishedById(id);
    if (!current) throw new IdeaError(404, "IDEA_NOT_FOUND", "Idea not found.");
    if (query.sort === "popular") {
      throw new IdeaError(400, "POPULAR_SORT_UNAVAILABLE", "Sorting by popularity is not available yet.");
    }
    const filter = await this.resolveListingFilter(query);
    // A published idea outside the selected filters has no neighbors here.
    const visible = await this.ideas.matchesPublishedFilter(id, filter);
    if (!visible) throw new IdeaError(404, "IDEA_NOT_IN_FILTER", "Idea is not part of the selected filters.");
    const anchor = { createdAt: current.createdAt, id: String(current._id) };
    const [prev, next] = await Promise.all([
      this.ideas.findNeighbor(filter, anchor, "newer"),
      this.ideas.findNeighbor(filter, anchor, "older"),
    ]);
    return {
      previousId: prev ? String(prev._id) : null,
      currentId: String(current._id),
      nextId: next ? String(next._id) : null,
    };
  }

  async myIdeas(creatorId: string, query: MyIdeasQuery): Promise<IdeaPage> {
    let cursor;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded) throw new IdeaError(400, "VALIDATION_ERROR", "Invalid pagination cursor.");
      cursor = decoded;
    }
    const { docs, hasMore } = await this.ideas.findByCreatorPage(creatorId, {
      status: query.status,
      cursor,
      limit: query.limit,
    });
    const last = docs[docs.length - 1];
    return {
      ideas: toDTOs(docs),
      nextCursor:
        hasMore && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: String(last._id) })
          : null,
      hasMore,
    };
  }
}
