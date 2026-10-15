import { createApp } from "./app.js";
import { connectMongo } from "./db/mongodb.js";
import { env } from "./config/env.js";

async function main(): Promise<void> {
  await connectMongo();
  const app = createApp();
  app.listen(env.PORT, () => {
    console.log(`howmuchwillyoupayfor listening on :${env.PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
