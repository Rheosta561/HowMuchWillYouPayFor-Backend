import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import jwt from "jsonwebtoken";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Express } from "express";
import { createApp } from "../../../app.js";
import { createDefaultAuthService } from "../auth.service.js";
import { TokenService } from "../services/token.service.js";
import { SessionService, hashToken } from "../services/session.service.js";
import { RefreshSessionModel } from "../models/refresh-session.model.js";
import { UserModel } from "../../users/user.model.js";
import { UserService } from "../../users/user.service.js";
import { env } from "../../../config/env.js";

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

let mongodProc: ChildProcess | null = null;
let tmpDbPath: string | null = null;

async function tryConnect(uri: string): Promise<boolean> {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureMongo(): Promise<void> {
  const uri = `mongodb://127.0.0.1:27017/sessions_int_${process.pid}`;
  if (await tryConnect(uri)) return;
  await mongoose.disconnect().catch(() => {});
  tmpDbPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hmwyp-mongo-"));
  mongodProc = spawn("mongod", ["--port", "27099", "--dbpath", tmpDbPath, "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const fallback = "mongodb://127.0.0.1:27099/sessions_int";
  for (let i = 0; i < 50; i += 1) {
    if (await tryConnect(fallback)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Could not connect to MongoDB and could not start ephemeral mongod");
}

beforeAll(async () => {
  await ensureMongo();
  await UserModel.ensureIndexes();
  await RefreshSessionModel.ensureIndexes();
}, 120000);

afterAll(async () => {
  await mongoose.connection.db?.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  if (mongodProc) {
    mongodProc.kill("SIGTERM");
    mongodProc = null;
  }
  if (tmpDbPath) {
    await fs.promises.rm(tmpDbPath, { recursive: true, force: true }).catch(() => {});
    tmpDbPath = null;
  }
}, 60000);

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}).exec(),
    RefreshSessionModel.deleteMany({}).exec(),
  ]);
});

const users = new UserService();
const tokens = new TokenService();
const sessions = new SessionService();
const app: Express = createApp({ users, tokens, sessions });

async function createUser(email: string, status: "active" | "suspended" = "active") {
  return UserModel.create({
    email,
    emailNormalized: email.toLowerCase(),
    status,
    role: "user",
    providers: [],
  });
}

async function login(email = "user@example.com") {
  const user = await createUser(email);
  const accessToken = tokens.issueAccessToken(user.id, user.role);
  const session = await sessions.createSession({ userId: user.id, provider: "google" });
  return { user, accessToken, refreshToken: session.refreshToken };
}

function cookiesFrom(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return (raw ?? []).map((c) => c.split(";")[0]).join("; ");
}

function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const found = (raw ?? []).find((c) => c.startsWith(`${name}=`));
  return found?.split(";")[0]?.slice(name.length + 1);
}

/* ------------------------------------------------------------------ */
/* Access-token middleware                                             */
/* ------------------------------------------------------------------ */

