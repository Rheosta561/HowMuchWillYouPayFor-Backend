# HowMuchWillYouPayFor — Backend API

Express + TypeScript + MongoDB (Mongoose) backend for
HowMuchWillYouPayFor.org. Strategy-pattern providers (Email OTP, Google)
share one token/session system, plus normalized Ideas, Pricing Responses,
and Leaderboard snapshot modules. See `docs/ideas.md`, `docs/responses.md`,
and `docs/leaderboard.md` for the domain docs.

## Endpoint contracts

Base path: `/v1/auth` (the same router is also mounted at `/api/auth`).
All bodies are JSON. Statuses below are the actual implemented behavior.

| Method & path | Auth | Request body | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /v1/auth/email/otp/request` | IP rate limit | `{ "email": "user@example.com", "purpose": "login" }` (`purpose` optional, `signup`\|`login`) | `200 { "message": "If this email address can receive mail, a sign-in code has been sent." }` — identical for unknown and registered emails | `400 VALIDATION_ERROR`, `429 TOO_MANY_REQUESTS` (cooldown/hourly cap) |
| `POST /v1/auth/email/otp/verify` | IP rate limit | `{ "email": "user@example.com", "code": "123456" }` | New user `201`, existing `200`: `{ "user": { "id", "email", "role", "status" }, "accessToken", "refreshToken", "refreshExpiresAt", "isNewUser" }` | `400 VALIDATION_ERROR`, `401 INVALID_OR_EXPIRED_CODE` (unknown/wrong/expired — same shape), `429 TOO_MANY_ATTEMPTS`, `403 ACCOUNT_UNAVAILABLE` |
| `POST /v1/auth/google` | IP rate limit | `{ "idToken": "<google-id-token>" }` | Same contract as OTP verify (`201` new / `200` existing) | `400 VALIDATION_ERROR`, `401 GOOGLE_AUTH_FAILED` (bad/expired/audience-mismatch token), `403 EMAIL_NOT_VERIFIED`, `403 ACCOUNT_UNAVAILABLE` |
| `POST /v1/auth/refresh` | IP rate limit; CSRF header iff cookie credential | `{ "refreshToken": "<token>" }` and/or refresh cookie | `200 { "user", "accessToken", "refreshToken?", "refreshExpiresAt", "isNewUser": false }` (`refreshToken` omitted from body under cookie delivery) | `401 INVALID_REFRESH_TOKEN`, `401 REFRESH_TOKEN_REUSED` (family revoked), `403 CSRF_INVALID` |
| `POST /v1/auth/logout` | CSRF header iff cookie credential | `{ "refreshToken": "<token>" }` and/or cookie (optional; idempotent) | `200 { "message": "Signed out." }` | `403 CSRF_INVALID` |
| `POST /v1/auth/logout-all` | Bearer access token | — | `200 { "message": "Signed out everywhere.", "revoked": n }` | `401 INVALID_TOKEN` |
| `GET /v1/auth/sessions` | Bearer access token | — | `200 { "sessions": [{ "id", "provider", "createdAt", "expiresAt", "lastUsedAt", "revokedAt", "rotated", "current", "ip?", "userAgent?", "deviceLabel?" }] }` (never token hashes) | `401 INVALID_TOKEN` |
| `DELETE /v1/auth/sessions/:sessionId` | Bearer access token (own sessions only; foreign ids → 404) | — | `200 { "message": "Session revoked.", "revoked": n }` | `401 INVALID_TOKEN`, `404 SESSION_NOT_FOUND` |
| `GET /healthz` | none | — | `200 { "ok": true, "service": "howmuchwillyoupayfor" }` | — |

Generic `POST /signup` and `POST /login` (`{ "provider": "email-otp"|"google", "payload": {...} }`) also exist and delegate to the strategy registry. Legacy aliases `POST /email-otp/request` and `POST /email-otp/verify` remain available.

## Environment setup

Copy and adjust (never commit secrets):

```bash
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/howmuchwillyoupayfor
JWT_ACCESS_SECRET=<32+-char-random-secret>   # min 16 chars, required
JWT_ACCESS_TTL_SECONDS=900                    # 15 min access tokens
JWT_ISSUER=howmuchwillyoupayfor
JWT_AUDIENCE=howmuchwillyoupayfor-api
REFRESH_TOKEN_TTL_DAYS=30
REFRESH_REUSE_LEEWAY_SECONDS=10
REFRESH_IP_MAX=60
OTP_TTL_MINUTES=10
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SECONDS=60
OTP_MAX_REQUESTS_PER_HOUR=5
OTP_HASH_PEPPER=<random-pepper>               # min 1 char
OTP_REQUEST_IP_MAX=20
OTP_VERIFY_IP_MAX=60
RESPONSES_IP_MAX=60
EMAIL_PROVIDER=dev                            # dev | resend | memory
RESEND_API_KEY=                               # required for resend
EMAIL_FROM="HowMuchWillYouPayFor <no-reply@yourdomain.com>"
AUTH_TOKEN_DELIVERY=body                      # body | cookie | both
AUTH_REFRESH_COOKIE_NAME=hmwyp_refresh
AUTH_CSRF_COOKIE_NAME=hmwyp_csrf
AUTH_CSRF_HEADER=x-csrf-token
AUTH_REFRESH_COOKIE_SAMESITE=lax             # strict | lax | none
FRONTEND_ORIGINS=http://localhost:3000        # comma-separated allowlist
GOOGLE_CLIENT_ID=                             # required for Google sign-in
GOOGLE_ALLOWED_AUDIENCES=                     # extra client IDs, comma-separated
GOOGLE_AUTH_IP_MAX=60
LEADERBOARD_MIN_RESPONSES=30
LEADERBOARD_CRON_SCHEDULE=*/15 * * * *
LEADERBOARD_TIMEZONE=UTC
LEADERBOARD_LOCK_TTL_SECONDS=300
LEADERBOARD_ENABLED=true
APP_BASE_URL=http://localhost:3000
```

Every variable is validated by Zod at startup (`src/config/env.ts`);
invalid values fail fast with a `ZodError` naming the variable.
`GOOGLE_CLIENT_ID` and `RESEND_API_KEY` default to empty and fail fast at
use time instead. No secrets live in source code.

## Local testing

Prerequisites: Node.js + npm, and MongoDB listening on
`127.0.0.1:27017` (tests fall back to a temporary `mongod` on port 27099
if the default port is unreachable).

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm test            # vitest run (unit + integration)
npm run dev         # tsx watch src/server.ts
```

