import type { AuthProvider, AuthResult, RequestMeta, StrategyInput } from "./auth.types.js";
import { InvalidProviderError } from "./auth.errors.js";
import type { AuthenticationStrategy } from "./strategies/authentication-strategy.js";
import { EmailOtpStrategy } from "./strategies/email-otp.strategy.js";
import { GoogleStrategy, type GoogleTokenVerifier } from "./strategies/google.strategy.js";
import { TokenService } from "./services/token.service.js";
import { SessionService } from "./services/session.service.js";
import { OtpService } from "./services/otp.service.js";
import { createEmailSender, type EmailSender } from "./services/email.service.js";
import { createGoogleVerifier } from "./services/google-verifier.js";
import { UserService } from "../users/user.service.js";

export type StrategyRegistry = Map<AuthProvider, AuthenticationStrategy>;

/** Explicit registry: no switch statements, providers are looked up by key. */
export function createStrategyRegistry(strategies: AuthenticationStrategy[]): StrategyRegistry {
  const registry: StrategyRegistry = new Map();
  for (const strategy of strategies) {
    registry.set(strategy.provider, strategy);
  }
  return registry;
}

export interface AuthServiceDeps {
  strategies?: AuthenticationStrategy[];
  registry?: StrategyRegistry;
}

export class AuthService {
  constructor(private readonly registry: StrategyRegistry) {}

  getStrategy(provider: AuthProvider): AuthenticationStrategy {
    const strategy = this.registry.get(provider);
    if (!strategy) throw new InvalidProviderError(String(provider));
    return strategy;
  }

  supportedProviders(): AuthProvider[] {
    return [...this.registry.keys()];
  }

  signup(provider: AuthProvider, input: StrategyInput, meta?: RequestMeta): Promise<AuthResult> {
    return this.getStrategy(provider).signup(input, meta);
  }

  login(provider: AuthProvider, input: StrategyInput, meta?: RequestMeta): Promise<AuthResult> {
    return this.getStrategy(provider).login(input, meta);
  }
}

export interface DefaultAuthServiceOptions {
  users?: UserService;
  tokens?: TokenService;
  sessions?: SessionService;
  otp?: OtpService;
  email?: EmailSender;
  verifyGoogleIdToken?: GoogleTokenVerifier;
  extraStrategies?: AuthenticationStrategy[];
}

/**
 * Factory: wires the default Email OTP + Google strategies with shared
 * token/session services. All collaborators are injectable for tests.
 */
export function createDefaultAuthService(opts: DefaultAuthServiceOptions = {}): AuthService {
  const users = opts.users ?? new UserService();
  const tokens = opts.tokens ?? new TokenService();
  const sessions = opts.sessions ?? new SessionService();
  const otp = opts.otp ?? new OtpService();
  const email = opts.email ?? createEmailSender();

  const emailOtp = new EmailOtpStrategy({ users, tokens, sessions, otp, email });
  const google = new GoogleStrategy({
    users,
    tokens,
    sessions,
    // Real server-side verification (google-auth-library) by default;
    // tests inject a mock via `verifyGoogleIdToken`.
    verifyIdToken: opts.verifyGoogleIdToken ?? createGoogleVerifier(),
  });

  return new AuthService(createStrategyRegistry([emailOtp, google, ...(opts.extraStrategies ?? [])]));
}

// Shared default instance used by the HTTP layer.
export const defaultAuthService = createDefaultAuthService();
