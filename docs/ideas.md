# Ideas module

Backend for idea publishing, discovery, categories, and locations.
No pricing responses, medians, ranks, or leaderboard logic live here.

## Endpoints

| Method & path | Auth | Description |
| --- | --- | --- |
| `GET /v1/ideas` | no | Published listing. Query: `category?`, `sort=newest`\|`popular` (default `newest`), `scope=global`\|`country`\|`city` (default `global`), `country?`, `cityId?`, `limit` 1–50 (default 20), `cursor?` |
| `GET /v1/ideas/categories` | no | Active categories in display order |
| `GET /v1/ideas/:id` | no | Published idea by id, else 404 |
| `GET /v1/ideas/:id/navigation` | no | `{ previousId, currentId, nextId }` under the same filters; null at boundaries |
| `POST /v1/ideas` | Bearer | Create idea; `creatorId` from context, status always `published` |
| `GET /v1/me/ideas` | Bearer | Own ideas, optional `?status=published`\|`archived`, cursor pagination |
| `GET /v1/locations/countries` | no | Active countries `[{ code, name }]` |
| `GET /v1/locations/countries/:countryCode/cities` | no | Cities of a country; `?search=` prefix, `?limit=` 1–50, `?cursor=` |

### Envelopes

Success: `{ "success": true, "data": {}, "meta": { "limit", "nextCursor", "hasMore" } }`.
Error: `{ "success": false, "error": { "code", "message", "details": [] }, "requestId": "..." }`
(`X-Request-Id` header mirrors `requestId`). Auth routes keep their legacy
`{ code, message }` shape; only the ideas surface uses the envelope.

### Location visibility (contract)

- `scope=global` (default): every published idea, no location params. Extra
  `country`/`cityId` params are rejected with 400.
- `scope=country&country=XX`: country must exist and be active (else 404);
  returns global ideas plus ideas targeted at XX (country-scoped, and
  city-scoped ideas whose stored `countryCode` is XX).
- `scope=city&country=XX&cityId=YY`: both required; the city must exist,
  be active, and belong to XX (else 400 `CITY_COUNTRY_MISMATCH`); returns
  global ideas, country-scoped ideas of XX, and city YY itself.

### Navigation behavior

Accepts the same `category`/`sort`/`scope`/`country`/`cityId` filters as
the listing (no cursor). `sort=popular` returns 400
`POPULAR_SORT_UNAVAILABLE`. If the current idea is unpublished → 404
`IDEA_NOT_FOUND`. If it is published but falls outside the selected
filters → 404 `IDEA_NOT_IN_FILTER`. Otherwise two bounded `limit: 1`
queries fetch the nearest newer (`previousId`) and older (`nextId`)
neighbors — the full result set is never loaded.

### Popular sort

`sort=popular` returns 400 `POPULAR_SORT_UNAVAILABLE` everywhere until the
leaderboard module provides real statistics. Scores are never invented.

## Schema fields & normalization

Idea (`creatorId` ref User; Mongoose timestamps; no email/stats/scores stored):

- `title`: trimmed, 3–120 chars. `pitch`: trimmed, 10–300 chars.
  `abstract`: trimmed, non-empty, **≤ 120 words** (whitespace-split count).
- `category`: canonical slug, stored lowercase; must reference an active
  category (lookup is case-insensitive, storage is canonical).
- `tags`: each trimmed → lowercase, 1–30 chars (`letters/numbers/space/-`),
  max 10, de-duplicated. Client casing/duplicates are normalized, never stored raw.
- `targetMarket.scope`: `global`|`country`|`city`. `countryCode`: uppercase
  ISO alpha-2 or null (required for country/city, forbidden for global).
  `cityId`: City ObjectId or null (city scope only).
- `pricing.currency`: uppercased, must be an active ISO 4217 code
  (allowlist in `idea.validators.ts`). `pricing.billingPeriod`:
  `one_time`|`weekly`|`monthly`|`yearly`.
- `status`: service-owned (`published` on create). The create schema has no
  `creatorId`/`status`/timestamp/statistic fields, so mass assignment is
  impossible by construction.

Category: `{ slug (unique, lowercased on save), name, active, order }`.
Slug uniqueness is enforced by a unique index, so `Fintech` vs `fintech`
collides at the database level.

Country: `_id` is the uppercase alpha-2 code (stable identifier),
`{ name, active }`. City: `{ displayName, name (lowercased), countryCode,
slug (unique per country), externalId?, active }`; slug auto-derives from
the display name. Cities reference countries by code; cross-country
mismatches are rejected at the service layer.

## Indexes

Ideas: `{status, createdAt:-1, _id:-1}` (newest listing),
`{status, category, createdAt:-1, _id:-1}`,
`{status, targetMarket.countryCode, createdAt:-1, _id:-1}`,
`{creatorId, status, createdAt:-1, _id:-1}` (personal history).
Categories: unique `{slug}`, plus `{active, order, name}` for the ordered list.
Cities: unique `{countryCode, slug}`, plus `{countryCode, name, _id}` backing
anchored prefix search (`^prefix` on the normalized name — index-backed, no
full-collection regex scans).

Verified with `explain()`: the country-filtered listing resolves to an
`IXSCAN` on `status_1_createdAt_-1__id_-1` (no `COLLSCAN`); the dedicated
country/category indexes serve selective filters as data grows. Indexes are
created by Mongoose `autoIndex` in development/test. For production, either
keep `autoIndex` enabled for this small index set or run `Model.ensureIndexes()`
during a controlled deploy step — do not assume indexes exist without one of these.

## Pagination

Opaque `base64url({ t: createdAtISO, id: _id })` cursors. Listing sorts
`createdAt` desc with `_id` desc tie-break, fetches `limit + 1`, and returns
`{ nextCursor, hasMore }`. City search paginates on `(name asc, _id asc)`.

## Database setup & seeds

```bash
# start MongoDB locally, then (MONGODB_URI respected):
npx tsx src/scripts/seed-categories.ts  # 10 categories, idempotent
npx tsx src/scripts/seed-countries.ts   # 16 countries, idempotent
npx tsx src/scripts/seed-cities.ts      # 12 cities, idempotent (skips unknown countries)
```

Re-running any script reports `upserted=0` with unchanged totals.

## Examples

```bash
curl 'localhost:3000/v1/ideas?limit=5'
# {"success":true,"data":[{...}],"meta":{"limit":5,"nextCursor":"...","hasMore":true}}

curl -X POST localhost:3000/v1/ideas \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"title":"Pay-per-use API analytics","pitch":"Usage-based analytics for indie hackers.","abstract":"A short abstract of the idea.","category":"fintech","tags":["API"],"targetMarket":{"scope":"country","countryCode":"US","cityId":null},"pricing":{"currency":"USD","billingPeriod":"monthly"}}'
# 201 {"success":true,"data":{"id":"...","creatorId":"...","status":"published",...},"meta":{}}

curl 'localhost:3000/v1/ideas/<ID>/navigation?scope=country&country=US'
# {"success":true,"data":{"previousId":"...","currentId":"...","nextId":null},"meta":{}}

curl 'localhost:3000/v1/locations/countries/US/cities?search=new&limit=5'
```

## Limitations

- `sort=popular` is an explicit 400 until leaderboard statistics exist.
- No full-text search; city search is prefix-only on normalized names.
- Currency allowlist covers active national ISO 4217 codes only
  (supranational codes like XAU/XDR are rejected).
- Auth routes keep their pre-existing `{ code, message }` error shape.
