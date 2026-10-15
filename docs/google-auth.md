# Google authentication

Sign-in goes through `GoogleStrategy`
(`src/modules/auth/strategies/google.strategy.ts`) behind
`POST /v1/auth/google` with body `{ "idToken": "<Google ID token>" }`.
The frontend obtains the ID token with any supported Google sign-in flow
(Google Identity Services button, One Tap, or native SDKs); the backend
never accepts client-submitted emails, user IDs, or profiles.

## Configuration

No Google secrets live in source code. All Google OAuth settings are
environment variables (see `src/config/env.ts`):

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
# Optional extra audiences (e.g. iOS + Android + web client IDs):
GOOGLE_ALLOWED_AUDIENCES=ios-id.apps.googleusercontent.com,android-id.apps.googleusercontent.com
# Optional per-IP rate limit for /google (requests per 15 min, default 60):
GOOGLE_AUTH_IP_MAX=60
```

If `GOOGLE_CLIENT_ID` is unset, verification fails fast with a
"not configured" error instead of accepting tokens.

## Verification behavior

`createGoogleVerifier()` (`src/modules/auth/services/google-verifier.ts`)
uses `google-auth-library`'s `OAuth2Client.verifyIdToken()`, which checks
the token signature, expiry, issuer (`accounts.google.com`), and that the
audience matches a configured client ID. Only `sub`, `email`, and
`email_verified` from the verified payload are used.

Account resolution:

1. Look up the stable `sub` identifier. A previously linked identity logs
   in on the `sub` alone.
2. Otherwise require `email_verified: true`; unverified claims never
   create or merge accounts.
3. With verified ownership, link to the existing email-owner account or
   create a new user (duplicate-safe via unique indexes).
4. Sessions use the shared `SessionService`/`TokenService`; the response
   contract is identical to Email OTP
   (`{ user, accessToken, refreshToken, refreshExpiresAt, isNewUser }`).

Failures return safe generic shapes: `401 GOOGLE_AUTH_FAILED` for bad
tokens, `403 EMAIL_NOT_VERIFIED` for unverified email, `400` for missing
tokens, `429` on rate limit.

## Automated tests

`src/modules/auth/__tests__/google-auth.test.ts` covers valid tokens,
expired tokens, invalid audience, missing tokens, existing linked
accounts, verified linking, unverified-email refusal, non-merge
conflicts, suspended accounts, and per-IP rate limiting. Google's side is
mocked (a stub `GoogleTokenVerifier` and a stub `OAuth2Client`), so the
suite runs offline:

```bash
npm test
```

## Real integration test (manual, against Google)

1. Create an OAuth client ID in the Google Cloud console (type: Web
   application) and set `GOOGLE_CLIENT_ID` to it.
2. Start the API against a throwaway database:
   `MONGODB_URI=mongodb://127.0.0.1:27017/gmail-manual npm run dev`.
3. Mint a real ID token with the OAuth 2.0 Playground
   (`https://developers.google.com/oauthplayground`, scope
   `openid email profile`, Google OAuth2 API v2) or with
   `gcloud auth print-identity-token` (audience must then be added to
   `GOOGLE_ALLOWED_AUDIENCES`).
4. Call the endpoint and expect `201` (first time) then `200`:
   `curl -X POST localhost:3000/v1/auth/google -H 'Content-Type: application/json' -d '{"idToken":"..."}'`.
5. Negative checks: tamper with one character of the token (expect `401`),
   and send `{}` (expect `400`).
