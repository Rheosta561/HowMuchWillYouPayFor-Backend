import { connectMongo, disconnectMongo } from "../db/mongodb.js";
import { CategoryModel } from "../modules/categories/category.model.js";

const CATEGORIES = [
  { slug: "fintech", name: "Fintech", order: 1 },
  { slug: "health", name: "Health", order: 2 },
  { slug: "education", name: "Education", order: 3 },
  { slug: "productivity", name: "Productivity", order: 4 },
  { slug: "ecommerce", name: "E-commerce", order: 5 },
  { slug: "food-drink", name: "Food & Drink", order: 6 },
  { slug: "travel", name: "Travel", order: 7 },
  { slug: "sustainability", name: "Sustainability", order: 8 },
  { slug: "developer-tools", name: "Developer Tools", order: 9 },
  { slug: "entertainment", name: "Entertainment", order: 10 },
];

async function main(): Promise<void> {
  await connectMongo();
  let upserted = 0;
  for (const c of CATEGORIES) {
    const res = await CategoryModel.updateOne(
      { slug: c.slug },
      { $setOnInsert: { slug: c.slug }, $set: { name: c.name, order: c.order, active: true } },
      { upsert: true },
    ).exec();
    if (res.upsertedCount > 0) upserted += 1;
  }
  const total = await CategoryModel.countDocuments({}).exec();
  console.log(`seed-categories: upserted=${upserted} total=${total}`);
  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
