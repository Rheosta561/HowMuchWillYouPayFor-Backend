import type { Types } from "mongoose";
import { PricingResponseModel, type PricingResponseDoc } from "./response.model.js";
import type { IdeaCursor } from "../ideas/idea.types.js";

export type ResponseFilter = Record<string, unknown>;

function cursorCondition(cursor: IdeaCursor): ResponseFilter {
  const t = new Date(cursor.t);
  return {
    $or: [{ createdAt: { $lt: t } }, { createdAt: t, _id: { $lt: cursor.id as unknown as Types.ObjectId } }],
  };
}

const NEWEST_SORT = { createdAt: -1 as const, _id: -1 as const };

export class ResponseRepository {
  constructor(private readonly model: typeof PricingResponseModel = PricingResponseModel) {}

  /** Throws a Mongo duplicate-key error (code 11000) on repeat submissions. */
  async create(data: {
    ideaId: string;
    userId: string;
    amount: number;
    currency: string;
    billingPeriod: PricingResponseDoc["billingPeriod"];
  }) {
    const doc = await this.model.create({
      ideaId: data.ideaId as unknown as Types.ObjectId,
      userId: data.userId as unknown as Types.ObjectId,
      amount: data.amount,
      currency: data.currency,
      billingPeriod: data.billingPeriod,
    });
    return doc.toObject();
  }

  async findMineByIdea(userId: string, ideaId: string) {
    return this.model.findOne({ userId, ideaId }).lean().exec();
  }

  async findMyPage(
    userId: string,
    opts: { ideaId?: string; cursor?: IdeaCursor; limit: number },
  ): Promise<{ docs: PricingResponseDoc[]; hasMore: boolean }> {
    const clauses: ResponseFilter[] = [{ userId: userId as unknown as Types.ObjectId }];
    if (opts.ideaId) clauses.push({ ideaId: opts.ideaId as unknown as Types.ObjectId });
    if (opts.cursor) clauses.push(cursorCondition(opts.cursor));
    const query = clauses.length === 1 ? clauses[0]! : { $and: clauses };
    const docs = await this.model.find(query).sort(NEWEST_SORT).limit(opts.limit + 1).lean().exec();
    return { docs: docs.slice(0, opts.limit), hasMore: docs.length > opts.limit };
  }
}
