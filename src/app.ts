import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { createAuthRouter, type AuthRouterOptions } from "./modules/auth/auth.routes.js";
import { createIdeaRouter, createMeRouter } from "./modules/ideas/idea.routes.js";
import { createResponseRouter, createMyResponsesRouter } from "./modules/responses/response.routes.js";
import { createCategoryRouter } from "./modules/categories/category.routes.js";
import { createLocationRouter } from "./modules/locations/location.routes.js";
import { createLeaderboardRouter } from "./modules/leaderboard/leaderboard.routes.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { AuthError } from "./modules/auth/auth.errors.js";
import { env } from "./config/env.js";

export interface AppOptions extends AuthRouterOptions {
  /** Explicit frontend origin allowlist. Defaults to FRONTEND_ORIGINS. */
  frontendOrigins?: string[];
}

export function parseFrontendOrigins(): string[] {
  return env.FRONTEND_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createApp(opts: AppOptions = {}): express.Express {
  const app = express();
  app.use(helmet());
  app.use(cookieParser());

  // Explicit allowlist: browser origins must match; non-browser requests
  // without an Origin header are unaffected. Credentials (cookies) are only
  // ever sent to allowlisted origins.
  const allowlist = opts.frontendOrigins ?? parseFrontendOrigins();
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowlist.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS origin not allowed"));
      },
      credentials: true,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", env.AUTH_CSRF_HEADER],
    }),
  );

  app.use(express.json({ limit: "100kb" }));
  app.use(requestIdMiddleware);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true, service: "howmuchwillyoupayfor" });
  });

  // Canonical versioned API.
  app.use("/v1/auth", createAuthRouter(opts));
  // Legacy prefix; same router (includes legacy path aliases).
  app.use("/api/auth", createAuthRouter(opts));

  // Ideas surface. The categories mount precedes /v1/ideas so that
  // GET /v1/ideas/categories is served by the category router.
  app.use("/v1/ideas/categories", createCategoryRouter());
  // The responses mount precedes /v1/ideas so that
  // /:ideaId/responses/* is claimed before /:id.
  app.use("/v1/ideas", createResponseRouter());
  app.use("/v1/ideas", createIdeaRouter());
  app.use("/v1/locations", createLocationRouter());
  app.use("/v1/me/ideas", createMeRouter());
  app.use("/v1/me/responses", createMyResponsesRouter());
  app.use("/v1/leaderboard", createLeaderboardRouter());

  // Zod + auth error mapping. Must be last.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ code: err.code, message: err.message });
      return;
    }
    if (typeof err === "object" && err !== null && "issues" in err) {
      res.status(400).json({ code: "VALIDATION_ERROR", message: "Invalid request", issues: (err as { issues: unknown }).issues });
      return;
    }
    console.error(err);
    res.status(500).json({ code: "INTERNAL_ERROR", message: "Internal server error" });
  });

  return app;
}
