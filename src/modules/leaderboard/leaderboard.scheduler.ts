import cron, { type ScheduledTask } from "node-cron";
import { env } from "../../config/env.js";
import { LeaderboardRepository } from "./leaderboard.repository.js";
import { LeaderboardAggregationService } from "./leaderboard.aggregation.service.js";
import { LeaderboardLockService, newOwnerId } from "./leaderboard.lock.service.js";

export type RefreshOutcome =
  | { status: "published"; snapshotId: string; groups: number; entries: number; durationMs: number }
  | { status: "empty-skipped"; snapshotId: string; durationMs: number }
  | { status: "skipped-local" }
  | { status: "skipped-locked" }
  | { status: "stale"; snapshotId: string; durationMs: number }
  | { status: "failed"; error: string; durationMs: number };

export interface SchedulerDeps {
  repository?: LeaderboardRepository;
  aggregation?: LeaderboardAggregationService;
  locks?: LeaderboardLockService;
  schedule?: string;
  timezone?: string;
  minResponses?: number;
  runInitialRefresh?: boolean;
}

export function isSchedulerEnabled(value: string = env.LEADERBOARD_ENABLED): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "no" && normalized !== "off";
}

function log(message: string): void {
  console.log(`[leaderboard] ${message}`);
}

/**
 * Single guarded refresh. Safe to invoke from the scheduler and from
 * internal tooling: the local flag stops same-process overlap and the
 * distributed lock stops cross-replica overlap. Failures never touch the
 * active snapshot and always release the guard and the lock.
 */
export async function runLeaderboardRefresh(deps: SchedulerDeps = {}): Promise<RefreshOutcome> {
  const repository = deps.repository ?? new LeaderboardRepository();
  const aggregation = deps.aggregation ?? new LeaderboardAggregationService();
  const locks = deps.locks ?? new LeaderboardLockService();
  const startedAt = Date.now();
  const owner = newOwnerId();

  log(`refresh started owner=${owner}`);
  const lock = await locks.acquire("refresh", owner);
  if (!lock) {
    log("refresh skipped: distributed lock held by another replica");
    return { status: "skipped-locked" };
  }
  try {
    const active = await repository.getActive();
    const expectedGeneration = active?.generation ?? 0;
    const result = await aggregation.aggregate({ minResponses: deps.minResponses });
    if (result.entries.length === 0) {
      log(`refresh produced no eligible entries snapshot=${result.snapshotId}; keeping previous snapshot`);
      return { status: "empty-skipped", snapshotId: result.snapshotId, durationMs: Date.now() - startedAt };
    }
    await repository.stageEntries(result.snapshotId, result.entries);
    try {
      await repository.validateStaged(result.snapshotId);
    } catch (err) {
      await repository.deleteSnapshot(result.snapshotId);
      throw err;
    }
    const published = await repository.publishIfCurrent(result.snapshotId, expectedGeneration, {
      calculatedAt: result.calculatedAt,
      entryCount: result.entries.length,
      groups: result.groups,
    });
    const durationMs = Date.now() - startedAt;
    if (!published) {
      // A newer run published first: drop our staging, keep theirs.
      await repository.deleteSnapshot(result.snapshotId);
      log(`refresh stale snapshot=${result.snapshotId}; newer snapshot already active`);
      return { status: "stale", snapshotId: result.snapshotId, durationMs };
    }
    log(
      `refresh published snapshot=${result.snapshotId} groups=${result.groups.length} ` +
        `entries=${result.entries.length} durationMs=${durationMs}`,
    );
    return {
      status: "published",
      snapshotId: result.snapshotId,
      groups: result.groups.length,
      entries: result.entries.length,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[leaderboard] refresh failed owner=${owner} error=${message}`);
    return { status: "failed", error: message, durationMs: Date.now() - startedAt };
  } finally {
    await locks.release("refresh", owner);
  }
}

export interface LeaderboardScheduler {
  start(): void;
  stop(timeoutMs?: number): Promise<void>;
  runOnce(): Promise<RefreshOutcome>;
  isRunning(): boolean;
}

/**
 * In-process scheduler. Created (not auto-started) so imports never register
 * jobs; server.ts starts exactly one instance. Timezone follows
 * LEADERBOARD_TIMEZONE (IANA name, default UTC).
 */
export function createLeaderboardScheduler(deps: SchedulerDeps = {}): LeaderboardScheduler {
  const schedule = deps.schedule ?? env.LEADERBOARD_CRON_SCHEDULE;
  const timezone = deps.timezone ?? env.LEADERBOARD_TIMEZONE;
  let task: ScheduledTask | null = null;
  let started = false;
  let running: Promise<RefreshOutcome> | null = null;

  const runOnce = (): Promise<RefreshOutcome> => {
    if (running) return Promise.resolve({ status: "skipped-local" });
    running = runLeaderboardRefresh(deps).finally(() => {
      running = null;
    });
    return running;
  };

  return {
    start(): void {
      if (started) return; // register exactly once
      if (!cron.validate(schedule)) {
        throw new Error(`Invalid LEADERBOARD_CRON_SCHEDULE: ${JSON.stringify(schedule)}`);
      }
      task = cron.schedule(
        schedule,
        () => {
          void runOnce();
        },
        { timezone },
      );
      started = true;
      log(`scheduler started schedule=${JSON.stringify(schedule)} timezone=${timezone}`);
      if (deps.runInitialRefresh ?? true) {
        // Non-blocking: HTTP serving never waits for the leaderboard.
        setImmediate(() => {
          void runOnce();
        });
      }
    },
    async stop(timeoutMs = 10_000): Promise<void> {
      task?.stop();
      task = null;
      started = false;
      if (running) {
        await Promise.race([
          running.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }
      log("scheduler stopped");
    },
    runOnce,
    isRunning(): boolean {
      return running !== null;
    },
  };
}
