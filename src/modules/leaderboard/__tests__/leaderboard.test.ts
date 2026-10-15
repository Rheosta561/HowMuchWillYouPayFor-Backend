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
import { CountryModel } from "../../locations/country.model.js";
import { CityModel } from "../../locations/city.model.js";
import { PricingResponseModel } from "../../responses/response.model.js";
import { UserModel } from "../../users/user.model.js";
import { LeaderboardEntryModel } from "../leaderboard.snapshot.model.js";
import { LeaderboardMetadataModel } from "../leaderboard.metadata.model.js";
import { LeaderboardRepository } from "../leaderboard.repository.js";
import { LeaderboardAggregationService } from "../leaderboard.aggregation.service.js";
import { medianOfSortedAsc, serializeMedian } from "../leaderboard.types.js";
import { runLeaderboardRefresh } from "../leaderboard.scheduler.js";

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
  const uri = `mongodb://127.0.0.1:27017/leaderboard_int_${process.pid}`;
  if (await tryConnect(uri)) return;
  await mongoose.disconnect().catch(() => {});
  tmpDbPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hmwyp-mongo-"));
  mongodProc = spawn("mongod", ["--port", "27099", "--dbpath", tmpDbPath, "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const fallback = "mongodb://127.0.0.1:27099/leaderboard_int";
  for (let i = 0; i < 50; i += 1) {
    if (await tryConnect(fallback)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Could not connect to MongoDB and could not start ephemeral mongod");
}

beforeAll(async () => {
  await ensureMongo();
  await IdeaModel.ensureIndexes();
  await CategoryModel.ensureIndexes();
  await CountryModel.ensureIndexes();
  await CityModel.ensureIndexes();
  await PricingResponseModel.ensureIndexes();
  await UserModel.ensureIndexes();
  await LeaderboardEntryModel.ensureIndexes();
  await LeaderboardMetadataModel.ensureIndexes();
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
    IdeaModel.deleteMany({}).exec(),
    CategoryModel.deleteMany({}).exec(),
    CountryModel.deleteMany({}).exec(),
    CityModel.deleteMany({}).exec(),
    PricingResponseModel.deleteMany({}).exec(),
    UserModel.deleteMany({}).exec(),
    LeaderboardEntryModel.deleteMany({}).exec(),
    LeaderboardMetadataModel.deleteMany({}).exec(),
  ]);
});

const app: Express = createApp();
let userSeq = 0;

async function seedUser() {
  userSeq += 1;
  return UserModel.create({
    email: `lb-user-${userSeq}-${Date.now()}@example.com`,
    emailNormalized: `lb-user-${userSeq}@example.com`,
    status: "active",
    role: "user",
    providers: [],
  });
}

async function seedCategory() {
  return CategoryModel.create({ slug: "fintech", name: "Fintech", order: 1, active: true });
}

async function seedIdea(
  creatorId: string,
  overrides: Record<string, unknown> = {},
  targetMarket: Record<string, unknown> = { scope: "global", countryCode: null, cityId: null },
  pricing: Record<string, unknown> = { currency: "USD", billingPeriod: "monthly" },
) {
  return IdeaModel.create({
    creatorId,
    title: "Test idea",
    pitch: "A concise pitch describing the idea value proposition.",
    abstract: "An abstract describing the idea in a few sentences.",
    category: "fintech",
    tags: ["test"],
    targetMarket,
    pricing,
    status: "published",
    ...overrides,
  });
}

async function seedResponses(
  ideaId: string,
  amounts: number[],
  currency = "USD",
  billingPeriod: "one_time" | "weekly" | "monthly" | "yearly" = "monthly",
) {
  for (const amount of amounts) {
    const user = await seedUser();
    await PricingResponseModel.create({ ideaId, userId: user._id, amount, currency, billingPeriod });
  }
}

const amounts = (n: number, value: number): number[] => Array.from({ length: n }, () => value);

describe("median math", () => {
  it("takes the middle value for odd counts", () => {
    expect(medianOfSortedAsc([10, 20, 30])).toBe(20);
    expect(medianOfSortedAsc([5])).toBe(5);
  });

  it("takes the mean of the two middles for even counts", () => {
    expect(medianOfSortedAsc([10, 20, 30, 40])).toBe(25);
    expect(medianOfSortedAsc([19.99, 29.99])).toBeCloseTo(24.99, 10);
  });

  it("handles decimals and serializes output precision only", () => {
    const median = medianOfSortedAsc([0.1, 0.2, 0.3]);
    expect(median).toBeCloseTo(0.2, 10);
    expect(serializeMedian(19.985)).toBe(19.99);
    expect(serializeMedian(10)).toBe(10);
  });
});

describe("aggregation: threshold and ranking", () => {
  it("excludes below-threshold, includes at/above-threshold ideas", async () => {
    const user = await seedUser();
    await seedCategory();
    const below = await seedIdea(String(user._id));
    const at = await seedIdea(String(user._id));
    const above = await seedIdea(String(user._id));
    await seedResponses(String(below._id), amounts(29, 100));
    await seedResponses(String(at._id), amounts(30, 50));
    await seedResponses(String(above._id), amounts(31, 10));

    const agg = new LeaderboardAggregationService();
    const result = await agg.aggregate({ minResponses: 30 });
    const ids = result.entries.map((e) => e.ideaId).sort();
    expect(ids).toEqual([String(at._id), String(above._id)].sort());
  });

  it("orders by median desc, count desc, ideaId asc", async () => {
    const user = await seedUser();
    await seedCategory();
    const lowMedian = await seedIdea(String(user._id));
    const highCount = await seedIdea(String(user._id));
    const lowCount = await seedIdea(String(user._id));
    await seedResponses(String(lowMedian._id), amounts(5, 10)); // median 10
    await seedResponses(String(highCount._id), amounts(6, 50)); // median 50, count 6
    await seedResponses(String(lowCount._id), amounts(5, 50)); // median 50, count 5

    const agg = new LeaderboardAggregationService();
    const { entries } = await agg.aggregate({ minResponses: 5 });
    expect(entries.map((e) => e.ideaId)).toEqual([
      String(highCount._id),
      String(lowCount._id),
      String(lowMedian._id),
    ]);
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);

    // Final tie-breaker: identical median and count resolve on ideaId ascending.
    await PricingResponseModel.deleteMany({}).exec();
    await IdeaModel.deleteMany({}).exec();
    const first = await seedIdea(String(user._id));
    const second = await seedIdea(String(user._id));
    await seedResponses(String(first._id), amounts(5, 42));
    await seedResponses(String(second._id), amounts(5, 42));
    const again = await agg.aggregate({ minResponses: 5 });
    const ordered = [...again.entries].sort((a, b) => a.rank - b.rank).map((e) => e.ideaId);
    expect(ordered).toEqual([String(first._id), String(second._id)].sort());
  });

  it("never mixes currencies or billing periods", async () => {
    const user = await seedUser();
    await seedCategory();
    const usd = await seedIdea(String(user._id), {}, undefined, { currency: "USD", billingPeriod: "monthly" });
    const eur = await seedIdea(String(user._id), {}, undefined, { currency: "EUR", billingPeriod: "monthly" });
    const yearly = await seedIdea(String(user._id), {}, undefined, { currency: "USD", billingPeriod: "yearly" });
    await seedResponses(String(usd._id), amounts(3, 10), "USD", "monthly");
    await seedResponses(String(eur._id), amounts(3, 999), "EUR", "monthly");
    await seedResponses(String(yearly._id), amounts(3, 888), "USD", "yearly");

    const { entries } = await new LeaderboardAggregationService().aggregate({ minResponses: 3 });
    const byGroup = new Map(entries.map((e) => [`${e.group.currency}|${e.group.billingPeriod}`, e.medianAmount]));
    expect(byGroup.get("USD|monthly")).toBe(10);
    expect(byGroup.get("EUR|monthly")).toBe(999);
    expect(byGroup.get("USD|yearly")).toBe(888);
  });

  it("separates global, country, and city groups", async () => {
    const user = await seedUser();
    await seedCategory();
    await CountryModel.create({ _id: "US", name: "United States", active: true });
    const city = await CityModel.create({ displayName: "Austin", countryCode: "US", active: true });
    const global = await seedIdea(String(user._id));
    const country = await seedIdea(String(user._id), {}, { scope: "country", countryCode: "US", cityId: null });
    const cityIdea = await seedIdea(
      String(user._id),
      {},
      { scope: "city", countryCode: "US", cityId: String(city._id) },
    );
    await seedResponses(String(global._id), amounts(2, 10));
    await seedResponses(String(country._id), amounts(2, 20));
    await seedResponses(String(cityIdea._id), amounts(2, 30));

    const { entries } = await new LeaderboardAggregationService().aggregate({ minResponses: 2 });
    const scopes = new Map(entries.map((e) => [e.ideaId, e.group.scope]));
    expect(scopes.get(String(global._id))).toBe("global");
    expect(scopes.get(String(country._id))).toBe("country");
    expect(scopes.get(String(cityIdea._id))).toBe("city");
    expect(entries.filter((e) => e.group.scope === "global")).toHaveLength(1);
  });

  it("excludes archived ideas and mismatched responses", async () => {
    const user = await seedUser();
    await seedCategory();
    const archived = await seedIdea(String(user._id), { status: "archived" });
    await seedResponses(String(archived._id), amounts(5, 500));
    const live = await seedIdea(String(user._id));
    await seedResponses(String(live._id), amounts(4, 10));
    // Mismatched currency response: stored but ineligible.
    const outsider = await seedUser();
    await PricingResponseModel.create({
      ideaId: live._id,
      userId: outsider._id,
      amount: 9999,
      currency: "EUR",
      billingPeriod: "monthly",
    });

    const { entries } = await new LeaderboardAggregationService().aggregate({ minResponses: 4 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.medianAmount).toBe(10);
    expect(entries[0]!.responseCount).toBe(4);
  });

  it("is deterministic across runs", async () => {
    const user = await seedUser();
    await seedCategory();
    const idea = await seedIdea(String(user._id));
    await seedResponses(String(idea._id), [5, 15, 25, 35]);
    const agg = new LeaderboardAggregationService();
    const first = await agg.aggregate({ minResponses: 2 });
    const second = await agg.aggregate({ minResponses: 2 });
    const comparable = (entries: typeof first.entries) =>
      entries.map((e) => ({
        ideaId: e.ideaId,
        group: e.group,
        medianAmount: e.medianAmount,
        responseCount: e.responseCount,
        rank: e.rank,
      }));
    expect(comparable(second.entries)).toEqual(comparable(first.entries));
  });
});

describe("GET /v1/leaderboard", () => {
  async function rankedFixture() {
    const user = await seedUser();
    await seedCategory();
    const winner = await seedIdea(String(user._id));
    const runnerUp = await seedIdea(String(user._id));
    await seedResponses(String(winner._id), amounts(30, 100));
    await seedResponses(String(runnerUp._id), amounts(30, 10));
    const outcome = await runLeaderboardRefresh({ minResponses: 30 });
    if (outcome.status !== "published") throw new Error(`refresh did not publish: ${outcome.status}`);
    return { winner, runnerUp, snapshotId: outcome.snapshotId };
  }

  it("serves a valid ranked query with snapshot metadata", async () => {
    const { winner, snapshotId } = await rankedFixture();
    const res = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ rank: 1, medianAmount: 100, responseCount: 30 });
    expect(res.body.data[0].idea.id).toBe(String(winner._id));
    expect(res.body.data[0].idea.title).toBe("Test idea");
    expect(res.body.meta.snapshotId).toBe(snapshotId);
    expect(typeof res.body.meta.calculatedAt).toBe("string");
    expect(res.body.meta.group).toMatchObject({ scope: "global", currency: "USD", billingPeriod: "monthly" });
    expect(JSON.stringify(res.body)).not.toMatch(/email|userId|password/);
  });

  it("rejects missing/invalid dimensions and inconsistent scopes", async () => {
    await rankedFixture();
    const missing = await request(app).get("/v1/leaderboard?billingPeriod=monthly");
    expect(missing.status).toBe(400);
    const badCurrency = await request(app).get("/v1/leaderboard?currency=XX&billingPeriod=monthly");
    expect(badCurrency.status).toBe(400);
    const inconsistent = await request(app).get(
      "/v1/leaderboard?currency=USD&billingPeriod=monthly&countryCode=US",
    );
    expect(inconsistent.status).toBe(400);
    const noCode = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly&scope=country");
    expect(noCode.status).toBe(400);
  });

  it("rejects mismatched city/country references", async () => {
    await rankedFixture();
    await CountryModel.create({ _id: "US", name: "United States", active: true });
    await CountryModel.create({ _id: "GB", name: "United Kingdom", active: true });
    const london = await CityModel.create({ displayName: "London", countryCode: "GB", active: true });
    const mismatch = await request(app).get(
      `/v1/leaderboard?currency=USD&billingPeriod=monthly&scope=city&countryCode=US&cityId=${String(london._id)}`,
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe("CITY_COUNTRY_MISMATCH");
    const unknown = await request(app).get(
      "/v1/leaderboard?currency=USD&billingPeriod=monthly&scope=country&countryCode=XX",
    );
    expect(unknown.status).toBe(404);
  });

  it("paginates stably without duplicates", async () => {
    const user = await seedUser();
    await seedCategory();
    for (let i = 0; i < 3; i += 1) {
      const idea = await seedIdea(String(user._id));
      await seedResponses(String(idea._id), amounts(30, (i + 1) * 10));
    }
    const outcome = await runLeaderboardRefresh({ minResponses: 30 });
    expect(outcome.status).toBe("published");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const qs = cursor
        ? `?currency=USD&billingPeriod=monthly&limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?currency=USD&billingPeriod=monthly&limit=2";
      const res = await request(app).get(`/v1/leaderboard${qs}`);
      expect(res.status).toBe(200);
      for (const entry of res.body.data as Array<{ id?: string; rank: number }>) {
        const key = String(entry.rank);
        expect(seen).not.toContain(key);
        seen.push(key);
      }
      if (!res.body.meta.hasMore) {
        expect(res.body.meta.nextCursor).toBeNull();
        break;
      }
      cursor = res.body.meta.nextCursor as string;
    }
    expect(seen.sort()).toEqual(["1", "2", "3"]);

    const badCursor = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly&cursor=nope!!!");
    expect(badCursor.status).toBe(400);
  });

  it("hides unpublished and below-threshold ideas without leaking aggregates", async () => {
    const user = await seedUser();
    await seedCategory();
    const archived = await seedIdea(String(user._id), { status: "archived" });
    await seedResponses(String(archived._id), amounts(30, 5000));
    const thin = await seedIdea(String(user._id));
    await seedResponses(String(thin._id), amounts(5, 1));
    const fat = await seedIdea(String(user._id));
    await seedResponses(String(fat._id), amounts(30, 20));
    await runLeaderboardRefresh({ minResponses: 30 });

    const res = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly");
    expect(res.body.data).toHaveLength(1);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("5000");
    expect(body).not.toContain(String(archived._id));
    expect(body).not.toContain(String(thin._id));
  });

  it("returns the documented empty response when no snapshot exists", async () => {
    const res = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: [] });
    expect(res.body.meta.available).toBe(false);
  });
});

describe("GET /v1/leaderboard/ideas/:ideaId", () => {
  it("returns the ranked entry or a consistent not-found", async () => {
    const user = await seedUser();
    await seedCategory();
    const ranked = await seedIdea(String(user._id));
    const unranked = await seedIdea(String(user._id));
    await seedResponses(String(ranked._id), amounts(30, 77));
    await seedResponses(String(unranked._id), amounts(2, 5));
    await runLeaderboardRefresh({ minResponses: 30 });

    const hit = await request(app).get(
      `/v1/leaderboard/ideas/${String(ranked._id)}?currency=USD&billingPeriod=monthly`,
    );
    expect(hit.status).toBe(200);
    expect(hit.body.data).toMatchObject({ rank: 1, medianAmount: 77, responseCount: 30 });

    const miss = await request(app).get(
      `/v1/leaderboard/ideas/${String(unranked._id)}?currency=USD&billingPeriod=monthly`,
    );
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe("NOT_RANKED");

    const badId = await request(app).get("/v1/leaderboard/ideas/nope?currency=USD&billingPeriod=monthly");
    expect(badId.status).toBe(404);
  });
});

describe("GET /v1/leaderboard/status", () => {
  it("reports inactive before the first publish and active after", async () => {
    const empty = await request(app).get("/v1/leaderboard/status");
    expect(empty.body.data).toMatchObject({ active: false, snapshotId: null });

    const user = await seedUser();
    await seedCategory();
    const idea = await seedIdea(String(user._id));
    await seedResponses(String(idea._id), amounts(30, 10));
    await runLeaderboardRefresh({ minResponses: 30 });

    const live = await request(app).get("/v1/leaderboard/status");
    expect(live.body.data).toMatchObject({ active: true, entryCount: 1, refreshRunning: false });
    expect(typeof live.body.data.snapshotId).toBe("string");
    expect(typeof live.body.data.calculatedAt).toBe("string");
    expect(JSON.stringify(live.body)).not.toMatch(/mongodb:\/\//i);
  });
});

describe("snapshot integrity", () => {
  it("preserves the previous snapshot when calculation fails", async () => {
    const user = await seedUser();
    await seedCategory();
    const idea = await seedIdea(String(user._id));
    await seedResponses(String(idea._id), amounts(30, 10));
    const first = await runLeaderboardRefresh({ minResponses: 30 });
    expect(first.status).toBe("published");

    const failingAggregation = {
      aggregate: async () => {
        throw new Error("boom");
      },
    };
    const failed = await runLeaderboardRefresh({
      minResponses: 30,
      aggregation: failingAggregation as unknown as LeaderboardAggregationService,
    });
    expect(failed.status).toBe("failed");

    const res = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.snapshotId).toBe(first.status === "published" ? first.snapshotId : "");
  });

  it("serves the API from the active snapshot during a failed refresh", async () => {
    const user = await seedUser();
    await seedCategory();
    const idea = await seedIdea(String(user._id));
    await seedResponses(String(idea._id), amounts(30, 33));
    await runLeaderboardRefresh({ minResponses: 30 });
    const before = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly");
    await runLeaderboardRefresh({
      minResponses: 30,
      aggregation: {
        aggregate: async () => {
          throw new Error("db gone");
        },
      } as unknown as LeaderboardAggregationService,
    });
    const after = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly");
    expect(after.body).toEqual(before.body);
  });

  it("never mixes snapshots and publishes sequentially", async () => {
    const user = await seedUser();
    await seedCategory();
    const idea = await seedIdea(String(user._id));
    await seedResponses(String(idea._id), amounts(30, 10));
    const first = await runLeaderboardRefresh({ minResponses: 30 });
    const second = await runLeaderboardRefresh({ minResponses: 30 });
    expect(first.status).toBe("published");
    expect(second.status).toBe("published");

    const repo = new LeaderboardRepository();
    const active = await repo.getActive();
    expect(active).not.toBeNull();
    const status = await request(app).get("/v1/leaderboard/status");
    expect(status.body.data.generation).toBe(2);
    const entries = await LeaderboardEntryModel.find({ snapshotId: active!.snapshotId }).exec();
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.snapshotId))).toEqual(new Set([active!.snapshotId]));
  });

  it("keeps staged snapshots invisible and identifies abandoned ones", async () => {
    const user = await seedUser();
    await seedCategory();
    const idea = await seedIdea(String(user._id));
    await seedResponses(String(idea._id), amounts(30, 10));
    await runLeaderboardRefresh({ minResponses: 30 });

    const repo = new LeaderboardRepository();
    const active = await repo.getActive();
    await repo.stageEntries("lb_abandoned", [
      {
        ideaId: String(idea._id),
        group: { scope: "global", countryCode: null, cityId: null, currency: "USD", billingPeriod: "monthly" },
        medianAmount: 1,
        responseCount: 30,
        rank: 1,
        calculatedAt: new Date(),
      },
    ]);
    const res = await request(app).get("/v1/leaderboard?currency=USD&billingPeriod=monthly");
    expect(res.body.meta.snapshotId).toBe(active!.snapshotId);
    expect(res.body.data[0].medianAmount).toBe(10);

    // Backdate through the raw collection: Mongoose strips createdAt from
    // $set updates, so the model-level API cannot rewrite it.
    await LeaderboardEntryModel.collection.updateMany(
      { snapshotId: "lb_abandoned" },
      { $set: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) } },
    );
    const abandoned = await repo.listAbandonedSnapshotIds(new Date(Date.now() - 24 * 3600 * 1000), active!.snapshotId);
    expect(abandoned).toContain("lb_abandoned");
    expect(await repo.deleteSnapshot("lb_abandoned")).toBe(1);
    expect(await LeaderboardEntryModel.countDocuments({ snapshotId: "lb_abandoned" }).exec()).toBe(0);
  });

  it("declares the required indexes", async () => {
    await LeaderboardEntryModel.ensureIndexes();
    await LeaderboardMetadataModel.ensureIndexes();
    const all = await LeaderboardEntryModel.collection.listIndexes().toArray();
    const keys = all.map((ix) => JSON.stringify(ix.key));
    // Listing order is served by the unique rank index (same key shape).
    expect(keys).toContain(
      JSON.stringify({
        snapshotId: 1,
        scope: 1,
        countryCode: 1,
        cityId: 1,
        currency: 1,
        billingPeriod: 1,
        rank: 1,
      }),
    );
    expect(keys).toContain(JSON.stringify({ snapshotId: 1, ideaId: 1 }));
    expect(all.filter((ix) => ix.unique === true).length).toBeGreaterThanOrEqual(2);
  });

  it("rejects duplicate idea entries inside one snapshot group", async () => {
    const entry = {
      snapshotId: "lb_dup",
      ideaId: new mongoose.Types.ObjectId(),
      scope: "global" as const,
      countryCode: null,
      cityId: null,
      currency: "USD",
      billingPeriod: "monthly" as const,
      medianAmount: 10,
      responseCount: 30,
      rank: 1,
      calculatedAt: new Date(),
    };
    await LeaderboardEntryModel.create(entry);
    await expect(LeaderboardEntryModel.create(entry)).rejects.toMatchObject({ code: 11000 });
  });
});
