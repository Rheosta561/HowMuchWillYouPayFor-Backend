import { describe, it, expect } from "vitest";
import type { Express } from "express";
import { createApp } from "../../../app.js";

/** Walk the Express stack and return "METHOD /mount/path" entries with handler counts. */
function appStack(app: Express): unknown[] {
  const a = app as unknown as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
  return a.router?.stack ?? a._router?.stack ?? [];
}

interface StackLayer {
  name?: string;
  handle?: { stack?: unknown[] };
  route?: { path: string; methods: Record<string, boolean>; stack: unknown[] };
}

function collectRoutes(app: Express): { route: string; handlers: number }[] {
  const out: { route: string; handlers: number }[] = [];
  // Mount layers appear in app.use() order (mirrors app.ts).
  const mounts = [
    "/v1/auth",
    "/api/auth",
    "/v1/ideas/categories",
    "/v1/ideas",
    "/v1/ideas",
    "/v1/locations",
    "/v1/me/ideas",
    "/v1/me/responses",
  ];
  let mountIdx = 0;
  for (const layer of appStack(app) as StackLayer[]) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => m !== "_all");
      for (const m of methods) out.push({ route: `${m.toUpperCase()} ${layer.route.path}`, handlers: layer.route.stack.length });
      continue;
    }
    const inner = layer.handle?.stack;
    if (!inner || mountIdx >= mounts.length) continue;
    const mount = mounts[mountIdx]!;
    mountIdx += 1;
    for (const sub of inner) {
      const s = sub as StackLayer;
      if (!s.route) continue;
      for (const m of Object.keys(s.route.methods).filter((m) => m !== "_all")) {
        const full = `${mount}${s.route.path}`.replace(/\/$/, "") || "/";
        out.push({ route: `${m.toUpperCase()} ${full}`, handlers: s.route.stack.length });
      }
    }
  }
  return out;
}

function layerNames(app: Express): { name: string; isError: boolean }[] {
  const stack = appStack(app);
  return stack.map((layer) => {
    const l = layer as { handle?: (...args: unknown[]) => unknown; name?: string };
    const fn = l.handle ?? (() => {});
    return { name: (fn as { name?: string }).name ?? l.name ?? "anonymous", isError: fn.length === 4 };
  });
}

describe("route registration", () => {
  const app = createApp();
  const routes = collectRoutes(app);
  const paths = new Set(routes.map((r) => r.route));

  it.each([
    "POST /v1/auth/signup",
    "POST /v1/auth/login",
    "POST /v1/auth/email/otp/request",
    "POST /v1/auth/email/otp/verify",
    "POST /v1/auth/google",
    "POST /v1/auth/google/callback",
    "POST /v1/auth/refresh",
    "POST /v1/auth/logout",
    "POST /v1/auth/logout-all",
    "GET /v1/auth/sessions",
    "DELETE /v1/auth/sessions/:sessionId",
    "POST /api/auth/email-otp/request",
    "POST /api/auth/email-otp/verify",
    "POST /v1/ideas/:ideaId/responses",
    "GET /v1/ideas/:ideaId/responses/me",
    "GET /v1/me/responses",
  ])("registers %s", (route) => {
    expect(paths.has(route)).toBe(true);
  });

  it("wires rate limiters on OTP/Google/refresh routes and auth on protected routes", () => {
    const byRoute = new Map(routes.map((r) => [r.route, r.handlers]));
    // limiter + validate + handler
    for (const r of [
      "POST /v1/auth/email/otp/request",
      "POST /v1/auth/email/otp/verify",
      "POST /v1/auth/google",
      "POST /v1/auth/refresh",
    ]) {
      expect(byRoute.get(r)).toBeGreaterThanOrEqual(3);
    }
    // requireAuth + handler
    for (const r of ["POST /v1/auth/logout-all", "GET /v1/auth/sessions", "DELETE /v1/auth/sessions/:sessionId"]) {
      expect(byRoute.get(r)).toBeGreaterThanOrEqual(2);
    }
    // Response submit: requireAuth + limiter + handler; idea detail untouched.
    expect(byRoute.get("POST /v1/ideas/:ideaId/responses")).toBeGreaterThanOrEqual(3);
    expect(byRoute.get("GET /v1/ideas/:ideaId/responses/me")).toBeGreaterThanOrEqual(2);
    expect(byRoute.get("GET /v1/ideas/:id")).toBe(1);
    // logout resolves its own credential: no access-token gate
    expect(byRoute.get("POST /v1/auth/logout")).toBe(1);
  });

  it("serves both mounts behaviorally", async () => {
    const { default: request } = await import("supertest");
    // Empty body fails Zod validation on both mounts: proves both routers serve.
    expect((await request(app).post("/v1/auth/google").send({})).status).toBe(400);
    expect((await request(app).post("/api/auth/google").send({})).status).toBe(400);
    // Protected routes gate on the access token on both mounts.
    expect((await request(app).get("/v1/auth/sessions")).status).toBe(401);
    expect((await request(app).get("/api/auth/sessions")).status).toBe(401);
  });
  it("orders middleware: parsers before routes, error handler last", () => {
    const layers = layerNames(app);
    const errorIdx = layers.map((l) => l.isError).lastIndexOf(true);
    expect(errorIdx).toBe(layers.length - 1);

    const names = layers.map((l) => l.name);
    const jsonIdx = names.indexOf("jsonParser");
    const cookieIdx = names.indexOf("cookieParser");
    const firstMount = layers.findIndex(
      (l) => l.name === "router" || l.name === "<anonymous>",
    );
    expect(jsonIdx).toBeGreaterThanOrEqual(0);
    expect(cookieIdx).toBeGreaterThanOrEqual(0);
    expect(firstMount).toBeGreaterThan(Math.max(jsonIdx, cookieIdx));
    expect(firstMount).toBeLessThan(errorIdx);
  });
});
