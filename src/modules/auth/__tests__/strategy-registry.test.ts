import { describe, it, expect, vi } from "vitest";
import { AuthService, createStrategyRegistry, createDefaultAuthService } from "../auth.service.js";
import { InvalidProviderError, ProviderConflictError } from "../auth.errors.js";
import type { AuthenticationStrategy } from "../strategies/authentication-strategy.js";
import { EmailOtpStrategy } from "../strategies/email-otp.strategy.js";
import { GoogleStrategy } from "../strategies/google.strategy.js";
import type { AuthResult } from "../auth.types.js";
import { UserService } from "../../users/user.service.js";
import { assertSafeLink } from "../../users/user.types.js";

function fakeResult(provider: string): AuthResult {
  return {
    user: { id: "u1", email: "a@example.com", role: "user", status: "active" },
    accessToken: `access-${provider}`,
    refreshToken: `refresh-${provider}`,
    refreshExpiresAt: new Date(),
    isNewUser: false,
  };
}

function makeFakeStrategy(provider: "email-otp" | "google"): AuthenticationStrategy & {
  signup: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
} {
  return {
    provider,
    signup: vi.fn(async () => fakeResult(provider)),
    login: vi.fn(async () => fakeResult(provider)),
  } as unknown as AuthenticationStrategy & {
    signup: ReturnType<typeof vi.fn>;
    login: ReturnType<typeof vi.fn>;
  };
}

describe("strategy selection (registry/factory, no switch in controller)", () => {
  it("resolves email-otp and google strategies by provider key", () => {
    const email = makeFakeStrategy("email-otp");
    const google = makeFakeStrategy("google");
    const service = new AuthService(createStrategyRegistry([email, google]));

    expect(service.getStrategy("email-otp")).toBe(email);
    expect(service.getStrategy("google")).toBe(google);
    expect(service.supportedProviders().sort()).toEqual(["email-otp", "google"]);
  });

  it("throws InvalidProviderError for unknown providers", () => {
    const service = new AuthService(createStrategyRegistry([makeFakeStrategy("email-otp")]));
    expect(() => service.getStrategy("apple" as never)).toThrow(InvalidProviderError);
  });

  it("delegates signup/login to the selected strategy with input passthrough", async () => {
    const email = makeFakeStrategy("email-otp");
    const google = makeFakeStrategy("google");
    const service = new AuthService(createStrategyRegistry([email, google]));

    await service.signup("google", { idToken: "tok" }, { ip: "1.1.1.1" });
    expect(google.signup).toHaveBeenCalledWith({ idToken: "tok" }, { ip: "1.1.1.1" });
    expect(email.signup).not.toHaveBeenCalled();

    await service.login("email-otp", { email: "a@b.com", code: "123456" });
    expect(email.login).toHaveBeenCalledWith({ email: "a@b.com", code: "123456" }, undefined);
  });
});

describe("shared AuthenticationStrategy interface", () => {
  function stubDeps() {
    const users = {
      findByProvider: vi.fn(async () => null),
      findOrCreateForVerifiedIdentity: vi.fn(async () => ({
        user: { id: "u1", email: "a@example.com", role: "user", status: "active" },
        isNewUser: true,
      })),
    };
    const tokens = { issueAccessToken: vi.fn(() => "access-token") };
    const sessions = {
      createSession: vi.fn(async () => ({ refreshToken: "refresh-token", expiresAt: new Date() })),
    };
    return { users, tokens, sessions };
  }

  it("EmailOtpStrategy and GoogleStrategy implement the shared contract", () => {
    const d = stubDeps();
    const emailOtp = new EmailOtpStrategy({
      // biome-ignore lint: structural stubs for interface conformance
      users: d.users as unknown as UserService,
      tokens: d.tokens as never,
      sessions: d.sessions as never,
      otp: {} as never,
      email: { sendOtp: async () => {} },
    });
    const google = new GoogleStrategy({
      users: d.users as unknown as UserService,
      tokens: d.tokens as never,
      sessions: d.sessions as never,
      verifyIdToken: async () => ({ sub: "g1", email: "a@example.com", emailVerified: true }),
    });

    for (const s of [emailOtp, google] as AuthenticationStrategy[]) {
      expect(typeof s.provider).toBe("string");
      expect(typeof s.signup).toBe("function");
      expect(typeof s.login).toBe("function");
    }
    expect(emailOtp.provider).toBe("email-otp");
    expect(google.provider).toBe("google");
  });

  it("both strategies return the consistent AuthResult contract", async () => {
    const d = stubDeps();
    const emailOtp = new EmailOtpStrategy({
      users: d.users as unknown as UserService,
      tokens: d.tokens as never,
      sessions: d.sessions as never,
      otp: { requestChallenge: async () => ({ expiresAt: new Date() }), verifyChallenge: async () => {} } as never,
      email: { sendOtp: async () => {} },
    });
    const google = new GoogleStrategy({
      users: d.users as unknown as UserService,
      tokens: d.tokens as never,
      sessions: d.sessions as never,
      verifyIdToken: async () => ({ sub: "g1", email: "a@example.com", emailVerified: true }),
    });

    const emailRes = await emailOtp.login({ email: "a@example.com", code: "123456" });
    const googleRes = await google.login({ idToken: "tok" });

    for (const res of [emailRes, googleRes]) {
      expect(res).toHaveProperty("user");
      expect(res).toHaveProperty("accessToken");
      expect(res).toHaveProperty("refreshToken");
      expect(res).toHaveProperty("refreshExpiresAt");
      expect(res).toHaveProperty("isNewUser");
    }
  });

  it("EmailOtpStrategy exposes provider-specific requestOtp/verifyOtp beyond the base interface", () => {
    const d = stubDeps();
    const emailOtp = new EmailOtpStrategy({
      users: d.users as unknown as UserService,
      tokens: d.tokens as never,
      sessions: d.sessions as never,
      otp: { requestChallenge: async () => ({ expiresAt: new Date(), code: "123456" }), verifyChallenge: async () => {} } as never,
      email: { sendOtp: async () => {} },
    });
    expect(typeof emailOtp.requestOtp).toBe("function");
    expect(typeof emailOtp.verifyOtp).toBe("function");
  });
});

