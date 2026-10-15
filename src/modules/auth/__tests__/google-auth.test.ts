import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Express } from "express";
import { createApp } from "../../../app.js";
import { createDefaultAuthService } from "../auth.service.js";
import { GoogleStrategy, type GoogleProfile } from "../strategies/google.strategy.js";
import { createGoogleVerifier } from "../services/google-verifier.js";
import {
  EmailNotVerifiedError,
  GoogleVerificationError,
  ProviderConflictError,
} from "../auth.errors.js";
import type { UserService } from "../../users/user.service.js";
import { UserModel } from "../../users/user.model.js";
import { RefreshSessionModel } from "../models/refresh-session.model.js";

const GOOGLE = "/v1/auth/google";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const verifiedProfile: GoogleProfile = {
  sub: "google-sub-123",
  email: "user@example.com",
  emailVerified: true,
};

function mockVerifier(result: GoogleProfile | Error, seen: string[] = []) {
  return async (idToken: string): Promise<GoogleProfile> => {
    seen.push(idToken);
    if (result instanceof Error) throw result;
    return result;
  };
}

function stubDeps(opts: {
  linkedUser?: unknown;
  resolvedUser?: { user: unknown; isNewUser: boolean };
} = {}) {
  const users = {
    findByProvider: vi.fn(async () => opts.linkedUser ?? null),
    findOrCreateForVerifiedIdentity: vi.fn(async () => opts.resolvedUser ?? {
      user: { id: "u-new", email: "user@example.com", role: "user", status: "active" },
      isNewUser: true,
    }),
  };
  const tokens = { issueAccessToken: vi.fn(() => "access-token") };
  const sessions = {
    createSession: vi.fn(async () => ({ refreshToken: "refresh-token", expiresAt: new Date() })),
  };
  return { users, tokens, sessions };
}

function makeStrategy(
  verify: (idToken: string) => Promise<GoogleProfile>,
  deps: ReturnType<typeof stubDeps>,
) {
  return new GoogleStrategy({
    users: deps.users as unknown as UserService,
    tokens: deps.tokens as never,
    sessions: deps.sessions as never,
    verifyIdToken: verify,
  });
}

/* ------------------------------------------------------------------ */
/* Strategy unit tests (mocked Google verification)                    */
/* ------------------------------------------------------------------ */

