import type { Request, Response, NextFunction } from "express";
import { LeaderboardService } from "./leaderboard.service.js";
import {
  leaderboardPositionQuerySchema,
  leaderboardQuerySchema,
} from "./leaderboard.validators.js";
import { fail, ok, sendIdeaError } from "../ideas/api-envelope.js";

/** Thin controller: parsing + envelopes here, rules in the service. */
export function createLeaderboardController(service: LeaderboardService = new LeaderboardService()) {
  async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = leaderboardQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      const page = await service.list(parsed.data);
      if (!page.available) {
        ok(res, [], {
          available: false,
          message: "No leaderboard snapshot has been published yet.",
          group: page.group,
        });
        return;
      }
      ok(res, page.entries, {
        limit: parsed.data.limit,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        snapshotId: page.snapshotId,
        calculatedAt: page.calculatedAt,
        group: page.group,
      });
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function position(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const value = req.params.ideaId;
      const ideaId = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
      const parsed = leaderboardPositionQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        fail(res, req, 400, "VALIDATION_ERROR", "The request is invalid.", parsed.error.issues);
        return;
      }
      ok(res, await service.position(ideaId, parsed.data));
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  async function status(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      ok(res, await service.status());
    } catch (err) {
      if (!sendIdeaError(res, req, err)) next(err);
    }
  }

  return { list, position, status };
}
