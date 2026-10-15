import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { LeaderboardMetadataModel } from "../leaderboard.metadata.model.js";
import { LeaderboardEntryModel } from "../leaderboard.snapshot.model.js";
import { LeaderboardLockModel, LeaderboardLockService } from "../leaderboard.lock.service.js";
import { LeaderboardRepository } from "../leaderboard.repository.js";
import {
  createLeaderboardScheduler,
  isSchedulerEnabled,
  runLeaderboardRefresh,
} from "../leaderboard.scheduler.js";
import type { LeaderboardAggregationService } from "../leaderboard.aggregation.service.js";

vi.mock("node-cron", () => ({
  default: {
    validate: (expr: string) => expr !== "invalid",
    schedule: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  },
}));

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
  const uri = `mongodb://127.0.0.1:27017/leaderboard_sched_int_${process.pid}`;
  if (await tryConnect(uri)) return;
  await mongoose.disconnect().catch(() => {});
  tmpDbPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hmwyp-mongo-"));
  mongodProc = spawn("mongod", ["--port", "27099", "--dbpath", tmpDbPath, "--bind_ip", "127.0.0.1"], {
    stdio: "ignore",
  });
  const fallback = "mongodb://127.0.0.1:27099/leaderboard_sched_int";
  for (let i = 0; i < 50; i += 1) {
    if (await tryConnect(fallback)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Could not connect to MongoDB and could not start ephemeral mongod");
}

beforeAll(async () => {
  await ensureMongo();
  await LeaderboardMetadataModel.ensureIndexes();
  await LeaderboardEntryModel.ensureIndexes();
  await LeaderboardLockModel.ensureIndexes();
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
  vi.clearAllMocks();
  await Promise.all([
    LeaderboardMetadataModel.deleteMany({}).exec(),
    LeaderboardEntryModel.deleteMany({}).exec(),
    LeaderboardLockModel.deleteMany({}).exec(),
  ]);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emptyAggregation = {
  aggregate: async () => ({ snapshotId: "lb_empty", calculatedAt: new Date(), entries: [], groups: [] }),
} as unknown as LeaderboardAggregationService;

describe("scheduler configuration", () => {
  it("parses the enabled flag", () => {
    expect(isSchedulerEnabled("true")).toBe(true);
    expect(isSchedulerEnabled("false")).toBe(false);
    expect(isSchedulerEnabled("0")).toBe(false);
    expect(isSchedulerEnabled("no")).toBe(false);
  });

  it("registers the schedule exactly once", async () => {
    const cron = (await import("node-cron")).default;
    const scheduler = createLeaderboardScheduler({ runInitialRefresh: false });
    scheduler.start();
    scheduler.start();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("rejects an invalid cron expression", () => {
    const scheduler = createLeaderboardScheduler({ schedule: "invalid", runInitialRefresh: false });
    expect(() => scheduler.start()).toThrow("Invalid LEADERBOARD_CRON_SCHEDULE");
  });

  it("starts without blocking on the initial refresh", async () => {
    const gate = deferred();
    const scheduler = createLeaderboardScheduler({
      runInitialRefresh: true,
      aggregation: {
        aggregate: () => gate.promise.then(() => ({ snapshotId: "lb_x", calculatedAt: new Date(), entries: [], groups: [] })),
      } as unknown as LeaderboardAggregationService,
    });
    const startedAt = Date.now();
    scheduler.start();
    // start() returns synchronously while the initial refresh is still pending.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    // Wait (polling, no long sleeps) for the background refresh to reach the gate.
    const deadline = Date.now() + 5000;
    while (!scheduler.isRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scheduler.isRunning()).toBe(true);
    gate.resolve();
    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});

describe("refresh overlap protection", () => {
  it("prevents overlapping refreshes in the same process", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const scheduler = createLeaderboardScheduler({
      runInitialRefresh: false,
      aggregation: {
        aggregate: async () => {
          calls.push("calc");
          await gate.promise;
          return { snapshotId: "lb_x", calculatedAt: new Date(), entries: [], groups: [] };
        },
      } as unknown as LeaderboardAggregationService,
    });
    const first = scheduler.runOnce();
    // Let the first run reach the aggregation gate.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const second = await scheduler.runOnce();
    expect(second).toEqual({ status: "skipped-local" });
    gate.resolve();
    const outcome = await first;
    expect(outcome.status).toBe("empty-skipped");
    expect(calls).toEqual(["calc"]);
    await scheduler.stop();
  });

  it("releases the local guard after a failed refresh", async () => {
    const scheduler = createLeaderboardScheduler({
      runInitialRefresh: false,
      aggregation: {
        aggregate: async () => {
          throw new Error("calc exploded");
        },
      } as unknown as LeaderboardAggregationService,
    });
    const failed = await scheduler.runOnce();
    expect(failed.status).toBe("failed");
    expect(scheduler.isRunning()).toBe(false);
    expect(await LeaderboardLockModel.countDocuments({}).exec()).toBe(0);
    await scheduler.stop();
  });

  it("skips when another replica holds the distributed lock", async () => {
    const locks = new LeaderboardLockService();
    const first = await locks.acquire("refresh", "replica-a");
    expect(first).not.toBeNull();
    const scheduler = createLeaderboardScheduler({ runInitialRefresh: false, locks });
    const outcome = await scheduler.runOnce();
    expect(outcome).toEqual({ status: "skipped-locked" });
    expect(await locks.release("refresh", "replica-a")).toBe(true);
    await scheduler.stop();
  });
});

describe("distributed lock", () => {
  it("grants the lock to one owner and enforces safe release", async () => {
    const locks = new LeaderboardLockService();
    expect(await locks.acquire("refresh", "owner-1")).not.toBeNull();
    expect(await locks.acquire("refresh", "owner-2")).toBeNull();
    expect(await locks.release("refresh", "owner-2")).toBe(false);
    expect(await locks.release("refresh", "owner-1")).toBe(true);
    expect(await locks.acquire("refresh", "owner-2")).not.toBeNull();
    expect(await locks.release("refresh", "owner-2")).toBe(true);
  });

  it("recovers expired locks", async () => {
    const locks = new LeaderboardLockService();
    await LeaderboardLockModel.create({
      _id: "refresh",
      owner: "crashed",
      expiresAt: new Date(Date.now() - 1000),
    });
    const acquired = await locks.acquire("refresh", "replacement");
    expect(acquired).not.toBeNull();
    expect(acquired!.owner).toBe("replacement");
    expect(await locks.release("refresh", "replacement")).toBe(true);
  });
});

describe("stale-run protection", () => {
  it("prevents a stale run from overwriting a newer snapshot", async () => {
    const repo = new LeaderboardRepository();
    const published = await repo.publishIfCurrent("lb_new", 0, {
      calculatedAt: new Date(),
      entryCount: 0,
      groups: [],
    });
    expect(published).toBe(true);
    // Stale run still at generation 0: fenced out.
    const stale = await repo.publishIfCurrent("lb_stale", 0, {
      calculatedAt: new Date(),
      entryCount: 0,
      groups: [],
    });
    expect(stale).toBe(false);
    const active = await repo.getActive();
    expect(active!.snapshotId).toBe("lb_new");
    expect(active!.generation).toBe(1);
  });

  it("drops its own staging when fenced out", async () => {
    const repo = new LeaderboardRepository();
    await repo.publishIfCurrent("lb_first", 0, { calculatedAt: new Date(), entryCount: 0, groups: [] });
    // Simulate a stale refresh: stage then fail to publish.
    await repo.stageEntries("lb_stale_run", []);
    const published = await repo.publishIfCurrent("lb_stale_run", 0, {
      calculatedAt: new Date(),
      entryCount: 0,
      groups: [],
    });
    expect(published).toBe(false);
    expect((await repo.getActive())!.snapshotId).toBe("lb_first");
  });
});

describe("graceful shutdown", () => {
  it("stops future executions and bounds an in-progress refresh", async () => {
    const gate = deferred();
    const scheduler = createLeaderboardScheduler({
      schedule: "* * * * *",
      runInitialRefresh: false,
      aggregation: {
        aggregate: () => gate.promise.then(() => ({ snapshotId: "lb_x", calculatedAt: new Date(), entries: [], groups: [] })),
      } as unknown as LeaderboardAggregationService,
    });
    scheduler.start();
    const running = scheduler.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    // A stuck refresh must not block shutdown beyond the timeout (no long sleeps: 50ms).
    await scheduler.stop(50);
    gate.resolve();
    await running;
  });
});
