import type { AuthProvider, AuthResult, RequestMeta, StrategyInput } from "../auth.types.js";

/**
 * Common contract for all authentication providers (Strategy pattern).
 *
 * Every strategy exposes `signup` and `login` with the same result
 * contract. Provider-specific steps (e.g. OTP request/verify) live on the
 * concrete strategy class, not on this interface.
 */
export interface AuthenticationStrategy {
  readonly provider: AuthProvider;
  signup(input: StrategyInput, meta?: RequestMeta): Promise<AuthResult>;
  login(input: StrategyInput, meta?: RequestMeta): Promise<AuthResult>;
}
