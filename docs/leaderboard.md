# Leaderboard module

Ranks ideas by real willingness-to-pay responses. Aggregates live in
dedicated snapshot collections — never inside Idea or PricingResponse
documents, which are never duplicated or modified here.

## Ranking semantics

Primary metric: **median** eligible amount, descending. Tie-breakers:
eligible response count descending, then idea ObjectId ascending
(deterministic total order). Response count and median stay separate
metrics; no composite popularity score exists.

An idea is ranked only with **≥ `LEADERBOARD_MIN_RESPONSES` (default 30)**
eligible responses in its comparison group.

## Eligibility

A response counts only when its idea exists and is published, its amount
is finite and positive, and its currency **and** billing period exactly
match the idea's configured pricing. Archived ideas and mismatched
responses are excluded, and below-threshold ideas expose nothing (no
hidden medians, ranks, or counts) through public endpoints.

## Comparison groups

Money is compared only inside identical
`(scope, countryCode, cityId, currency, billingPeriod)` tuples — never
across currencies or billing periods, never annualized or converted.
Grouping follows the idea's own target scope (global ideas rank globally,
country ideas in their country group, city ideas in their city group);
scopes are never mixed in one ranking. There are no product-wide currency
or billing defaults, so both query parameters are always required.

## Median

Odd counts take the middle value of the ascending amounts; even counts
take the mean of the two middles. Submissions are never rounded before the
calculation. Amounts are stored as JavaScript numbers (≤2 decimals, exact
in range); the stored median keeps full precision and output is rounded to
2 decimals only at serialization (`serializeMedian`).

## Snapshots

- Each refresh mints `snapshotId = lb_<time>_<rand>`, stages entries (still
  invisible — readers only query the active id), validates rank contiguity
  `1..n` per group from the database, then publishes via one atomic
  `findOneAndUpdate` on the metadata pointer guarded by a fencing
  `generation`. Stale runs (lease expired, newer publish won) drop their
  own staging and never overwrite.
- Readers resolve the active snapshot first, then read only its rows.
- Empty results are never published: a run with zero eligible entries
  keeps the previous snapshot. Failed runs preserve it by construction
  (nothing is deleted before a replacement publishes).
- Stale snapshots (not active, older than a cutoff) are listed by
  `listAbandonedSnapshotIds` and removed with `deleteSnapshot` — never the
  active id. No automatic deletion is wired; run cleanup as an ops task.

## Endpoints (all under `/v1/leaderboard`, public)

- `GET /v1/leaderboard?scope=&countryCode=&cityId=&currency=&billingPeriod=&limit=&cursor=`
  → ranked entries with public idea DTOs, plus `meta { snapshotId,
  calculatedAt, group, nextCursor, hasMore }`. Rank-based cursor
  (`{rank}`), validated. No active snapshot → `200` empty with
  `meta.available: false` (never fabricated data; no live ranking).
- `GET /v1/leaderboard/ideas/:ideaId` (same dimensions) → rank, median,
  count, idea DTO; unranked → `404 NOT_RANKED`; never a live median.
- `GET /v1/leaderboard/status` → `{ active, snapshotId, calculatedAt,
  generation, entryCount, refreshRunning }`. No credentials, connection
  strings, or stack traces. There is no public refresh trigger.

## Aggregation approach

`LeaderboardAggregationService` streams published ideas in `_id` batches
(default 200) and fetches one idea's ascending amounts at a time, so the
response collection is never loaded into memory. Cost is O(ideas) indexed
queries; at very large catalogs this should move to a `$group`-based
pipeline. Deterministic and idempotent per dataset + configuration.

## Scheduler (in-process)

`node-cron` inside the Express process — no workers, queues, or CronJobs.
`createLeaderboardScheduler()` only constructs; `server.ts` calls
`start()` exactly once (imports never schedule). Configuration:
`LEADERBOARD_CRON_SCHEDULE` (default `*/15 * * * *`, validated at startup —
invalid values crash fast with a clear message), `LEADERBOARD_TIMEZONE`
(IANA, default `UTC`), `LEADERBOARD_MIN_RESPONSES=30`,
`LEADERBOARD_LOCK_TTL_SECONDS=300` (default), `LEADERBOARD_ENABLED`
(`false`/`0`/`no`/`off` disables; tests never start it since they use
`createApp`, not `server.ts`).

- Startup runs one guarded refresh via `setImmediate` — never blocks HTTP.
- Local boolean prevents same-process overlap; a MongoDB distributed lock
  (`leaderboard_locks`: atomic acquire on expired-or-absent,
  owner-scoped release, lease expiry recovers crashes) prevents
  cross-replica overlap, and the generation fence blocks stale publishes.
- Every outcome (published / empty-skipped / skipped / stale / failed) is
  logged with snapshot id and duration; failures keep the old snapshot and
  always release the lock. `stop(timeout)` halts future ticks and awaits
  an in-flight refresh within a bounded period (SIGTERM/SIGINT wired).
- Single-replica deployments are fully safe; the distributed lock makes
  multi-replica scheduling safe too (no fencing gaps: losers delete only
  their own staging).

## Indexes

Entries: unique `(snapshotId, scope, countryCode, cityId, currency,
billingPeriod, ideaId)` (no dup entries), unique same-prefix `+ rank`
(serves listing order directly), `(snapshotId, ideaId)` (position lookup).
Locks: `{ expiresAt: 1 }`. Follows project convention (Mongoose autoIndex
in dev/test; controlled `ensureIndexes()` step for production).

## Examples

```bash
curl 'localhost:3000/v1/leaderboard?currency=USD&billingPeriod=monthly&limit=5'
curl 'localhost:3000/v1/leaderboard?scope=country&countryCode=US&currency=USD&billingPeriod=monthly'
curl 'localhost:3000/v1/leaderboard/ideas/<IDEA_ID>?currency=USD&billingPeriod=monthly'
curl localhost:3000/v1/leaderboard/status
```

## Limitations

- In-memory boolean aside, overlap safety across replicas depends on the
  Mongo lock row — co-located with data, no extra infrastructure.
- Median serialization rounds half away from zero via `Math.round`
  (deterministic; documented, not banker's rounding).
- Ideas deleted after a snapshot are skipped at read time (never fabricated).
