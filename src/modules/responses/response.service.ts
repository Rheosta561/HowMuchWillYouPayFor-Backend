import { ResponseRepository } from "./response.repository.js";
import type { PricingResponseDoc } from "./response.model.js";
import { IdeaError } from "../ideas/api-envelope.js";
import { decodeCursor, encodeCursor } from "../ideas/idea.types.js";
import { toResponseDTO, type PricingResponseDTO } from "./response.types.js";
import type { MyResponsesQuery, SubmitResponseInput } from "./response.validators.js";
import { IdeaModel } from "../ideas/idea.model.js";

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

export interface MyResponsesPage {
  responses: PricingResponseDTO[];
  nextCursor: string | null;
  hasMore: boolean;
}

export class ResponseService {
  constructor(
    private readonly responses: ResponseRepository = new ResponseRepository(),
    private readonly ideas: typeof IdeaModel = IdeaModel,
  ) {}

  async submit(userId: string, ideaId: string, input: SubmitResponseInput): Promise<PricingResponseDTO> {
    const idea = await this.ideas.findOne({ _id: ideaId, status: "published" }).lean().exec();
    if (!idea) throw new IdeaError(404, "IDEA_NOT_FOUND", "Idea not found.");

    // Currency and billing period come from the idea, never the client.
    try {
      const doc = await this.responses.create({
        ideaId,
        userId,
        amount: input.amount,
        currency: idea.pricing.currency,
        billingPeriod: idea.pricing.billingPeriod,
      });
      return toResponseDTO(doc as unknown as PricingResponseDoc & { _id: { toString(): string } });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new IdeaError(409, "DUPLICATE_RESPONSE", "You have already submitted a response for this idea.");
      }
      throw err;
    }
  }

  async myResponseForIdea(userId: string, ideaId: string): Promise<PricingResponseDTO> {
    const idea = await this.ideas.findOne({ _id: ideaId, status: "published" }).lean().exec();
    if (!idea) throw new IdeaError(404, "IDEA_NOT_FOUND", "Idea not found.");
    const doc = await this.responses.findMineByIdea(userId, ideaId);
    if (!doc) throw new IdeaError(404, "RESPONSE_NOT_FOUND", "No response submitted for this idea.");
    return toResponseDTO(doc as unknown as PricingResponseDoc & { _id: { toString(): string } });
  }

  async myResponses(userId: string, query: MyResponsesQuery): Promise<MyResponsesPage> {
    let cursor;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded) throw new IdeaError(400, "VALIDATION_ERROR", "Invalid pagination cursor.");
      cursor = decoded;
    }
    const { docs, hasMore } = await this.responses.findMyPage(userId, {
      ideaId: query.ideaId,
      cursor,
      limit: query.limit,
    });
    const last = docs[docs.length - 1];
    return {
      responses: docs.map((d) => toResponseDTO(d as unknown as PricingResponseDoc & { _id: { toString(): string } })),
      nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), id: String(last._id) }) : null,
      hasMore,
    };
  }
}
