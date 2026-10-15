# Tokens and refresh sessions

Both strategies (Email OTP, Google) share one token system. There is no
per-provider token or session mechanism.

## Lifetimes

| Token | Default | Env |
| --- | --- | --- |
| Access token (JWT) | 15 minutes (900s) | `JWT_ACCESS_TTL_SECONDS` |
| Refresh token (opaque) | 30 days | `REFRESH_TOKEN_TTL_DAYS` |
| Refresh reuse leeway | 10 seconds | `REFRESH_REUSE_LEEWAY_SECONDS` |

Access tokens are short-lived JWTs signed with `JWT_ACCESS_SECRET` and
bound to `JWT_ISSUER` / `JWT_AUDIENCE`; the middleware verifies signature,
expiry, issuer, and audience. Refresh tokens are 256-bit opaque random
values — never JWTs. Only a SHA-256 hash (`tokenHash`) is stored in the
`RefreshSession` collection.

## Sessions

Each login creates a `RefreshSession`:

```
userId, tokenHash, familyId, provider, expiresAt, lastUsedAt,
revokedAt, rotatedFromHash, replacedByHash, ip, userAgent, deviceLabel
```

- Multiple active sessions per user are supported (one `familyId` per login).
- Rotation is atomic (`findOneAndUpdate` guarded on
  `revokedAt: null` + unexpired), so concurrent refreshes with the same
  token cannot both succeed.
- **Reuse policy:** presenting a fully-rotated token (rotation finished
  outside the leeway window) is treated as theft — the whole token family
  is revoked and the caller gets `401 REFRESH_TOKEN_REUSED`. A retry inside
  the leeway window (e.g. an in-flight concurrent double-submit) gets a
  plain `401 INVALID_REFRESH_TOKEN` without punishing the new token.
- `logout` revokes the presented token's family (ends the lineage,
  including in-flight descendants) and is idempotent. `logout-all` revokes
  every session of the caller.
- Listing/revocation are scoped to the caller: session ids of other users
  return `404 SESSION_NOT_FOUND`, and list views never include token hashes.
- The `expiresAt` TTL index deletes stale documents for hygiene, but expiry
  and revocation are always enforced in application logic.

## Endpoints

- `POST /v1/auth/refresh` — body `{ refreshToken }` and/or refresh cookie.
  Returns a new `{ user, accessToken, refreshToken?, refreshExpiresAt }`
  (refresh token omitted from the body under cookie delivery).
- `POST /v1/auth/logout` — revokes the current session family, clears
  cookies. Idempotent.
- `POST /v1/auth/logout-all` — Bearer access token required. Revokes all
  caller sessions.
- `GET /v1/auth/sessions` — Bearer required. Caller's sessions only, with
  a `current` flag when the refresh credential is also presented.
- `DELETE /v1/auth/sessions/:sessionId` — Bearer required. Revokes the
  caller's session family; foreign ids return 404.

## Browser vs non-browser clients

- `AUTH_TOKEN_DELIVERY=body` (default): tokens are JSON. Non-browser
  clients store the refresh token in secure app storage
  (Keychain/Keystore — never committed logs) and POST it back in the
  refresh body.
- `cookie` / `both`: the refresh token is set as `HttpOnly`, `Secure`
  (production), `SameSite=<AUTH_REFRESH_COOKIE_SAMESITE, default lax>`
  cookie, invisible to JS. A readable CSRF cookie
  (`AUTH_CSRF_COOKIE_NAME`, default `hmwyp_csrf`) is set alongside, and
  cookie-based refresh/logout must echo it in the `AUTH_CSRF_HEADER`
  header (default `x-csrf-token`, double-submit pattern). Missing/invalid
  CSRF yields `403 CSRF_INVALID`. Body-token requests skip CSRF (no
  ambient credentials to forge).
- CORS uses an explicit allowlist (`FRONTEND_ORIGINS`, comma-separated,
  default `http://localhost:3000`) with `credentials: true`. Requests
  without an `Origin` header (curl, native apps, tests) are unaffected.

## Environment variables

`JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL_SECONDS` (900),
`JWT_ISSUER` (`howmuchwillyoupayfor`), `JWT_AUDIENCE`
(`howmuchwillyoupayfor-api`), `REFRESH_TOKEN_TTL_DAYS` (30),
`REFRESH_REUSE_LEEWAY_SECONDS` (10), `REFRESH_IP_MAX` (60 per 15 min),
`AUTH_TOKEN_DELIVERY`, `AUTH_REFRESH_COOKIE_NAME`,
`AUTH_CSRF_COOKIE_NAME`, `AUTH_CSRF_HEADER`,
`AUTH_REFRESH_COOKIE_SAMESITE`, `FRONTEND_ORIGINS`.

## Limitations

- Access tokens are stateless: logout/revocation does not invalidate an
  already-issued access token before its (short) expiry. Keep the access
  lifetime short to bound this window.
- Reuse detection cannot distinguish theft from a legitimate concurrent
  double-submit inside the leeway window; the window is intentionally short
  (10s) and only delays punishment, it does not grant new tokens.
- Session device metadata is informational (`ip`, `userAgent`,
  optional `x-device-label` header), not a security boundary.
- Never log access tokens, refresh tokens, OTPs, or cookie values; the
  codebase contains no such logging — keep it that way.
