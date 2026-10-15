import { Router } from "express";
import { createLeaderboardController } from "./leaderboard.controller.js";
import { LeaderboardService } from "./leaderboard.service.js";

export function createLeaderboardRouter(service: LeaderboardService = new LeaderboardService()): Router {
  const router = Router();
  const controller = createLeaderboardController(service);

  router.get("/", controller.list);
  router.get("/status", controller.status);
  router.get("/ideas/:ideaId", controller.position);

  return router;
}