describe("GoogleStrategy with mocked verification", () => {
  it("authenticates a valid token for a new user with the shared AuthResult contract", async () => {
    const deps = stubDeps();
    const strategy = makeStrategy(mockVerifier(verifiedProfile), deps);

    const result = await strategy.login({ idToken: "valid-token" });

    expect(result).toHaveProperty("user");
    expect(result).toHaveProperty("accessToken");
    expect(result).toHaveProperty("refreshToken");
    expect(result).toHaveProperty("refreshExpiresAt");
    expect(result).toHaveProperty("isNewUser");
    expect(result.isNewUser).toBe(true);
    expect(result.user.email).toBe("user@example.com");
    expect(deps.users.findOrCreateForVerifiedIdentity).toHaveBeenCalledWith({
      provider: "google",
      providerUserId: "google-sub-123",
      email: "user@example.com",
      emailVerified: true,
    });
    // Shared session service is used (no Google-specific session mechanism).
    expect(deps.sessions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-new", provider: "google" }),
    );
  });

  it("never trusts client-submitted profile fields; only the verifier output is used", async () => {
    const deps = stubDeps();
    const strategy = makeStrategy(mockVerifier(verifiedProfile), deps);

    const result = await strategy.login({
      idToken: "valid-token",
      // Attacker-controlled claims that must be ignored:
      email: "attacker@evil.com",
      sub: "fake-sub",
      providerUserId: "fake-sub",
    } as never);

    expect(result.user.email).toBe("user@example.com");
    expect(deps.users.findByProvider).toHaveBeenCalledWith("google", "google-sub-123");
  });

  it("finds an existing account by stable subject identifier", async () => {
    const linked = { id: "u-existing", email: "old@example.com", role: "user", status: "active" };
    const deps = stubDeps({ linkedUser: linked });
    const strategy = makeStrategy(
      mockVerifier({ ...verifiedProfile, email: "changed@example.com" }),
      deps,
    );

    const result = await strategy.login({ idToken: "valid-token" });

    expect(result.isNewUser).toBe(false);
    expect(result.user.id).toBe("u-existing");
    // Sub link wins; no create-or-merge path is attempted.
    expect(deps.users.findOrCreateForVerifiedIdentity).not.toHaveBeenCalled();
  });

  it("lets a linked account sign in even if Google now reports unverified email", async () => {
    const linked = { id: "u-existing", email: "user@example.com", role: "user", status: "active" };
    const deps = stubDeps({ linkedUser: linked });
    const strategy = makeStrategy(
      mockVerifier({ ...verifiedProfile, emailVerified: false }),
      deps,
    );

    const result = await strategy.login({ idToken: "valid-token" });
    expect(result.user.id).toBe("u-existing");
  });

  it("rejects an unverified email for a new identity without creating anything", async () => {
    const deps = stubDeps();
    const strategy = makeStrategy(
      mockVerifier({ ...verifiedProfile, emailVerified: false }),
      deps,
    );

    await expect(strategy.login({ idToken: "valid-token" })).rejects.toBeInstanceOf(
      EmailNotVerifiedError,
    );
    expect(deps.users.findOrCreateForVerifiedIdentity).not.toHaveBeenCalled();
    expect(deps.sessions.createSession).not.toHaveBeenCalled();
  });

  it("surfaces account-linking conflicts instead of merging silently", async () => {
    const deps = stubDeps();
    deps.users.findOrCreateForVerifiedIdentity = vi.fn(async () => {
      throw new ProviderConflictError("already linked elsewhere");
    });
    const strategy = makeStrategy(mockVerifier(verifiedProfile), deps);

    await expect(strategy.login({ idToken: "valid-token" })).rejects.toBeInstanceOf(
      ProviderConflictError,
    );
    expect(deps.sessions.createSession).not.toHaveBeenCalled();
  });

  it("rejects expired tokens", async () => {
    const deps = stubDeps();
    const strategy = makeStrategy(
      mockVerifier(new GoogleVerificationError("Google token has expired")),
      deps,
    );
    await expect(strategy.login({ idToken: "expired" })).rejects.toThrow("Google token has expired");
    expect(deps.sessions.createSession).not.toHaveBeenCalled();
  });

  it("rejects invalid audience", async () => {
    const deps = stubDeps();
    const strategy = makeStrategy(
      mockVerifier(new GoogleVerificationError("Google token audience mismatch")),
      deps,
    );
    await expect(strategy.login({ idToken: "wrong-aud" })).rejects.toThrow(
      "Google token audience mismatch",
    );
  });

  it("rejects missing tokens", async () => {
    const deps = stubDeps();
    const strategy = makeStrategy(mockVerifier(verifiedProfile), deps);
    await expect(strategy.login({})).rejects.toBeInstanceOf(GoogleVerificationError);
    await expect(strategy.login({ idToken: "" })).rejects.toBeInstanceOf(GoogleVerificationError);
  });
});

/* ------------------------------------------------------------------ */
/* Real verifier unit tests (mock OAuth2Client, no network)            */
/* ------------------------------------------------------------------ */