describe("dependency injection", () => {
  it("uses injected collaborators instead of hardcoded implementations", async () => {
    const users = {
      findByProvider: vi.fn(async () => null),
      findOrCreateForVerifiedIdentity: vi.fn(async () => ({
        user: { id: "u9", email: "z@example.com", role: "user", status: "active" },
        isNewUser: false,
      })),
    };
    const tokens = { issueAccessToken: vi.fn(() => "injected-access-token") };
    const sessions = {
      createSession: vi.fn(async () => ({ refreshToken: "injected-refresh", expiresAt: new Date(2030, 0, 1) })),
    };
    const google = new GoogleStrategy({
      users: users as unknown as UserService,
      tokens: tokens as never,
      sessions: sessions as never,
      verifyIdToken: async () => ({ sub: "g9", email: "z@example.com", emailVerified: true }),
    });

    const res = await google.login({ idToken: "tok" });
    expect(tokens.issueAccessToken).toHaveBeenCalledWith("u9", "user");
    expect(sessions.createSession).toHaveBeenCalled();
    expect(res.accessToken).toBe("injected-access-token");
    expect(res.refreshToken).toBe("injected-refresh");
  });

  it("createDefaultAuthService wires email-otp + google and accepts overrides", () => {
    const service = createDefaultAuthService({
      verifyGoogleIdToken: async () => ({ sub: "g1", email: "t@example.com", emailVerified: true }),
    });
    expect(service.supportedProviders().sort()).toEqual(["email-otp", "google"]);

    const extra = makeFakeStrategy("email-otp");
    const custom = new AuthService(createStrategyRegistry([extra]));
    expect(custom.getStrategy("email-otp")).toBe(extra);
  });
});

describe("safe provider linking (never merge on unverified email)", () => {
  it("assertSafeLink denies linking on unverified email claim", () => {
    expect(() =>
      assertSafeLink("user@example.com", { email: "User@Example.com ", emailVerified: false }),
    ).toThrow(/UNVERIFIED_EMAIL_LINK_DENIED/);
    expect(() =>
      assertSafeLink("user@example.com", { email: "user@example.com", emailVerified: true }),
    ).not.toThrow();
  });

  it("UserService refuses to merge an unverified claim into an existing email account", async () => {
    const existing = { id: "u-existing", emailNormalized: "user@example.com", providers: [] as never[], save: vi.fn(async function (this: unknown) { return this; }) };
    const fakeModel = {
      findOne: vi.fn((query: Record<string, unknown>) => ({
        exec: async () => {
          if (query.emailNormalized === "user@example.com") return existing;
          return null;
        },
      })),
      findById: vi.fn(() => ({ exec: async () => null })),
    };
    const svc = new UserService(fakeModel as never);
    await expect(
      svc.findOrCreateForVerifiedIdentity({
        provider: "google",
        providerUserId: "g-evil",
        email: "user@example.com",
        emailVerified: false, // unverified claim must not merge
      }),
    ).rejects.toBeInstanceOf(ProviderConflictError);
  });
});
