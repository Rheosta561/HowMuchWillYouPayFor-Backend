import { Router } from "express";
import { createIdeaController } from "./idea.controller.js";
import { IdeaService } from "./idea.service.js";
import { createRequireAuth } from "../auth/middleware/require-auth.js";
import { TokenService } from "../auth/services/token.service.js";
import { UserService } from "../users/user.service.js";

export function createIdeaRouter(service: IdeaService = new IdeaService()): Router {
  const router = Router();
  const controller = createIdeaController(service);
  const requireAuth = createRequireAuth({ tokens: new TokenService(), users: new UserService() });

  // Note: /categories is served by the category router, which the
  // application mounts before this router (see app.ts).
  router.post("/", requireAuth, controller.create);
  router.get("/", controller.list);
  router.get("/:id/navigation", controller.navigation);
  router.get("/:id", controller.getById);

  return router;
}

/** Authenticated personal history, mounted at /v1/me/ideas. */
export function createMeRouter(service: IdeaService = new IdeaService()): Router {
  const router = Router();
  const controller = createIdeaController(service);
  const requireAuth = createRequireAuth({ tokens: new TokenService(), users: new UserService() });

  router.get("/", requireAuth, controller.myIdeas);

  return router;
}
