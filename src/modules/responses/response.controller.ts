import type { Request, Response, NextFunction } from "express";
import { ResponseService } from "./response.service.js";
import {
  ideaIdParamSchema,
  myResponsesQuerySchema,
  submitResponseSchema,
} from "./response.validators.js";
import { ok, fail, sendIdeaError } from "../ideas/api-envelope.js";

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Thin controller: parsing + envelopes here, rules in the service. */
export function createResponseController(service: ResponseService = new ResponseService()) {
  async function submit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        fail(res, req, 401, "UNAUTHORIZED", "Authentication required.", []);
        return;
      }
      const params = ideaIdParamSchema.safeParse({ ideaId: pathParam(req, "ideaId") });
      if (!params.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", params.error.issues);
        return;
      }
      const parsed = submitResponseSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      ok(res, await service.submit(userId, params.data.ideaId, parsed.data), {}, 201);
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function myResponseForIdea(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        fail(res, req, 401, "UNAUTHORIZED", "Authentication required.", []);
        return;
      }
      const params = ideaIdParamSchema.safeParse({ ideaId: pathParam(req, "ideaId") });
      if (!params.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", params.error.issues);
        return;
      }
      ok(res, await service.myResponseForIdea(userId, params.data.ideaId));
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function myResponses(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.auth?.userId;
      if (!userId) {
        fail(res, req, 401, "UNAUTHORIZED", "Authentication required.", []);
        return;
      }
      const parsed = myResponsesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      const page = await service.myResponses(userId, parsed.data);
      ok(res, page.responses, {
        limit: parsed.data.limit,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  return { submit, myResponseForIdea, myResponses };
}
