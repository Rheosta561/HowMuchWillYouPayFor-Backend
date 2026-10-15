import { createApp } from "./app.js";
import { connectMongo, disconnectMongo } from "./db/mongodb.js";
import { env } from "./config/env.js";
import {
  createLeaderboardScheduler,
  isSchedulerEnabled,
  type LeaderboardScheduler,
} from "./modules/leaderboard/leaderboard.scheduler.js";

let scheduler: LeaderboardScheduler | null = null;

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}; shutting down`);
  try {
    await scheduler?.stop(10_000);
  } finally {
    await disconnectMongo();
  }
  process.exit(0);
}

async function main(): Promise<void> {
  await connectMongo();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`howmuchwillyoupayfor listening on :${env.PORT}`);
  });

  // In-process leaderboard refresh. Registered exactly once, only in the
  // server entrypoint (never from createApp, so tests never schedule jobs).
  // Disabled via LEADERBOARD_ENABLED=false or in the test environment.
  if (isSchedulerEnabled() && env.NODE_ENV !== "test") {
    scheduler = createLeaderboardScheduler();
    scheduler.start(); // throws on invalid cron: fail fast with a clear message
  } else {
    console.log("leaderboard scheduler disabled");
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      server.close(() => {
        void shutdown(signal);
      });
    });
  }
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
