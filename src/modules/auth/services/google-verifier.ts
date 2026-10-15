import { OAuth2Client } from "google-auth-library";
import { env } from "../../../config/env.js";
import { GoogleVerificationError } from "../auth.errors.js";
import type { GoogleProfile, GoogleTokenVerifier } from "../strategies/google.strategy.js";

export interface GoogleVerifierOptions {
  /** Allowed OAuth client IDs (audiences). Defaults to env configuration. */
  clientIds?: string[];
  /** Injectable client for tests. */
  client?: Pick<OAuth2Client, "verifyIdToken">;
}

function configuredClientIds(): string[] {
  const extra = (env.GOOGLE_ALLOWED_AUDIENCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [env.GOOGLE_CLIENT_ID.trim(), ...extra].filter(Boolean);
}

/**
 * Server-side Google ID token verification using google-auth-library.
 *
 * verifyIdToken checks the token signature, expiry, issuer
 * (accounts.google.com) and that the audience matches one of the
 * configured OAuth client IDs. Only the verified payload fields are
 * returned — nothing the client submitted independently is trusted.
 */
export function createGoogleVerifier(opts: GoogleVerifierOptions = {}): GoogleTokenVerifier {
  const clientIds = opts.clientIds ?? configuredClientIds();
  if (clientIds.length === 0) {
    return async () => {
      throw new GoogleVerificationError(
        "Google verification is not configured. Set GOOGLE_CLIENT_ID.",
      );
    };
  }
  const client = opts.client ?? new OAuth2Client();

  return async (idToken: string): Promise<GoogleProfile> => {
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientIds });
      payload = ticket.getPayload();
    } catch (err) {
      throw toVerificationError(err);
    }
    if (!payload?.sub) throw new GoogleVerificationError("Google token has no subject");
    if (!payload.email) throw new GoogleVerificationError("Google profile has no email");
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
    };
  };
}

function toVerificationError(err: unknown): GoogleVerificationError {
  const message = err instanceof Error ? err.message : String(err);
  const lowered = message.toLowerCase();
  if (lowered.includes("expired") || lowered.includes("used too late")) {
    return new GoogleVerificationError("Google token has expired");
  }
  if (lowered.includes("audience") || lowered.includes("wrong recipient")) {
    return new GoogleVerificationError("Google token audience mismatch");
  }
  if (lowered.includes("issuer")) {
    return new GoogleVerificationError("Google token issuer mismatch");
  }
  if (lowered.includes("signature") || lowered.includes("verify")) {
    return new GoogleVerificationError("Google token signature invalid");
  }
  return new GoogleVerificationError("Google token verification failed");
}
