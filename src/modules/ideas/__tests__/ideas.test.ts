import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Express } from "express";
import { createApp } from "../../../app.js";
import { IdeaModel } from "../idea.model.js";
import { CategoryModel } from "../../categories/category.model.js";
import { CountryModel } from "../../locations/country.model.js";
import { CityModel } from "../../locations/city.model.js";
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
  const uri = `mongodb://127.0.0.1:27017/ideas_int_${process.pid}`;
  if (await tryConnect(uri)) return;
  await mongoose.disconnect().catch(() => {});
  tmpDbPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hmwyp-mongo-"));
  mongodProc = spawn("mongod", ["--port", "27099", "--dbpath", tmpDbPath, "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const fallback = "mongodb://127.0.0.1:27099/ideas_int";
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
    IdeaModel.deleteMany({}).exec(),
    CategoryModel.deleteMany({}).exec(),
    CountryModel.deleteMany({}).exec(),
    CityModel.deleteMany({}).exec(),
    UserModel.deleteMany({}).exec(),
  ]);
});

const app: Express = createApp();
const tokens = new TokenService();

async function seedCategory(slug = "fintech", name = "Fintech", order = 1) {
  return CategoryModel.create({ slug, name, order, active: true });
}

async function seedCountry(code = "US", name = "United States") {
  return CountryModel.create({ _id: code, name, active: true });
}

async function seedCity(displayName: string, countryCode: string) {
  return CityModel.create({ displayName, countryCode, active: true });
}

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

interface IdeaSeed {
  creatorId: string;
  title?: string;
  category?: string;
  scope?: "global" | "country" | "city";
  countryCode?: string | null;
  cityId?: string | null;
  status?: "published" | "archived";
}

async function seedIdea(seed: IdeaSeed) {
  return IdeaModel.create({
    creatorId: seed.creatorId,
    title: seed.title ?? `Idea ${Math.random().toString(36).slice(2)}`,
    pitch: "A concise pitch describing the idea value proposition.",
    abstract: "An abstract describing the idea in a few sentences for evaluation.",
    category: seed.category ?? "fintech",
    tags: ["test"],
    targetMarket: {
      scope: seed.scope ?? "global",
      countryCode: seed.countryCode ?? null,
      cityId: seed.cityId ?? null,
    },
    pricing: { currency: "USD", billingPeriod: "monthly" },
    status: seed.status ?? "published",
  });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Pay-per-use API analytics",
    pitch: "Usage-based analytics—the pitch stays well under the limit here.",
    abstract: "A short abstract describing the product idea and its audience.",
    category: "fintech",
    tags: ["Analytics", "API"],
    targetMarket: { scope: "global", countryCode: null, cityId: null },
    pricing: { currency: "usd", billingPeriod: "monthly" },
    ...overrides,
  };
}

