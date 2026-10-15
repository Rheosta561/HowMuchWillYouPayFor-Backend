import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Express } from "express";
import { createApp } from "../../../app.js";
import { createDefaultAuthService } from "../auth.service.js";
import { OtpService } from "../services/otp.service.js";
import { InMemoryEmailService } from "../services/email.service.js";
import { OtpChallengeModel } from "../models/otp-challenge.model.js";
import { RefreshSessionModel } from "../models/refresh-session.model.js";
import { UserModel, normalizeEmail } from "../../users/user.model.js";
import { UserService } from "../../users/user.service.js";

const REQUEST = "/v1/auth/email/otp/request";
const VERIFY = "/v1/auth/email/otp/verify";

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
  const uri = `mongodb://127.0.0.1:27017/email_otp_int_${process.pid}`;
  if (await tryConnect(uri)) return;
  await mongoose.disconnect().catch(() => {});
  // Fallback: boot an ephemeral local mongod.
  tmpDbPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hmwyp-mongo-"));
  mongodProc = spawn("mongod", ["--port", "27099", "--dbpath", tmpDbPath, "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const fallback = "mongodb://127.0.0.1:27099/email_otp_int";
  for (let i = 0; i < 50; i += 1) {
    if (await tryConnect(fallback)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Could not connect to MongoDB and could not start ephemeral mongod");
}

interface TestApp {
  app: Express;
  inbox: InMemoryEmailService;
}

function buildTestApp(opts: { cooldownSeconds?: number; requestIpMax?: number; verifyIpMax?: number } = {}): TestApp {
  const inbox = new InMemoryEmailService();
  const otp = new OtpService(
    OtpChallengeModel,
    10, // ttl minutes
    5, // max attempts
    opts.cooldownSeconds ?? 0,
    100, // per-hour cap relaxed for tests
  );
  const authService = createDefaultAuthService({ email: inbox, otp });
  const app = createApp({
    authService,
    requestIpMax: opts.requestIpMax,
    verifyIpMax: opts.verifyIpMax,
  });
  return { app, inbox };
}

function wrongCode(real: string): string {
  for (const candidate of ["000000", "111111", "999999"]) {
    if (candidate !== real) return candidate;
  }
  return "123457";
}

beforeAll(async () => {
  await ensureMongo();
  await UserModel.ensureIndexes();
  await OtpChallengeModel.ensureIndexes();
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
    OtpChallengeModel.deleteMany({}).exec(),
    RefreshSessionModel.deleteMany({}).exec(),
  ]);
});

describe("POST /v1/auth/email/otp/request", () => {
  it("returns the same generic response for unknown and registered emails", async () => {
    const { app } = buildTestApp();
    await UserModel.create({
      email: "known@example.com",
      emailNormalized: "known@example.com",
      status: "active",
      role: "user",
      providers: [],
    });

    const unknownRes = await request(app).post(REQUEST).send({ email: "unknown@example.com" });
    const knownRes = await request(app).post(REQUEST).send({ email: "known@example.com" });

    expect(unknownRes.status).toBe(200);
    expect(knownRes.status).toBe(200);
    expect(unknownRes.body).toEqual(knownRes.body);
    expect(unknownRes.body.message).toMatch(/sign-in code/i);
    // No OTP, hash, or registration signal in the response.
    expect(JSON.stringify(unknownRes.body)).not.toMatch(/\d{6}/);
    expect(unknownRes.body).not.toHaveProperty("code");
    expect(unknownRes.body).not.toHaveProperty("registered");
  });

  it("normalizes the email and stores only the OTP hash", async () => {
    const { app, inbox } = buildTestApp();
    const res = await request(app).post(REQUEST).send({ email: "  MiXeD@Example.COM " });
    expect(res.status).toBe(200);

    const challenge = await OtpChallengeModel.findOne({ emailNormalized: "mixed@example.com" }).exec();
    expect(challenge).not.toBeNull();
    const code = inbox.lastCodeFor("mixed@example.com");
    expect(code).toBeDefined();
    expect(challenge!.codeHash).not.toContain(code!);
    expect(challenge!.salt).toBeDefined();
    expect(challenge!.toObject()).not.toHaveProperty("code");
    expect(challenge!.attempts).toBe(0);
  });

  it("rejects invalid email with 400 via Zod", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post(REQUEST).send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("enforces the resend cooldown with 429", async () => {
    const { app } = buildTestApp({ cooldownSeconds: 60 });
    const first = await request(app).post(REQUEST).send({ email: "cool@example.com" });
    expect(first.status).toBe(200);
    const second = await request(app).post(REQUEST).send({ email: "cool@example.com" });
    expect(second.status).toBe(429);
  });

  it("enforces the per-IP rate limit with 429", async () => {
    const { app } = buildTestApp({ requestIpMax: 2 });
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app).post(REQUEST).send({ email: `ip${i}@example.com` });
      expect(res.status).toBe(200);
    }
    const limited = await request(app).post(REQUEST).send({ email: "ip2@example.com" });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("TOO_MANY_REQUESTS");
  });
});

