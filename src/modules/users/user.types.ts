import { normalizeEmail } from "./user.model.js";

/**
 * Identity of a single authentication provider linked to a user.
 * `emailVerified` records whether the provider itself asserted verified
 * ownership of the email address (e.g. Google `email_verified`, or a
 * successful OTP challenge for the email-otp provider).
 */
export interface ProviderIdentity {
  provider: "email-otp" | "google";
  /** Provider-side unique user id. For email-otp this is the normalized email. */
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  linkedAt: Date;
}

export interface CreateUserInput {
  email: string;
  providerIdentity: Omit<ProviderIdentity, "linkedAt"> & { linkedAt?: Date };
  role?: "user" | "admin";
}

/**
 * Rule: never merge/link accounts on an unverified email claim.
 * Linking to an existing account that owns the same normalized email
 * requires the incoming identity to carry verified email ownership.
 * Throws when the rule is violated so callers map it to a 409/403.
 */
export function assertSafeLink(
  existingUserEmailNormalized: string,
  identity: { email: string; emailVerified: boolean },
): void {
  const incoming = normalizeEmail(identity.email);
  if (incoming === existingUserEmailNormalized && !identity.emailVerified) {
    throw new Error(
      "UNVERIFIED_EMAIL_LINK_DENIED: cannot link provider identity without verified email ownership",
    );
  }
}
