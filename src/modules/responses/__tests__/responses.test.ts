import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Express } from "express";
import { createApp } from "../../../app.js";
import { IdeaModel } from "../../ideas/idea.model.js";
import { CategoryModel } from "../../categories/category.model.js";
import { PricingResponseModel } from "../response.model.js";
import { UserModel } from "../../users/user.model.js";
import { TokenService } from "../../auth/services/token.service.js";

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
  const uri = `mongodb://127.0.0.1:27017/responses_int_${process.pid}`;
  if (await tryConnect(uri)) return;
  await mongoose.disconnect().catch(() => {});
  tmpDbPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hmwyp-mongo-"));
  mongodProc = spawn("mongod", ["--port", "27099", "--dbpath", tmpDbPath, "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const fallback = "mongodb://127.0.0.1:27099/responses_int";
  for (let i = 0; i < 50; i += 1) {
    if (await tryConnect(fallback)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Could not connect to MongoDB and could not start ephemeral mongod");
}

beforeAll(async () => {
  await ensureMongo();
  await PricingResponseModel.ensureIndexes();
  await IdeaModel.ensureIndexes();
  await CategoryModel.ensureIndexes();
  await UserModel.ensureIndexes();
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
    PricingResponseModel.deleteMany({}).exec(),
    IdeaModel.deleteMany({}).exec(),
    CategoryModel.deleteMany({}).exec(),
    UserModel.deleteMany({}).exec(),
  ]);
});

const app: Express = createApp();
const tokens = new TokenService();

async function seedUser(email = "user@example.com") {
  const user = await UserModel.create({
    email,
    emailNormalized: email.toLowerCase(),
    status: "active",
    role: "user",
    providers: [],
  });
  return { user, accessToken: tokens.issueAccessToken(user.id, user.role) };
}

async function seedIdea(
  creatorId: string,
  overrides: Record<string, unknown> = {},
  status: "published" | "archived" = "published",
) {
  await CategoryModel.updateOne(
    { slug: "fintech" },
    { $setOnInsert: { slug: "fintech", name: "Fintech", order: 1, active: true } },
    { upsert: true },
  ).exec();
  return IdeaModel.create({
    creatorId,
    title: `Idea ${Math.random().toString(36).slice(2)}`,
    pitch: "A concise pitch describing the idea value proposition.",
    abstract: "An abstract describing the idea in a few sentences.",
    category: "fintech",
    tags: ["test"],
    targetMarket: { scope: "global", countryCode: null, cityId: null },
    pricing: { currency: "USD", billingPeriod: "monthly" },
    status,
    ...overrides,
  });
}

describe("POST /v1/ideas/:ideaId/responses", () => {
  it("accepts a valid response and derives currency/billingPeriod from the idea", async () => {
    const { user, accessToken } = await seedUser();
    const idea = await seedIdea(String(user._id), {
      pricing: { currency: "EUR", billingPeriod: "yearly" },
    });
    const res = await request(app)
      .post(`/v1/ideas/${String(idea._id)}/responses`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ amount: 19.99 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      ideaId: String(idea._id),
      userId: String(user._id),
      amount: 19.99,
      currency: "EUR",
      billingPeriod: "yearly",
    });
    expect(typeof res.body.data.id).toBe("string");
    expect(typeof res.body.data.createdAt).toBe("string");
    // No response data embedded in the idea document.
    const reloaded = await IdeaModel.findById(idea._id).lean().exec();
    expect(reloaded).not.toHaveProperty("responses");
  }, 30000);

  it("rejects anonymous submissions with 401", async () => {
    const { user } = await seedUser();
    const idea = await seedIdea(String(user._id));
    const res = await request(app).post(`/v1/ideas/${String(idea._id)}/responses`).send({ amount: 10 });
    expect(res.status).toBe(401);
  });

  it("returns 404 for missing or archived ideas", async () => {
    const { user, accessToken } = await seedUser();
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${accessToken}`);
    const missing = await auth(
      request(app).post("/v1/ideas/000000000000000000000000/responses").send({ amount: 10 }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("IDEA_NOT_FOUND");

    const archived = await seedIdea(String(user._id), {}, "archived");
    const gone = await auth(
      request(app).post(`/v1/ideas/${String(archived._id)}/responses`).send({ amount: 10 }),
    );
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("IDEA_NOT_FOUND");
  });

  it("rejects malformed idea IDs with 400", async () => {
    const { accessToken } = await seedUser();
    const res = await request(app)
      .post("/v1/ideas/not-an-id/responses")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["missing", undefined],
    ["string", "19.99"],
    ["null", null],
    ["three decimals", 19.999],
    ["excessive", 100_000_000.01],
  ])("rejects %s amounts with 400", async (_label, amount) => {
    const { user, accessToken } = await seedUser(`${String(amount)}@example.com`);
    const idea = await seedIdea(String(user._id));
    const body = amount === undefined ? {} : { amount };
    const res = await request(app)
      .post(`/v1/ideas/${String(idea._id)}/responses`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.requestId).toBe("string");
  });

  it("rejects client-controlled identity, pricing, and protected fields", async () => {
    const { user, accessToken } = await seedUser();
    const idea = await seedIdea(String(user._id));
    const res = await request(app)
      .post(`/v1/ideas/${String(idea._id)}/responses`)
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        amount: 10,
        userId: "000000000000000000000001",
        currency: "EUR",
        billingPeriod: "yearly",
        _id: "000000000000000000000002",
        createdAt: "2020-01-01T00:00:00.000Z",
        rank: 1,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await PricingResponseModel.countDocuments({}).exec()).toBe(0);
  });

  it("returns 409 on duplicate submissions", async () => {
    const { user, accessToken } = await seedUser();
    const idea = await seedIdea(String(user._id));
    const url = `/v1/ideas/${String(idea._id)}/responses`;
    const headers = { Authorization: `Bearer ${accessToken}` };
    expect((await request(app).post(url).set(headers).send({ amount: 10 })).status).toBe(201);
    const dup = await request(app).post(url).set(headers).send({ amount: 20 });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({
      success: false,
      error: {
        code: "DUPLICATE_RESPONSE",
        message: "You have already submitted a response for this idea.",
        details: [],
      },
    });
    expect(typeof dup.body.requestId).toBe("string");
  });

  it("lets exactly one concurrent duplicate win", async () => {
    const { user, accessToken } = await seedUser();
    const idea = await seedIdea(String(user._id));
    const url = `/v1/ideas/${String(idea._id)}/responses`;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        request(app).post(url).set("Authorization", `Bearer ${accessToken}`).send({ amount: 10 }),
      ),
    );
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : -1));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(await PricingResponseModel.countDocuments({ ideaId: idea._id }).exec()).toBe(1);
  }, 60000);

  it("allows two users on one idea and one user on two ideas", async () => {
    const a = await seedUser("a@example.com");
    const b = await seedUser("b@example.com");
    const idea1 = await seedIdea(String(a.user._id));
    const idea2 = await seedIdea(String(a.user._id));
    const post = (ideaId: string, token: string) =>
      request(app).post(`/v1/ideas/${ideaId}/responses`).set("Authorization", `Bearer ${token}`).send({ amount: 5 });
    expect((await post(String(idea1._id), a.accessToken)).status).toBe(201);
    expect((await post(String(idea1._id), b.accessToken)).status).toBe(201);
    expect((await post(String(idea2._id), a.accessToken)).status).toBe(201);
  });
});

describe("GET /v1/me/responses", () => {
  it("returns only the caller's records with deterministic pagination", async () => {
    const mine = await seedUser("mine@example.com");
    const theirs = await seedUser("theirs@example.com");
    const ideaIds: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const idea = await seedIdea(String(mine.user._id));
      ideaIds.push(String(idea._id));
      await request(app)
        .post(`/v1/ideas/${String(idea._id)}/responses`)
        .set("Authorization", `Bearer ${mine.accessToken}`)
        .send({ amount: i + 1 });
    }
    const otherIdea = await seedIdea(String(theirs.user._id));
    await request(app)
      .post(`/v1/ideas/${String(otherIdea._id)}/responses`)
      .set("Authorization", `Bearer ${theirs.accessToken}`)
      .send({ amount: 99 });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const qs = cursor ? `?limit=5&cursor=${encodeURIComponent(cursor)}` : "?limit=5";
      const res = await request(app).get(`/v1/me/responses${qs}`).set("Authorization", `Bearer ${mine.accessToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids.every((id: string) => !seen.includes(id))).toBe(true);
      expect(res.body.data.every((d: { userId: string }) => d.userId === String(mine.user._id))).toBe(true);
      seen.push(...ids);
      pages += 1;
      if (!res.body.meta.hasMore) break;
      cursor = res.body.meta.nextCursor as string;
    }
    expect(seen).toHaveLength(12);
    expect(pages).toBe(3);

    const filtered = await request(app)
      .get(`/v1/me/responses?ideaId=${ideaIds[0]}`)
      .set("Authorization", `Bearer ${mine.accessToken}`);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].ideaId).toBe(ideaIds[0]);
  });

  it("rejects invalid pagination parameters and requires auth", async () => {
    const { accessToken } = await seedUser();
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${accessToken}`);
    expect((await auth(request(app).get("/v1/me/responses?limit=0"))).status).toBe(400);
    expect((await auth(request(app).get("/v1/me/responses?limit=100"))).status).toBe(400);
    expect((await auth(request(app).get("/v1/me/responses?cursor=bogus"))).status).toBe(400);
    expect((await auth(request(app).get("/v1/me/responses?ideaId=nope"))).status).toBe(400);
    expect((await request(app).get("/v1/me/responses")).status).toBe(401);
  });
});

describe("GET /v1/ideas/:ideaId/responses/me", () => {
  it("returns only the caller's response with the documented missing contract", async () => {
    const mine = await seedUser("mine2@example.com");
    const theirs = await seedUser("theirs2@example.com");
    const idea = await seedIdea(String(mine.user._id));
    await request(app)
      .post(`/v1/ideas/${String(idea._id)}/responses`)
      .set("Authorization", `Bearer ${theirs.accessToken}`)
      .send({ amount: 42 });

    const missing = await request(app)
      .get(`/v1/ideas/${String(idea._id)}/responses/me`)
      .set("Authorization", `Bearer ${mine.accessToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("RESPONSE_NOT_FOUND");

    await request(app)
      .post(`/v1/ideas/${String(idea._id)}/responses`)
      .set("Authorization", `Bearer ${mine.accessToken}`)
      .send({ amount: 7 });
    const found = await request(app)
      .get(`/v1/ideas/${String(idea._id)}/responses/me`)
      .set("Authorization", `Bearer ${mine.accessToken}`);
    expect(found.status).toBe(200);
    expect(found.body.data).toMatchObject({ amount: 7, userId: String(mine.user._id) });

    const anon = await request(app).get(`/v1/ideas/${String(idea._id)}/responses/me`);
    expect(anon.status).toBe(401);
    const bad = await request(app)
      .get("/v1/ideas/nope/responses/me")
      .set("Authorization", `Bearer ${mine.accessToken}`);
    expect(bad.status).toBe(400);
  });
});

describe("response indexes", () => {
  it("defines the unique and history indexes", async () => {
    await PricingResponseModel.ensureIndexes();
    const indexes = await PricingResponseModel.collection.listIndexes().toArray();
    const unique = indexes.find((ix) => ix.unique === true);
    expect(unique).toBeDefined();
    expect(unique!.key).toEqual({ ideaId: 1, userId: 1 });
    const keys = indexes.map((ix) => JSON.stringify(ix.key));
    expect(keys).toContain(JSON.stringify({ userId: 1, createdAt: -1, _id: -1 }));
  });
});