describe("access-token middleware", () => {
  it("rejects expired tokens with 401", async () => {
    const { user } = await login();
    const expired = jwt.sign({ sub: user.id, role: "user" }, env.JWT_ACCESS_SECRET, {
      expiresIn: -10,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    const res = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });

  it("rejects invalid signatures with 401", async () => {
    const { user } = await login();
    const forged = jwt.sign({ sub: user.id, role: "user" }, "wrong-secret", {
      expiresIn: 900,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    const res = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });

  it("rejects wrong issuer/audience", async () => {
    const { user } = await login();
    const wrongAud = jwt.sign({ sub: user.id, role: "user" }, env.JWT_ACCESS_SECRET, {
      expiresIn: 900,
      issuer: env.JWT_ISSUER,
      audience: "someone-else",
    });
    const res = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${wrongAud}`);
    expect(res.status).toBe(401);
  });

  it("rejects missing credentials consistently", async () => {
    const res = await request(app).get("/v1/auth/sessions");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_TOKEN");
  });

  it("rejects suspended users even with a valid token", async () => {
    const user = await createUser("gone@example.com", "suspended");
    const accessToken = tokens.issueAccessToken(user.id, user.role);
    const res = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Refresh + rotation + replay                                         */
/* ------------------------------------------------------------------ */

describe("POST /v1/auth/refresh", () => {
  it("rotates successfully and retires the old token", async () => {
    const { refreshToken } = await login();
    const res = await request(app).post("/v1/auth/refresh").send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.refreshToken).not.toBe(refreshToken);

    const oldDoc = await RefreshSessionModel.findOne({ tokenHash: hashToken(refreshToken) }).exec();
    const newDoc = await RefreshSessionModel.findOne({ tokenHash: hashToken(res.body.refreshToken) }).exec();
    expect(oldDoc!.revokedAt).not.toBeNull();
    expect(oldDoc!.replacedByHash).toBe(hashToken(res.body.refreshToken));
    expect(newDoc!.familyId).toBe(oldDoc!.familyId);
    expect(newDoc!.rotatedFromHash).toBe(oldDoc!.tokenHash);
  });

  it("returns 401 for unknown tokens and empty bodies", async () => {
    expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: "nope" })).status).toBe(401);
    expect((await request(app).post("/v1/auth/refresh").send({})).status).toBe(401);
  });

  it("treats an in-leeway retry as transient 401 without punishing the family", async () => {
    const { refreshToken } = await login();
    const first = await request(app).post("/v1/auth/refresh").send({ refreshToken });
    expect(first.status).toBe(200);

    const retry = await request(app).post("/v1/auth/refresh").send({ refreshToken });
    expect(retry.status).toBe(401);
    expect(retry.body.code).toBe("INVALID_REFRESH_TOKEN");

    // The legitimate replacement still works: no family revocation happened.
    const followUp = await request(app).post("/v1/auth/refresh").send({ refreshToken: first.body.refreshToken });
    expect(followUp.status).toBe(200);
  });

  it("detects replay after the leeway window and revokes the family", async () => {
    const { refreshToken } = await login();
    const first = await request(app).post("/v1/auth/refresh").send({ refreshToken });
    expect(first.status).toBe(200);

    // Age the rotation past the leeway window.
    await RefreshSessionModel.updateOne(
      { tokenHash: hashToken(refreshToken) },
      { $set: { revokedAt: new Date(Date.now() - 60_000) } },
    ).exec();

    const replay = await request(app).post("/v1/auth/refresh").send({ refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("REFRESH_TOKEN_REUSED");

    // The replacement is dead too: the whole family was revoked.
    const after = await request(app).post("/v1/auth/refresh").send({ refreshToken: first.body.refreshToken });
    expect(after.status).toBe(401);
    expect(await RefreshSessionModel.countDocuments({ revokedAt: null }).exec()).toBe(0);
  });

  it("lets exactly one concurrent refresh win", async () => {
    const { refreshToken } = await login();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => request(app).post("/v1/auth/refresh").send({ refreshToken })),
    );
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : -1));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);

    const winner = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .find((v) => v?.status === 200);
    const next = await request(app).post("/v1/auth/refresh").send({ refreshToken: winner!.body.refreshToken });
    expect(next.status).toBe(200);
    expect(await RefreshSessionModel.countDocuments({ revokedAt: null }).exec()).toBe(1);
  }, 60000);
});

/* ------------------------------------------------------------------ */
/* Logout                                                              */
/* ------------------------------------------------------------------ */

describe("logout", () => {
  it("revokes the current session family on logout", async () => {
    const { accessToken, refreshToken } = await login();
    const res = await request(app).post("/v1/auth/logout").send({ refreshToken });
    expect(res.status).toBe(200);

    expect((await request(app).post("/v1/auth/refresh").send({ refreshToken })).status).toBe(401);

    // Access token is stateless, but the session shows revoked.
    const list = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0].revokedAt).not.toBeNull();
  });

  it("is idempotent for unknown tokens", async () => {
    const res = await request(app).post("/v1/auth/logout").send({ refreshToken: "unknown" });
    expect(res.status).toBe(200);
  });

  it("revokes all sessions on logout-all", async () => {
    const first = await login("multi@example.com");
    const secondSession = await sessions.createSession({ userId: first.user.id, provider: "google" });

    const res = await request(app)
      .post("/v1/auth/logout-all")
      .set("Authorization", `Bearer ${first.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(2);

    expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: first.refreshToken })).status).toBe(401);
    expect((await request(app).post("/v1/auth/refresh").send({ refreshToken: secondSession.refreshToken })).status).toBe(401);
  });

  it("requires authentication for logout-all", async () => {
    expect((await request(app).post("/v1/auth/logout-all")).status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Session listing + revocation                                        */
/* ------------------------------------------------------------------ */

describe("sessions", () => {
  it("lists only the caller's sessions without token hashes", async () => {
    const { accessToken } = await login("me@example.com");
    await login("other@example.com");

    const res = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).toHaveProperty("id");
    expect(res.body.sessions[0]).toHaveProperty("provider");
    expect(res.body.sessions[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(res.body)).not.toContain("tokenHash");
  });

  it("revokes an owned session and 404s otherwise", async () => {
    const { accessToken, refreshToken } = await login("owner@example.com");
    const other = await login("stranger@example.com");

    const list = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${accessToken}`);
    const sessionId = list.body.sessions[0].id as string;

    const del = await request(app).delete(`/v1/auth/sessions/${sessionId}`).set("Authorization", `Bearer ${accessToken}`);
    expect(del.status).toBe(200);
    expect((await request(app).post("/v1/auth/refresh").send({ refreshToken })).status).toBe(401);

    const otherList = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${other.accessToken}`);
    const foreign = await request(app)
      .delete(`/v1/auth/sessions/${otherList.body.sessions[0].id}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(foreign.status).toBe(404);

    expect((await request(app).delete("/v1/auth/sessions/not-an-id").set("Authorization", `Bearer ${accessToken}`)).status).toBe(404);
    expect(
      (await request(app).delete("/v1/auth/sessions/000000000000000000000000").set("Authorization", `Bearer ${accessToken}`)).status,
    ).toBe(404);
  });

  it("supports multiple active sessions per user", async () => {
    const { user, accessToken } = await login("devices@example.com");
    await sessions.createSession({ userId: user.id, provider: "email-otp" });
    const res = await request(app).get("/v1/auth/sessions").set("Authorization", `Bearer ${accessToken}`);
    expect(res.body.sessions).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Cookie delivery + CSRF + CORS                                       */
/* ------------------------------------------------------------------ */

describe("cookie delivery, CSRF, and CORS", () => {
  it("sets HttpOnly refresh + CSRF cookies on login and refreshes via cookie", async () => {
    const authService = createDefaultAuthService({
      verifyGoogleIdToken: async () => ({ sub: "cookie-sub", email: "cookie@example.com", emailVerified: true }),
    });
    const cookieApp: Express = createApp({ users, tokens, sessions, tokenDelivery: "cookie", authService });

    const loginRes = await request(cookieApp).post("/v1/auth/google").send({ idToken: "t" });
    expect(loginRes.status).toBe(201);
    expect(loginRes.body).not.toHaveProperty("refreshToken");
    const setCookies = (loginRes.headers["set-cookie"] as unknown as string[]).join("\n");
    expect(setCookies).toMatch(/httponly/i);

    const cookies = cookiesFrom(loginRes);
    const csrf = cookieValue(loginRes, env.AUTH_CSRF_COOKIE_NAME);
    expect(csrf).toBeDefined();

    // Missing CSRF header -> 403 even with a valid cookie.
    const noCsrf = await request(cookieApp).post("/v1/auth/refresh").set("Cookie", cookies);
    expect(noCsrf.status).toBe(403);

    const refreshed = await request(cookieApp)
      .post("/v1/auth/refresh")
      .set("Cookie", cookies)
      .set(env.AUTH_CSRF_HEADER, csrf!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeDefined();

    // Refresh re-issues the CSRF token: logout uses the fresh pair.
    const freshCsrf = cookieValue(refreshed, env.AUTH_CSRF_COOKIE_NAME);
    const logoutRes = await request(cookieApp)
      .post("/v1/auth/logout")
      .set("Cookie", cookiesFrom(refreshed))
      .set(env.AUTH_CSRF_HEADER, freshCsrf!);
    expect(logoutRes.status).toBe(200);
  });

  it("enforces the frontend origin allowlist", async () => {
    const restricted = createApp({ frontendOrigins: ["https://app.example.com"] });
    const ok = await request(restricted).get("/healthz").set("Origin", "https://app.example.com");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.example.com");

    const blocked = await request(restricted).get("/healthz").set("Origin", "https://evil.example.com");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not require CSRF for body-token refresh", async () => {
    const { refreshToken } = await login("plain@example.com");
    const res = await request(app).post("/v1/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
  });
});
