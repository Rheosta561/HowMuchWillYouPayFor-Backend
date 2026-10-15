import type { UserService } from "../../users/user.service.js";
import type { AuthProvider, AuthResult, RequestMeta, StrategyInput } from "../auth.types.js";
import {
  AccountSuspendedError,
  EmailNotVerifiedError,
  GoogleVerificationError,
} from "../auth.errors.js";
import type { AuthenticationStrategy } from "./authentication-strategy.js";
import type { TokenService } from "../services/token.service.js";
import type { SessionService } from "../services/session.service.js";
import { toSafeUser } from "./email-otp.strategy.js";

export interface GoogleProfile {
  /** Stable Google subject identifier. Used as the provider user id. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/**
 * Verifies a Google ID token and returns the verified profile.
 * Production wiring uses `createGoogleVerifier()` (google-auth-library);
 * tests inject a mock. Client-submitted profile fields are never trusted —
 * only this verifier's output is used.
 */
export type GoogleTokenVerifier = (idToken: string) => Promise<GoogleProfile>;

export interface GoogleStrategyDeps {
  users: UserService;
  tokens: TokenService;
  sessions: SessionService;
  verifyIdToken: GoogleTokenVerifier;
}

function defaultUnconfiguredVerifier(): GoogleTokenVerifier {
  return async () => {
    throw new GoogleVerificationError(
      "Google verification is not configured. Set GOOGLE_CLIENT_ID.",
    );
  };
}

export class GoogleStrategy implements AuthenticationStrategy {
  readonly provider: AuthProvider = "google";
  private readonly verifyIdToken: GoogleTokenVerifier;

  constructor(private readonly deps: GoogleStrategyDeps) {
    this.verifyIdToken = deps.verifyIdToken ?? defaultUnconfiguredVerifier();
  }

  async signup(input: StrategyInput, meta?: RequestMeta): Promise<AuthResult> {
    return this.authenticate(input, meta);
  }

  async login(input: StrategyInput, meta?: RequestMeta): Promise<AuthResult> {
    return this.authenticate(input, meta);
  }

  private async authenticate(input: StrategyInput, meta: RequestMeta = {}): Promise<AuthResult> {
    const idToken = typeof input.idToken === "string" ? input.idToken : "";
    if (!idToken) throw new GoogleVerificationError("Missing Google idToken");

    let profile: GoogleProfile;
    try {
      profile = await this.verifyIdToken(idToken);
    } catch (err) {
      if (err instanceof GoogleVerificationError) throw err;
      throw new GoogleVerificationError((err as Error).message);
    }
    if (!profile.sub) throw new GoogleVerificationError("Google token has no subject");
    if (!profile.email) throw new GoogleVerificationError("Google profile has no email");

    // 1. Stable subject lookup first: a previously linked identity logs in
    //    on the sub alone. The link was established with verified ownership,
    //    so a later unverified flag does not lock the account out — but the
    //    stored email is left untouched.
    const linked = await this.deps.users.findByProvider("google", profile.sub);
    let user;
    let isNewUser: boolean;
    if (linked) {
      user = linked;
      isNewUser = false;
    } else {
      // 2. No linked identity: require a verified Google email before the
      //    address is used as a verified identity. Unverified claims never
      //    create or merge accounts. Only sub/email/emailVerified are stored.
      if (!profile.emailVerified) {
        throw new EmailNotVerifiedError(
          "Google email is not verified. Verify it with Google before signing in.",
        );
      }
      const resolved = await this.deps.users.findOrCreateForVerifiedIdentity({
        provider: "google",
        providerUserId: profile.sub,
        email: profile.email,
        emailVerified: true,
      });
      user = resolved.user;
      isNewUser = resolved.isNewUser;
    }

    if (user.status !== "active") throw new AccountSuspendedError();

    const accessToken = this.deps.tokens.issueAccessToken(user.id, user.role);
    const { refreshToken, expiresAt } = await this.deps.sessions.createSession({
      userId: user.id,
      provider: this.provider,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      user: toSafeUser(user),
      accessToken,
      refreshToken,
      refreshExpiresAt: expiresAt,
      isNewUser,
    };
  }
}
