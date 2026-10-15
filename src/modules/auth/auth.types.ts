export type AuthProvider = "email-otp" | "google";

export interface SafeUser {
  id: string;
  email: string;
  role: "user" | "admin";
  status: "active" | "suspended" | "deleted";
}

/** Consistent result contract every AuthenticationStrategy must return. */
export interface AuthResult {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  isNewUser: boolean;
}

/** Loose strategy input; each strategy validates its own shape with Zod. */
export type StrategyInput = Record<string, unknown>;

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}