describe("createGoogleVerifier (google-auth-library wiring)", () => {
  function fakeClient(payload: Record<string, unknown> | undefined | Error) {
    return {
      verifyIdToken: async () => {
        if (payload instanceof Error) throw payload;
        return { getPayload: () => payload };
      },
    } as never;
  }

  it("returns only the needed profile fields from a verified payload", async () => {
    const verify = createGoogleVerifier({
      clientIds: ["test-client-id"],
      client: fakeClient({
        sub: "sub-1",
        email: "User@Example.com",
        email_verified: true,
        name: "Extra Name",
        aud: "test-client-id",
      }),
    });
    const profile = await verify("token");
    expect(profile).toEqual({ sub: "sub-1", email: "User@Example.com", emailVerified: true });
  });

  it("maps expiry failures", async () => {
    const verify = createGoogleVerifier({
      clientIds: ["test-client-id"],
      client: fakeClient(new Error("Token used too late, 1234 < 5678")),
    });
    await expect(verify("token")).rejects.toThrow("Google token has expired");
  });

  it("maps audience failures", async () => {
    const verify = createGoogleVerifier({
      clientIds: ["test-client-id"],
      client: fakeClient(new Error("Token has wrong audience")),
    });
    await expect(verify("token")).rejects.toThrow("Google token audience mismatch");
  });

  it("rejects payloads without subject or email", async () => {
    const noSub = createGoogleVerifier({ clientIds: ["id"], client: fakeClient({ email: "a@b.com" }) });
    await expect(noSub("t")).rejects.toThrow("no subject");
    const noEmail = createGoogleVerifier({ clientIds: ["id"], client: fakeClient({ sub: "s" }) });
    await expect(noEmail("t")).rejects.toThrow("no email");
  });

  it("reports unconfigured verification when no client ID is set", async () => {
    const verify = createGoogleVerifier({ clientIds: [] });
    await expect(verify("token")).rejects.toThrow("not configured");
  });
});