describe("POST /v1/auth/email/otp/verify — signup and login", () => {
  it("signs up a new user after verification and issues the standardized result", async () => {
    const { app, inbox } = buildTestApp();
    await request(app).post(REQUEST).send({ email: "newbie@example.com" });
    const code = inbox.lastCodeFor("newbie@example.com")!;

    const res = await request(app).post(VERIFY).send({ email: "newbie@example.com", code });
    expect(res.status).toBe(201);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user.email).toBe("newbie@example.com");
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.refreshExpiresAt).toBeDefined();

    // No account existed before verification: exactly one user now.
    expect(await UserModel.countDocuments({ emailNormalized: "newbie@example.com" }).exec()).toBe(1);

    // Session persisted with hashed refresh token (never plaintext).
    const sessions = await RefreshSessionModel.find({}).exec();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessions[0]!.tokenHash).not.toBe(res.body.refreshToken);
  });

  it("logs an existing user in through EmailOtpStrategy.login (200, isNewUser false)", async () => {
    const { app, inbox } = buildTestApp({ cooldownSeconds: 0 });
    await request(app).post(REQUEST).send({ email: "returning@example.com" });
    const firstCode = inbox.lastCodeFor("returning@example.com")!;
    const signup = await request(app).post(VERIFY).send({ email: "returning@example.com", code: firstCode });
    expect(signup.status).toBe(201);
    const userId = signup.body.user.id;

    await request(app).post(REQUEST).send({ email: "returning@example.com" });
    const secondCode = inbox.lastCodeFor("returning@example.com")!;
    const login = await request(app).post(VERIFY).send({ email: "returning@example.com", code: secondCode });
    expect(login.status).toBe(200);
    expect(login.body.isNewUser).toBe(false);
    expect(login.body.user.id).toBe(userId);
    expect(login.body.accessToken).toBeDefined();
    expect(login.body.refreshToken).toBeDefined();
    expect(await UserModel.countDocuments({ emailNormalized: "returning@example.com" }).exec()).toBe(1);
  });

  it("rejects an invalid OTP with a generic 401 and creates nothing", async () => {
    const { app, inbox } = buildTestApp();
    await request(app).post(REQUEST).send({ email: "victim@example.com" });
    const real = inbox.lastCodeFor("victim@example.com")!;

    const res = await request(app).post(VERIFY).send({ email: "victim@example.com", code: wrongCode(real) });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_OR_EXPIRED_CODE");
    expect(await UserModel.countDocuments({}).exec()).toBe(0);
    expect(await RefreshSessionModel.countDocuments({}).exec()).toBe(0);
  });

  it("rejects an expired OTP with the same generic 401", async () => {
    const { app, inbox } = buildTestApp();
    await request(app).post(REQUEST).send({ email: "late@example.com" });
    const code = inbox.lastCodeFor("late@example.com")!;
    await OtpChallengeModel.updateOne(
      { emailNormalized: "late@example.com" },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    ).exec();

    const res = await request(app).post(VERIFY).send({ email: "late@example.com", code });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_OR_EXPIRED_CODE");
    expect(await UserModel.countDocuments({}).exec()).toBe(0);
    expect(await RefreshSessionModel.countDocuments({}).exec()).toBe(0);
  });

  it("rejects a replayed OTP and keeps exactly one session", async () => {
    const { app, inbox } = buildTestApp();
    await request(app).post(REQUEST).send({ email: "replay@example.com" });
    const code = inbox.lastCodeFor("replay@example.com")!;

    const first = await request(app).post(VERIFY).send({ email: "replay@example.com", code });
    expect(first.status).toBe(201);
    const replay = await request(app).post(VERIFY).send({ email: "replay@example.com", code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("INVALID_OR_EXPIRED_CODE");
    expect(await RefreshSessionModel.countDocuments({}).exec()).toBe(1);
  });

  it("locks out after too many wrong attempts with 429", async () => {
    const { app, inbox } = buildTestApp();
    await request(app).post(REQUEST).send({ email: "brute@example.com" });
    const real = inbox.lastCodeFor("brute@example.com")!;
    const bad = wrongCode(real);

    let lastStatus = 0;
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post(VERIFY).send({ email: "brute@example.com", code: bad });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
    // Even the correct code is now rejected.
    const correct = await request(app).post(VERIFY).send({ email: "brute@example.com", code: real });
    expect(correct.status).toBe(429);
    expect(await UserModel.countDocuments({}).exec()).toBe(0);
  });
});

describe("concurrency", () => {
  it("lets exactly one concurrent verification win; one user, one session", async () => {
    const { app, inbox } = buildTestApp();
    await request(app).post(REQUEST).send({ email: "race@example.com" });
    const code = inbox.lastCodeFor("race@example.com")!;

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        request(app).post(VERIFY).send({ email: "race@example.com", code }),
      ),
    );
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : -1));
    expect(statuses.filter((s) => s === 200 || s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    expect(await UserModel.countDocuments({ emailNormalized: "race@example.com" }).exec()).toBe(1);
    expect(await RefreshSessionModel.countDocuments({}).exec()).toBe(1);
  }, 60000);

  it("handles concurrent signups for the same email via unique indexes (one user)", async () => {
    const svc = new UserService();
    const email = `concurrent-${Date.now()}@example.com`;
    const normalized = normalizeEmail(email);
    const identity = {
      provider: "email-otp" as const,
      providerUserId: normalized,
      email,
      emailVerified: true,
    };
    const outcomes = await Promise.allSettled([
      svc.createWithProvider({ email, providerIdentity: identity }),
      svc.createWithProvider({ email, providerIdentity: identity }),
    ]);
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    expect(await UserModel.countDocuments({ emailNormalized: normalized }).exec()).toBe(1);
  }, 60000);
});
