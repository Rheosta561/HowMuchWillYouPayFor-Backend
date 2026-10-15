# MongoDB setup

All persistence (users, sessions, OTP challenges, ideas, responses,
categories, countries, cities) lives in MongoDB, accessed via Mongoose.
Connection string: `MONGODB_URI` (see `.env.example`).

## Local install (macOS)

```bash
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community
mongosh --eval "db.runCommand({ping:1})"   # expect { ok: 1 }
```

Linux/Windows: follow the official MongoDB Community Server docs, then
point `MONGODB_URI` at the instance.

Default URI used by the app and seeds:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/howmuchwillyoupayfor
```

## Databases

| Purpose | Database | Notes |
| --- | --- | --- |
| Development | `howmuchwillyoupayfor` | Created on first write; seeds are idempotent upserts |
| Tests | `<module>_int_<pid>` (e.g. `responses_int_12345`) | One per test file, dropped in `afterAll`; never production data |
| Test fallback | `*_int` on `127.0.0.1:27099` | Test harness boots an ephemeral `mongod` if `:27017` is unreachable |

## Seed data (development)

```bash
npx tsx src/scripts/seed-categories.ts  # 10 categories
npx tsx src/scripts/seed-countries.ts   # 16 countries
npx tsx src/scripts/seed-cities.ts      # 12 cities (skips unknown countries)
```

Re-running reports `upserted=0`; totals unchanged.

## Indexes

Schemas declare indexes inline (unique `users.emailNormalized`,
unique `{ideaId,userId}` responses, unique `{countryCode,slug}` cities,
unique category `slug`, TTL `expiresAt`, plus listing/history compounds —
see `docs/ideas.md`, `docs/responses.md`, `docs/tokens-sessions.md`).
Mongoose `autoIndex` builds them automatically in development and test.

**Production:** do not rely on `autoIndex`. Either keep it enabled
deliberately for this small index set, or run a controlled deploy step:

```bash
npx tsx -e "import('./src/db/mongodb.js').then(async ({connectMongo}) => { \
  await connectMongo(); \
  const { default: mongoose } = await import('mongoose'); \
  await mongoose.syncIndexes(); \
  process.exit(0); })"
```

Verify after deploy with `db.<collection>.getIndexes()` in `mongosh`.

## Troubleshooting

- `MongooseServerSelectionError`: `mongod` isn't running or the URI host/port is wrong.
- Tests hanging on connect: check `mongod` on `:27017`; the harness only falls back to `:27099` if `:27017` refuses (a firewalled hang, not a refusal, will stall).
- Duplicate-key `11000` on seed reruns: shouldn't happen (upserts by stable keys) — report it as a bug.
