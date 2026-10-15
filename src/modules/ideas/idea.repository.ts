import type { Types } from "mongoose";
import { IdeaModel, type IdeaDoc } from "./idea.model.js";
import type { IdeaCursor } from "./idea.types.js";

/** Plain-object Mongo filter (built programmatically from validated enums only). */
export type IdeaFilter = Record<string, unknown>;

export interface PublishedFilter {
  category?: string;
  /** Extra location clauses combined with $and (already validated). */
  location?: IdeaFilter;
}

function cursorCondition(cursor: IdeaCursor): IdeaFilter {
  const t = new Date(cursor.t);
  return {
    $or: [
      { createdAt: { $lt: t } },
      { createdAt: t, _id: { $lt: cursor.id as unknown as Types.ObjectId } },
    ],
  };
}

export function buildPublishedFilter(filter: PublishedFilter): IdeaFilter {
  const clauses: IdeaFilter[] = [{ status: "published" }];
  if (filter.category) clauses.push({ category: filter.category });
  if (filter.location) clauses.push(filter.location);
  return clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

const NEWEST_SORT = { createdAt: -1 as const, _id: -1 as const };

export class IdeaRepository {
  constructor(private readonly model: typeof IdeaModel = IdeaModel) {}

  async create(data: Omit<IdeaDoc, "_id" | "createdAt" | "updatedAt">) {
    const doc = await this.model.create(data);
    return doc.toObject();
  }

  async findPublishedPage(
    filter: PublishedFilter,
    opts: { cursor?: IdeaCursor; limit: number },
  ): Promise<{ docs: IdeaDoc[]; hasMore: boolean }> {
    const clauses: IdeaFilter[] = [buildPublishedFilter(filter)];
    if (opts.cursor) clauses.push(cursorCondition(opts.cursor));
    const query = clauses.length === 1 ? clauses[0]! : { $and: clauses };
    const docs = await this.model.find(query).sort(NEWEST_SORT).limit(opts.limit + 1).lean().exec();
    return { docs: docs.slice(0, opts.limit), hasMore: docs.length > opts.limit };
  }

  async findPublishedById(id: string) {
    return this.model.findOne({ _id: id, status: "published" }).lean().exec();
  }

  async matchesPublishedFilter(id: string, filter: PublishedFilter): Promise<boolean> {
    const base = buildPublishedFilter(filter);
    const found = await this.model.findOne({ $and: [base, { _id: id }] }).select("_id").lean().exec();
    return found !== null;
  }

  /** Neighbor in newest ordering without loading the result set. */
  async findNeighbor(
    filter: PublishedFilter,
    anchor: { createdAt: Date; id: string },
    direction: "newer" | "older",
  ) {
    const comparison =
      direction === "newer"
        ? {
            $or: [
              { createdAt: { $gt: anchor.createdAt } },
              { createdAt: anchor.createdAt, _id: { $gt: anchor.id as unknown as Types.ObjectId } },
            ],
          }
        : {
            $or: [
              { createdAt: { $lt: anchor.createdAt } },
              { createdAt: anchor.createdAt, _id: { $lt: anchor.id as unknown as Types.ObjectId } },
            ],
          };
    const sort = direction === "newer" ? { createdAt: 1 as const, _id: 1 as const } : NEWEST_SORT;
    const base = buildPublishedFilter(filter);
    return this.model
      .findOne({ $and: [base, comparison] })
      .sort(sort)
      .select("_id")
      .lean()
      .exec();
  }

  async findByCreatorPage(
    creatorId: string,
    opts: { status?: "published" | "archived"; cursor?: IdeaCursor; limit: number },
  ): Promise<{ docs: IdeaDoc[]; hasMore: boolean }> {
    const clauses: IdeaFilter[] = [{ creatorId: creatorId as unknown as Types.ObjectId }];
    if (opts.status) clauses.push({ status: opts.status });
    if (opts.cursor) clauses.push(cursorCondition(opts.cursor));
    const query = clauses.length === 1 ? clauses[0]! : { $and: clauses };
    const docs = await this.model.find(query).sort(NEWEST_SORT).limit(opts.limit + 1).lean().exec();
    return { docs: docs.slice(0, opts.limit), hasMore: docs.length > opts.limit };
  }
}
