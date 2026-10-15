import { connectMongo, disconnectMongo } from "../db/mongodb.js";
import { CountryModel } from "../modules/locations/country.model.js";

// Small development subset (not a complete dataset).
const COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "CA", name: "Canada" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "IN", name: "India" },
  { code: "BR", name: "Brazil" },
  { code: "AU", name: "Australia" },
  { code: "JP", name: "Japan" },
  { code: "SG", name: "Singapore" },
  { code: "NL", name: "Netherlands" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "MX", name: "Mexico" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "ZA", name: "South Africa" },
];

async function main(): Promise<void> {
  await connectMongo();
  let upserted = 0;
  for (const c of COUNTRIES) {
    const res = await CountryModel.updateOne(
      { _id: c.code },
      { $setOnInsert: { _id: c.code }, $set: { name: c.name, active: true } },
      { upsert: true },
    ).exec();
    if (res.upsertedCount > 0) upserted += 1;
  }
  const total = await CountryModel.countDocuments({}).exec();
  console.log(`seed-countries: upserted=${upserted} total=${total}`);
  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
