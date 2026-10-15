import { UserModel, normalizeEmail, type UserDocument } from "./user.model.js";
import type { CreateUserInput, ProviderIdentity } from "./user.types.js";
import { ProviderConflictError, EmailNotVerifiedError } from "../auth/auth.errors.js";

export type UserModelLike = typeof UserModel;

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

export class UserService {
  constructor(private readonly model: UserModelLike = UserModel) {}

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.model.findOne({ emailNormalized: normalizeEmail(email) }).exec();
  }

  findByProvider(provider: ProviderIdentity["provider"], providerUserId: string): Promise<UserDocument | null> {
    return this.model
      .findOne({ providers: { $elemMatch: { provider, providerUserId } } })
      .exec();
  }

  findById(id: string): Promise<UserDocument | null> {
    return this.model.findById(id).exec();
  }

  async createWithProvider(input: CreateUserInput): Promise<UserDocument> {
    const doc = new this.model({
      email: input.email.trim(),
      emailNormalized: normalizeEmail(input.email),
      role: input.role ?? "user",
      status: "active",
      providers: [{ ...input.providerIdentity, linkedAt: input.providerIdentity.linkedAt ?? new Date() }],
    });
    try {
      return await doc.save();
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // Concurrent signup won the race: resolve to the winner instead of
      // surfacing a duplicate-key error.
      const byProvider = await this.findByProvider(
        input.providerIdentity.provider,
        input.providerIdentity.providerUserId,
      );
      if (byProvider) return byProvider;
      const byEmail = await this.model
        .findOne({ emailNormalized: normalizeEmail(input.email) })
        .exec();
      if (byEmail) return byEmail;
      throw err;
    }
  }

  /**
   * Link an additional provider identity to an existing user.
   *
   * Safety rules:
   * - The same (provider, providerUserId) must never belong to two users.
   * - Linking on the basis of an unverified email claim is denied.
   */
  async linkProviderIdentity(
    userId: string,
    identity: Omit<ProviderIdentity, "linkedAt">,
  ): Promise<UserDocument> {
    const user = await this.model.findById(userId).exec();
    if (!user) throw new Error(`User not found: ${userId}`);

    const owner = await this.findByProvider(identity.provider, identity.providerUserId);
    if (owner && owner.id !== user.id) {
      throw new ProviderConflictError(
        `This ${identity.provider} account is already linked to another user`,
      );
    }
    if (owner && owner.id === user.id) return user; // idempotent

    if (normalizeEmail(identity.email) === user.emailNormalized && !identity.emailVerified) {
      throw new EmailNotVerifiedError(
        "Cannot link provider identity without verified email ownership",
      );
    }

    user.providers.push({ ...identity, linkedAt: new Date() });
    return user.save();
  }

  /**
   * Resolve-or-create a user for a verified provider identity.
   * Returns the user plus whether it was newly created.
   *
   * - Existing provider link wins (exact identity match).
   * - Else, if a user owns the verified normalized email, link the new
   *   provider to that account (verified ownership proven by the provider).
   * - Else, create a fresh user.
   * - An unverified email claim NEVER merges into an existing account:
   *   it either matches its own provider link or creates/uses nothing.
   */
  async findOrCreateForVerifiedIdentity(
    identity: Omit<ProviderIdentity, "linkedAt">,
  ): Promise<{ user: UserDocument; isNewUser: boolean }> {
    const byProvider = await this.findByProvider(identity.provider, identity.providerUserId);
    if (byProvider) return { user: byProvider, isNewUser: false };

    const normalized = normalizeEmail(identity.email);
    const byEmail = await this.model.findOne({ emailNormalized: normalized }).exec();

    if (byEmail) {
      if (!identity.emailVerified) {
        // Never auto-merge on an unverified claim: explicit conflict for the caller.
        throw new ProviderConflictError(
          "An account with this email already exists. Verify email ownership to link it.",
        );
      }
      const alreadyLinked = byEmail.providers.some(
        (p) => p.provider === identity.provider && p.providerUserId === identity.providerUserId,
      );
      if (!alreadyLinked) {
        byEmail.providers.push({ ...identity, linkedAt: new Date() });
        try {
          const saved = await byEmail.save();
          return { user: saved, isNewUser: false };
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          const fresh = await this.findByProvider(identity.provider, identity.providerUserId);
          if (fresh) return { user: fresh, isNewUser: false };
          throw err;
        }
      }
      return { user: byEmail, isNewUser: false };
    }

    const created = await this.createWithProvider({ email: identity.email, providerIdentity: identity });
    return { user: created, isNewUser: true };
  }
}
