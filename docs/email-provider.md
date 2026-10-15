# Email provider configuration

OTP delivery goes through the `EmailSender` abstraction in
`src/modules/auth/services/email.service.ts`. The authentication strategy
only depends on the interface, so providers are swappable without touching
auth logic.

## Providers

| `EMAIL_PROVIDER` | Implementation | Use |
| --- | --- | --- |
| `dev` (default) | `DevEmailService` | Local development. Keeps an in-memory outbox and logs delivery metadata only — never the OTP code. |
| `memory` | `InMemoryEmailService` | Tests. Captures messages in `outbox` with no logging and no network. |
| `resend` | `ResendEmailService` | Production delivery via the Resend API. |

## Enabling Resend

1. Create an API key at https://resend.com/api-keys.
2. Verify a sending domain and decide the `From` address.
3. Set the environment:

```bash
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...        # required, never commit this value
EMAIL_FROM="HowMuchWillYouPayFor <no-reply@yourdomain.com>"
```

4. Restart the service. `ResendEmailService` throws at startup wiring time
   if `RESEND_API_KEY` is missing, so a misconfigured deploy fails fast
   instead of silently dropping OTP emails.

## Developing a new provider

1. Implement `EmailSender` (`sendOtp({ to, code, expiresInMinutes })`).
2. Register it in `createEmailSender()` and extend `EMAIL_PROVIDER`.
3. Rules for every implementation:
   - Never return OTP codes in API responses (the request endpoint always
     returns the same generic message).
   - Never log OTP codes, tokens, or provider secrets.
   - `to` must be the normalized email address supplied by the strategy.

## Current limitation

The default `dev` provider does not deliver real email — codes stay in the
process outbox. Real delivery requires configuring `resend` (or adding
another provider) as described above.