describe("public listing and details", () => {
  it("lists published ideas newest-first inside the success envelope", async () => {
    const { user } = await seedUser();
    await seedCategory();
    await seedIdea({ creatorId: String(user._id), title: "Oldest" });
    await seedIdea({ creatorId: String(user._id), title: "Newest" });

    const res = await request(app).get("/v1/ideas");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.map((d: { title: string }) => d.title)).toEqual(["Newest", "Oldest"]);
    expect(res.body.meta).toMatchObject({ limit: 20, hasMore: false });
    // DTO exposes no email, stats, or internal fields.
    expect(JSON.stringify(res.body)).not.toMatch(/email|median|rank|responseCount|tokenHash/);
  });

  it("returns a published idea by id", async () => {
    const { user } = await seedUser();
    await seedCategory();
    const doc = await seedIdea({ creatorId: String(user._id) });
    const res = await request(app).get(`/v1/ideas/${String(doc._id)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(String(doc._id));
    expect(res.body.data.creatorId).toBe(String(user._id));
  });

  it("rejects unsupported popular sort with a clear error", async () => {
    const res = await request(app).get("/v1/ideas?sort=popular");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("POPULAR_SORT_UNAVAILABLE");
  });
});

describe("unpublished isolation", () => {
  it("hides archived ideas from listing and details", async () => {
    const { user } = await seedUser();
    await seedCategory();
    const archived = await seedIdea({ creatorId: String(user._id), status: "archived" });
    const res = await request(app).get("/v1/ideas");
    expect(res.body.data).toHaveLength(0);
    const detail = await request(app).get(`/v1/ideas/${String(archived._id)}`);
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe("IDEA_NOT_FOUND");
  });
});

describe("authenticated creation", () => {
  it("creates an idea with creatorId from context and returns 201 DTO", async () => {
    const { user, accessToken } = await seedUser();
    await seedCategory();
    const res = await request(app)
      .post("/v1/ideas")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(validPayload());
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.creatorId).toBe(String(user._id));
    expect(res.body.data.status).toBe("published");
    expect(res.body.data.pricing.currency).toBe("USD");
    expect(res.body.data.tags).toEqual(["analytics", "api"]);
  });

  it("requires authentication", async () => {
    await seedCategory();
    const res = await request(app).post("/v1/ideas").send(validPayload());
    expect(res.status).toBe(401);
  });

  it("ignores client-supplied creatorId and status (no mass assignment)", async () => {
    const { user, accessToken } = await seedUser();
    await seedCategory();
    const res = await request(app)
      .post("/v1/ideas")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(validPayload({ creatorId: "000000000000000000000001", status: "archived" }));
    expect(res.status).toBe(201);
    expect(res.body.data.creatorId).toBe(String(user._id));
    expect(res.body.data.status).toBe("published");
  });
});

describe("field limits", () => {
  it("enforces pitch length and abstract word-count limits", async () => {
    const { accessToken } = await seedUser();
    await seedCategory();
    const longPitch = await request(app)
      .post("/v1/ideas")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(validPayload({ pitch: "x".repeat(301) }));
    expect(longPitch.status).toBe(400);

    const longAbstract = await request(app)
      .post("/v1/ideas")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(validPayload({ abstract: Array(122).fill("word").join(" ") }));
    expect(longAbstract.status).toBe(400);

    const boundary = await request(app)
      .post("/v1/ideas")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(validPayload({ abstract: Array(120).fill("word").join(" ") }));
    expect(boundary.status).toBe(201);
  });
});

describe("categories", () => {
  it("normalizes slugs, rejects unknown categories, lists actives in order", async () => {
    const { accessToken } = await seedUser("a@example.com");
    await seedCategory("fintech", "Fintech", 2);
    await seedCategory("health", "Health", 1);
    await CategoryModel.create({ slug: "retired", name: "Retired", order: 0, active: false });

    const mixed = await request(app)
      .post("/v1/ideas")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(validPayload({ category: "FinTech" }));
    expect(mixed.status).toBe(201);
    expect(mixed.body.data.category).toBe("fintech");

    const unknown = await request(app)
      .post("/v1/ideas")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(validPayload({ category: "nope" }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("UNKNOWN_CATEGORY");

    const list = await request(app).get("/v1/ideas/categories");
    expect(list.status).toBe(200);
    expect(list.body.data.map((c: { slug: string }) => c.slug)).toEqual(["health", "fintech"]);

    const filtered = await request(app).get("/v1/ideas?category=FINTECH");
    expect(filtered.body.data).toHaveLength(1);
  });

  it("prevents duplicate slugs including capitalization variants", async () => {
    await seedCategory("fintech");
    await expect(CategoryModel.create({ slug: "Fintech", name: "Dup", order: 9 })).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe("location filters", () => {
  async function fixtures() {
    const { user } = await seedUser();
    await seedCategory();
    await seedCountry("US", "United States");
    await seedCountry("GB", "United Kingdom");
    const nyc = await seedCity("New York", "US");
    const london = await seedCity("London", "GB");
    const cid = String(user._id);
    await seedIdea({ creatorId: cid, title: "Global idea", scope: "global" });
    await seedIdea({ creatorId: cid, title: "US idea", scope: "country", countryCode: "US" });
    await seedIdea({ creatorId: cid, title: "NYC idea", scope: "city", countryCode: "US", cityId: String(nyc._id) });
    return { nyc, london };
  }

  it("applies global, country and city visibility consistently", async () => {
    const { nyc } = await fixtures();
    const titles = (b: { data: { title: string }[] }) => b.data.map((d) => d.title).sort();

    const all = await request(app).get("/v1/ideas");
    expect(titles(all.body)).toEqual(["Global idea", "NYC idea", "US idea"]);

    const us = await request(app).get("/v1/ideas?scope=country&country=US");
    expect(titles(us.body)).toEqual(["Global idea", "NYC idea", "US idea"]);

    const gb = await request(app).get("/v1/ideas?scope=country&country=GB");
    expect(titles(gb.body)).toEqual(["Global idea"]);

    const city = await request(app).get(`/v1/ideas?scope=city&country=US&cityId=${String(nyc._id)}`);
    expect(titles(city.body)).toEqual(["Global idea", "NYC idea", "US idea"]);
  });

  it("rejects mismatches and unknown locations", async () => {
    const { london } = await fixtures();
    const mismatch = await request(app).get(`/v1/ideas?scope=city&country=US&cityId=${String(london._id)}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe("CITY_COUNTRY_MISMATCH");

    const noCountry = await request(app).get("/v1/ideas?scope=country");
    expect(noCountry.status).toBe(400);

    const unknownCountry = await request(app).get("/v1/ideas?scope=country&country=XX");
    expect(unknownCountry.status).toBe(404);
    expect(unknownCountry.body.error.code).toBe("COUNTRY_NOT_FOUND");

    const unknownCity = await request(app).get("/v1/ideas?scope=city&country=US&cityId=000000000000000000000000");
    expect(unknownCity.status).toBe(404);
    expect(unknownCity.body.error.code).toBe("CITY_NOT_FOUND");

    const stray = await request(app).get("/v1/ideas?country=US");
    expect(stray.status).toBe(400);
  });

  it("serves countries and prefix-searched cities", async () => {
    await seedCountry("US", "United States");
    await seedCountry("GB", "United Kingdom");
    await seedCity("New York", "US");
    await seedCity("Newark", "US");

    const countries = await request(app).get("/v1/locations/countries");
    expect(countries.body.data).toEqual([
      { code: "GB", name: "United Kingdom" },
      { code: "US", name: "United States" },
    ]);

    const prefixed = await request(app).get("/v1/locations/countries/US/cities?search=new");
    expect(prefixed.body.data.map((c: { name: string }) => c.name).sort()).toEqual(["New York", "Newark"]);

    const missing = await request(app).get("/v1/locations/countries/XX/cities");
    expect(missing.status).toBe(404);
  });
});