## Provider configuration

- **Email OTP**: development default needs no setup — codes stay in the
  process outbox and only delivery metadata is logged, never the code.
  Production delivery uses Resend: set `EMAIL_PROVIDER=resend`,
  `RESEND_API_KEY`, `EMAIL_FROM`. See `docs/email-provider.md`.
- **Google**: the frontend signs in with any supported Google flow and
  POSTs the resulting ID token. The server verifies signature, expiry,
  issuer, and audience against `GOOGLE_CLIENT_ID`
  (`GOOGLE_ALLOWED_AUDIENCES` for extra web/iOS/Android client IDs) via
  `google-auth-library`. For a manual end-to-end check, mint a real token
  with the OAuth 2.0 Playground and call `POST /v1/auth/google`.
  See `docs/google-auth.md`.

## Security model (implemented)

- OTPs: 6-digit crypto-random, HMAC-SHA256 hashed with server pepper +
  per-challenge salt, 10-min expiry, single-use atomic consume, 5-attempt
  lockout, 60s resend cooldown, 5/hour per-email cap, per-IP limits.
- Request responses never reveal registration; verify failures share one
  generic 401 shape.
- Google: server-side verification only; unverified emails never create or
  merge accounts; lookup prefers the stable `sub`; linking is explicit.
- Refresh tokens are opaque 256-bit values, hashed at rest, rotated
  atomically; reuse outside the leeway window revokes the token family.
  Cookies are `HttpOnly`/`Secure`(prod)/configurable `SameSite` with
  double-submit CSRF on cookie-based refresh/logout; CORS uses an explicit
  origin allowlist. See `docs/tokens-sessions.md`.
- Known limitations: access tokens are stateless (logout does not kill an
  already-issued token before its short expiry); the reuse leeway window
  delays theft punishment by seconds; no formatter is configured yet
  (Prettier --check flags style drift — see verification notes).

## Example curl requests (placeholders only — no real secrets)

```bash
# Request an OTP (generic response either way)
curl -X POST localhost:3000/v1/auth/email/otp/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com"}'

# Verify an OTP (new account -> 201, existing -> 200)
curl -X POST localhost:3000/v1/auth/email/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","code":"<OTP_CODE>"}'

# Google sign-in
curl -X POST localhost:3000/v1/auth/google \
  -H 'Content-Type: application/json' \
  -d '{"idToken":"<GOOGLE_ID_TOKEN>"}'

# Refresh (non-browser: body token)
curl -X POST localhost:3000/v1/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'

# Logout / logout-all / sessions (Bearer access token)
curl -X POST localhost:3000/v1/auth/logout \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'

curl -X POST localhost:3000/v1/auth/logout-all \
  -H 'Authorization: Bearer <ACCESS_TOKEN>'

curl localhost:3000/v1/auth/sessions \
  -H 'Authorization: Bearer <ACCESS_TOKEN>'

curl -X DELETE localhost:3000/v1/auth/sessions/<SESSION_ID> \
  -H 'Authorization: Bearer <ACCESS_TOKEN>'

# Cookie + CSRF flow (browser): login sets HttpOnly refresh and readable
# CSRF cookies; echo the CSRF cookie value back in the CSRF header.
curl -X POST localhost:3000/v1/auth/refresh \
  --cookie 'hmwyp_refresh=<REFRESH_COOKIE>; hmwyp_csrf=<CSRF_COOKIE>' \
  -H 'x-csrf-token: <CSRF_COOKIE>'
```