/* ------------------------------------------------------------------ */
/* HTTP integration tests (real MongoDB, mocked Google verification)   */
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
  const uri = `mongodb://127.0.0.1:27017/google_auth_int_${process.pid}`;
  if (await tryConnect(uri)) return;
  await mongoose.disconnect().catch(() => {});
  tmpDbPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hmwyp-mongo-"));
  mongodProc = spawn("mongod", ["--port", "27099", "--dbpath", tmpDbPath, "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const fallback = "mongodb://127.0.0.1:27099/google_auth_int";
  for (let i = 0; i < 50; i += 1) {
    if (await tryConnect(fallback)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Could not connect to MongoDB and could not start ephemeral mongod");
}

function buildGoogleApp(
  verify: (idToken: string) => Promise<GoogleProfile>,
  opts: { googleIpMax?: number } = {},
): Express {
  return createApp({
    authService: createDefaultAuthService({ verifyGoogleIdToken: verify }),
    googleIpMax: opts.googleIpMax,
  });
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

describe("POST /v1/auth/google", () => {
  it("creates a new user from a valid token and returns the shared response contract", async () => {
    const app = buildGoogleApp(mockVerifier(verifiedProfile));
    const res = await request(app).post(GOOGLE).send({ idToken: "valid" });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(
      ["accessToken", "isNewUser", "refreshExpiresAt", "refreshToken", "user"].sort(),
    );
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user.email).toBe("user@example.com");

    const stored = await UserModel.findOne({ emailNormalized: "user@example.com" }).exec();
    expect(stored).not.toBeNull();
    // Only the needed provider fields are stored.
    expect(stored!.providers).toHaveLength(1);
    expect(stored!.providers[0]).toMatchObject({
      provider: "google",
      providerUserId: "google-sub-123",
      email: "user@example.com",
      emailVerified: true,
    });

    // Shared session mechanism (provider recorded, token hashed).
    const sessions = await RefreshSessionModel.find({}).exec();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.provider).toBe("google");
    expect(sessions[0]!.tokenHash).not.toBe(res.body.refreshToken);
  });

  it("logs an existing linked account in (200, same user)", async () => {
    const app = buildGoogleApp(mockVerifier(verifiedProfile));
    const first = await request(app).post(GOOGLE).send({ idToken: "valid" });
    expect(first.status).toBe(201);

    const second = await request(app).post(GOOGLE).send({ idToken: "valid" });
    expect(second.status).toBe(200);
    expect(second.body.isNewUser).toBe(false);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it("links a verified Google identity to an existing email-owner account", async () => {
    await UserModel.create({
      email: "user@example.com",
      emailNormalized: "user@example.com",
      status: "active",
      role: "user",
      providers: [],
    });
    const app = buildGoogleApp(mockVerifier(verifiedProfile));
    const res = await request(app).post(GOOGLE).send({ idToken: "valid" });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    const stored = await UserModel.findOne({ emailNormalized: "user@example.com" }).exec();
    expect(stored!.providers.some((p) => p.provider === "google")).toBe(true);
  });

  it("returns generic 401 for expired tokens", async () => {
    const app = buildGoogleApp(mockVerifier(new GoogleVerificationError("Google token has expired")));
    const res = await request(app).post(GOOGLE).send({ idToken: "expired" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: "GOOGLE_AUTH_FAILED", message: "Google authentication failed." });
    expect(await UserModel.countDocuments({}).exec()).toBe(0);
  });

  it("returns generic 401 for invalid audience without leaking details", async () => {
    const app = buildGoogleApp(
      mockVerifier(new GoogleVerificationError("Google token audience mismatch")),
    );
    const res = await request(app).post(GOOGLE).send({ idToken: "wrong-aud" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("GOOGLE_AUTH_FAILED");
    expect(JSON.stringify(res.body)).not.toMatch(/audience/i);
  });

  it("returns 400 for missing tokens", async () => {
    const app = buildGoogleApp(mockVerifier(verifiedProfile));
    const empty = await request(app).post(GOOGLE).send({});
    expect(empty.status).toBe(400);
    const blank = await request(app).post(GOOGLE).send({ idToken: "" });
    expect(blank.status).toBe(400);
  });

  it("refuses unverified email without creating an account", async () => {
    const app = buildGoogleApp(
      mockVerifier({ ...verifiedProfile, emailVerified: false }),
    );
    const res = await request(app).post(GOOGLE).send({ idToken: "unverified" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(await UserModel.countDocuments({}).exec()).toBe(0);
  });

  it("does not merge an unverified claim into an existing email account", async () => {
    await UserModel.create({
      email: "user@example.com",
      emailNormalized: "user@example.com",
      status: "active",
      role: "user",
      providers: [],
    });
    const app = buildGoogleApp(
      mockVerifier({ sub: "other-sub", email: "user@example.com", emailVerified: false }),
    );
    const res = await request(app).post(GOOGLE).send({ idToken: "unverified" });
    expect(res.status).toBe(403);
    const stored = await UserModel.findOne({ emailNormalized: "user@example.com" }).exec();
    expect(stored!.providers).toHaveLength(0);
  });

  it("returns 403 for suspended accounts", async () => {
    await UserModel.create({
      email: "user@example.com",
      emailNormalized: "user@example.com",
      status: "suspended",
      role: "user",
      providers: [
        {
          provider: "google",
          providerUserId: "google-sub-123",
          email: "user@example.com",
          emailVerified: true,
          linkedAt: new Date(),
        },
      ],
    });
    const app = buildGoogleApp(mockVerifier(verifiedProfile));
    const res = await request(app).post(GOOGLE).send({ idToken: "valid" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_UNAVAILABLE");
  });

  it("rate-limits Google auth per IP", async () => {
    const app = buildGoogleApp(mockVerifier(verifiedProfile), { googleIpMax: 2 });
    expect((await request(app).post(GOOGLE).send({ idToken: "valid" })).status).toBe(201);
    expect((await request(app).post(GOOGLE).send({ idToken: "valid" })).status).toBe(200);
    const limited = await request(app).post(GOOGLE).send({ idToken: "valid" });
    expect(limited.status).toBe(429);
  });
});
