# Pricing Responses module

Authenticated users submit at most one willing-to-pay response per
published idea. No leaderboard ranks, medians, scores, or aggregates are
created, stored, or computed here. No response data is embedded in Idea
documents.

## Endpoints

| Method & path | Auth | Description |
| --- | --- | --- |
| `POST /v1/ideas/:ideaId/responses` | Bearer + IP rate limit | Submit one response. Body: `{ "amount": 19.99 }` only |
| `GET /v1/ideas/:ideaId/responses/me` | Bearer | Caller's response for the idea, else 404 `RESPONSE_NOT_FOUND` |
| `GET /v1/me/responses` | Bearer | Caller's history, newest first, cursor pagination (`limit` 1–50 default 20, optional `ideaId` filter) |

There is deliberately no public per-idea response listing: individual price
responses of other users are never exposed.

### Envelopes

Success: `{ "success": true, "data": {...}, "meta": {} }` (201 on submit).
Errors: `{ "success": false, "error": { "code", "message", "details": [] }, "requestId" }`.
Status codes: 400 malformed IDs / invalid bodies (strict schema rejects
`userId`, `currency`, `billingPeriod`, `_id`, timestamps, and unknown
fields), 401 unauthenticated, 404 missing/archived idea (`IDEA_NOT_FOUND`)
or missing submission (`RESPONSE_NOT_FOUND`), 409 `DUPLICATE_RESPONSE`.

## Schema & validation (`response.model.ts`)

`{ ideaId ref Idea, userId ref User, amount, currency, billingPeriod, timestamps }`.
Currency and billing period are copied from the idea, never the client.
`amount` rules: required finite number, `> 0`, `≤ 100_000_000`
(`MAX_RESPONSE_AMOUNT`), at most 2 decimals (`MAX_AMOUNT_DECIMALS`).
Representation: plain JavaScript numbers in major units (e.g. dollars).
IEEE-754 doubles represent all 2-decimal values in range exactly; future
aggregation modules must sum in integer minor units (cents) rather than
accumulating floats, and no currency conversion happens here.

## Indexes

- Unique `{ ideaId: 1, userId: 1 }` — the concurrency-safe one-response
  rule (application checks alone would race; duplicate inserts raise 11000,
  mapped to 409).
- `{ userId: 1, createdAt: -1, _id: -1 }` — personal history pagination.
- No per-idea listing index: no endpoint lists an idea's responses, so it
  would be dead weight. Verified via `listIndexes` in the test suite.
- Index creation follows the project convention (Mongoose `autoIndex` in
  development/test; ensure a controlled `ensureIndexes()` deploy step for
  production).

## Concurrency

Five parallel duplicate submits yield exactly one 201 and four 409s with a
single stored document (tested). The unique index is the arbiter; the
service maps the duplicate-key error without a prior read (no TOCTOU).

## Rate limiting

`POST /:ideaId/responses` reuses the existing `express-rate-limit` IP
limiter strategy (`RESPONSES_IP_MAX`, default 60 per 15 min). No new
infrastructure was introduced.

## Examples

```bash
curl -X POST localhost:3000/v1/ideas/<IDEA_ID>/responses \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H 'Content-Type: application/json' \
  -d '{"amount":19.99}'
# 201 {"success":true,"data":{"id":"...","ideaId":"...","userId":"...",
#   "amount":19.99,"currency":"USD","billingPeriod":"monthly",
#   "createdAt":"..."},"meta":{}}

curl 'localhost:3000/v1/me/responses?limit=5' \
  -H "Authorization: Bearer <ACCESS_TOKEN>"

curl 'localhost:3000/v1/ideas/<IDEA_ID>/responses/me' \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
```

## Limitations

- Responses are immutable: no update/delete endpoints (resubmission is
  rejected with 409 by design).
- `updatedAt` is maintained by Mongoose timestamps but not exposed in the
  DTO, matching the published contract.
- No environment variables beyond the existing auth `RESPONSES_IP_MAX`
  addition; no new secrets.
