import { connectMongo, disconnectMongo } from "../db/mongodb.js";
import { CityModel, slugifyCityName, normalizeCityName } from "../modules/locations/city.model.js";
import { CountryModel } from "../modules/locations/country.model.js";

// Small development subset (not a complete dataset).
const CITIES = [
  { name: "New York", countryCode: "US" },
  { name: "San Francisco", countryCode: "US" },
  { name: "London", countryCode: "GB" },
  { name: "Berlin", countryCode: "DE" },
  { name: "Paris", countryCode: "FR" },
  { name: "Toronto", countryCode: "CA" },
  { name: "Bengaluru", countryCode: "IN" },
  { name: "Singapore", countryCode: "SG" },
  { name: "Sydney", countryCode: "AU" },
  { name: "Tokyo", countryCode: "JP" },
  { name: "Amsterdam", countryCode: "NL" },
  { name: "São Paulo", countryCode: "BR" },
];

async function main(): Promise<void> {
  await connectMongo();
  let upserted = 0;
  for (const c of CITIES) {
    const country = await CountryModel.findOne({ _id: c.countryCode, active: true }).exec();
    if (!country) {
      console.log(`seed-cities: skipping ${c.name} (country ${c.countryCode} not seeded)`);
      continue;
    }
    const slug = slugifyCityName(c.name);
    const res = await CityModel.updateOne(
      { countryCode: c.countryCode, slug },
      {
        $setOnInsert: { countryCode: c.countryCode, slug },
        $set: {
          displayName: c.name,
          name: normalizeCityName(c.name),
          externalId: null,
          active: true,
        },
      },
      { upsert: true },
    ).exec();
    if (res.upsertedCount > 0) upserted += 1;
  }
  const total = await CityModel.countDocuments({}).exec();
  console.log(`seed-cities: upserted=${upserted} total=${total}`);
  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
