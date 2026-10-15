import type { Request, Response, NextFunction } from "express";
import { IdeaService } from "./idea.service.js";
import {
  createIdeaSchema,
  listIdeasQuerySchema,
  myIdeasQuerySchema,
  navigationQuerySchema,
} from "./idea.validators.js";
import { ok, fail, sendIdeaError } from "./api-envelope.js";

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Thin controller: parsing + envelopes here, rules in the service. */
export function createIdeaController(service: IdeaService = new IdeaService()) {
  async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = listIdeasQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      const page = await service.listIdeas(parsed.data);
      ok(res, page.ideas, { limit: parsed.data.limit, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      ok(res, await service.getPublishedIdea(pathParam(req, "id")));
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function navigation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = navigationQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      ok(res, await service.navigation(pathParam(req, "id"), parsed.data));
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const creatorId = req.auth?.userId;
      if (!creatorId) {
        fail(res, req, 401, "UNAUTHORIZED", "Authentication required.", []);
        return;
      }
      // Explicit whitelist: creatorId/status/timestamps can never be mass
      // assigned — they are not part of the schema at all.
      const parsed = createIdeaSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      ok(res, await service.createIdea(creatorId, parsed.data), {}, 201);
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function myIdeas(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const creatorId = req.auth?.userId;
      if (!creatorId) {
        fail(res, req, 401, "UNAUTHORIZED", "Authentication required.", []);
        return;
      }
      const parsed = myIdeasQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      const page = await service.myIdeas(creatorId, parsed.data);
      ok(res, page.ideas, { limit: parsed.data.limit, nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  return { list, getById, navigation, create, myIdeas };
}
