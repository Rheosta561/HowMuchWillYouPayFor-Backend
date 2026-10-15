import { Router } from "express";
import { createResponseController } from "./response.controller.js";
import { ResponseService } from "./response.service.js";
import { createRequireAuth } from "../auth/middleware/require-auth.js";
import { ipLimiter } from "../auth/auth.routes.js";
import { TokenService } from "../auth/services/token.service.js";
import { UserService } from "../users/user.service.js";
import { env } from "../../config/env.js";

/**
 * Mounted at /v1/ideas BEFORE the idea router (see app.ts): Express matches
 * mounts in registration order, so /:ideaId/responses/* is claimed here and
 * everything else falls through to ideas.
 */
export function createResponseRouter(service: ResponseService = new ResponseService()): Router {
  const router = Router();
  const controller = createResponseController(service);
  const requireAuth = createRequireAuth({ tokens: new TokenService(), users: new UserService() });
  const submitLimiter = ipLimiter(env.RESPONSES_IP_MAX);

  // Static suffix first: Express matches in registration order.
  router.get("/:ideaId/responses/me", requireAuth, controller.myResponseForIdea);
  router.post("/:ideaId/responses", requireAuth, submitLimiter, controller.submit);

  return router;
}

/** Authenticated response history, mounted at /v1/me/responses. */
export function createMyResponsesRouter(service: ResponseService = new ResponseService()): Router {
  const router = Router();
  const controller = createResponseController(service);
  const requireAuth = createRequireAuth({ tokens: new TokenService(), users: new UserService() });

  router.get("/", requireAuth, controller.myResponses);

  return router;
}