describe("currency and billing validation", () => {
  it("accepts real ISO codes and rejects the rest", async () => {
    const { accessToken } = await seedUser();
    await seedCategory();
    const post = (pricing: unknown) =>
      request(app).post("/v1/ideas").set("Authorization", `Bearer ${accessToken}`).send(validPayload({ pricing }));

    expect((await post({ currency: "EUR", billingPeriod: "yearly" })).status).toBe(201);
    expect((await post({ currency: "ZZZ", billingPeriod: "monthly" })).status).toBe(400);
    expect((await post({ currency: "USD", billingPeriod: "daily" })).status).toBe(400);
  });
});

describe("cursor pagination", () => {
  it("pages deterministically without overlap or gaps", async () => {
    const { user } = await seedUser();
    await seedCategory();
    for (let i = 0; i < 25; i += 1) {
      await seedIdea({ creatorId: String(user._id), title: `Idea ${i}` });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const qs = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : "?limit=10";
      const res = await request(app).get(`/v1/ideas${qs}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids.every((id: string) => !seen.includes(id))).toBe(true);
      seen.push(...ids);
      pages += 1;
      if (!res.body.meta.hasMore) {
        expect(res.body.meta.nextCursor).toBeNull();
        break;
      }
      cursor = res.body.meta.nextCursor as string;
    }
    expect(seen).toHaveLength(25);
    expect(pages).toBe(3);

    const bad = await request(app).get("/v1/ideas?cursor=not-a-cursor!!!");
    expect(bad.status).toBe(400);
  });
});

describe("navigation", () => {
  it("returns neighbors and null boundaries", async () => {
    const { user } = await seedUser();
    await seedCategory();
    const a = await seedIdea({ creatorId: String(user._id), title: "A" });
    const b = await seedIdea({ creatorId: String(user._id), title: "B" });
    const c = await seedIdea({ creatorId: String(user._id), title: "C" });

    const mid = await request(app).get(`/v1/ideas/${String(b._id)}/navigation`);
    expect(mid.body.data).toEqual({
      previousId: String(c._id),
      currentId: String(b._id),
      nextId: String(a._id),
    });

    const newest = await request(app).get(`/v1/ideas/${String(c._id)}/navigation`);
    expect(newest.body.data).toEqual({ previousId: null, currentId: String(c._id), nextId: String(b._id) });

    const oldest = await request(app).get(`/v1/ideas/${String(a._id)}/navigation`);
    expect(oldest.body.data).toEqual({ previousId: String(b._id), currentId: String(a._id), nextId: null });
  });

  it("404s when the current idea is outside the selected filters", async () => {
    const { user } = await seedUser();
    await seedCategory();
    await seedCategory("health", "Health", 2);
    const doc = await seedIdea({ creatorId: String(user._id), category: "fintech" });
    const res = await request(app).get(`/v1/ideas/${String(doc._id)}/navigation?category=health`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("IDEA_NOT_IN_FILTER");
  });
});

describe("personal ideas", () => {
  it("isolates ownership and filters status", async () => {
    const mine = await seedUser("mine@example.com");
    const theirs = await seedUser("theirs@example.com");
    await seedCategory();
    await seedIdea({ creatorId: String(mine.user._id), title: "Mine pub" });
    const archived = await seedIdea({ creatorId: String(mine.user._id), title: "Mine arch", status: "archived" });
    await seedIdea({ creatorId: String(theirs.user._id), title: "Theirs" });

    const allMine = await request(app).get("/v1/me/ideas").set("Authorization", `Bearer ${mine.accessToken}`);
    expect(allMine.body.data.map((d: { title: string }) => d.title).sort()).toEqual(["Mine arch", "Mine pub"]);

    const onlyPub = await request(app)
      .get("/v1/me/ideas?status=published")
      .set("Authorization", `Bearer ${mine.accessToken}`);
    expect(onlyPub.body.data.map((d: { title: string }) => d.title)).toEqual(["Mine pub"]);
    expect(String(archived._id)).not.toContain("never");

    const other = await request(app).get("/v1/me/ideas").set("Authorization", `Bearer ${theirs.accessToken}`);
    expect(other.body.data.map((d: { title: string }) => d.title)).toEqual(["Theirs"]);

    const anon = await request(app).get("/v1/me/ideas");
    expect(anon.status).toBe(401);
  });
});

describe("invalid ids and error envelope", () => {
  it("returns 404 envelope with requestId for malformed ids", async () => {
    const res = await request(app).get("/v1/ideas/not-an-id");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("IDEA_NOT_FOUND");
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(typeof res.body.requestId).toBe("string");
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);

    const missing = await request(app).get("/v1/ideas/000000000000000000000000");
    expect(missing.status).toBe(404);
  });
});

describe("indexes", () => {
  it("defines the required indexes", async () => {
    await Promise.all([IdeaModel.ensureIndexes(), CategoryModel.ensureIndexes(), CityModel.ensureIndexes()]);
    const ideaKeys = (await IdeaModel.collection.listIndexes().toArray()).map((ix) => JSON.stringify(ix.key));
    expect(ideaKeys).toContain(JSON.stringify({ status: 1, createdAt: -1, _id: -1 }));
    expect(ideaKeys).toContain(JSON.stringify({ status: 1, category: 1, createdAt: -1, _id: -1 }));
    expect(ideaKeys).toContain(
      JSON.stringify({ status: 1, "targetMarket.countryCode": 1, createdAt: -1, _id: -1 }),
    );
    expect(ideaKeys).toContain(JSON.stringify({ creatorId: 1, status: 1, createdAt: -1, _id: -1 }));

    const catKeys = (await CategoryModel.collection.listIndexes().toArray()).map((ix) => ix.key);
    expect(catKeys).toContainEqual({ slug: 1 });

    const cityIndexes = await CityModel.collection.listIndexes().toArray();
    const uniqueCity = cityIndexes.find((ix) => ix.unique === true && ix.key.countryCode === 1);
    expect(uniqueCity).toBeDefined();
    expect(uniqueCity!.key).toEqual({ countryCode: 1, slug: 1 });
  });
});
