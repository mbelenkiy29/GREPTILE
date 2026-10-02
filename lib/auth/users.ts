import { and, eq } from "drizzle-orm";
import { encryptSecret, randomToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/data/orgs";
import { authAccounts, users } from "@/lib/db/schema";
import type { GitHubProfile, UserToken } from "./github-user";

/** User records and linked identities (R6.1). */

export type UserRow = typeof users.$inferSelect;

export function newUserId(): string {
  return `usr_${randomToken(12)}`;
}

/**
 * Creates or updates the user for a GitHub identity (keyed by the immutable GitHub user id) and stores the user
 * access token encrypted with its expiry. A second sign-in reuses the user and replaces the token.
 */
export async function upsertGitHubUser(
  db: Db,
  input: { profile: GitHubProfile; token: UserToken; now: Date },
): Promise<{ user: UserRow; created: boolean }> {
  const { profile, token, now } = input;
  const id = newUserId();
  const [user] = await db
    .insert(users)
    .values({
      id,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      githubId: profile.id,
      githubLogin: profile.login,
      createdAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.githubId,
      set: {
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        githubLogin: profile.login,
        lastLoginAt: now,
        // Keep the last known address if GitHub stops sharing one.
        ...(profile.email ? { email: profile.email } : {}),
      },
    })
    .returning();
  const account = {
    userId: user!.id,
    login: profile.login,
    email: profile.email,
    accessTokenEnc: encryptSecret(token.accessToken),
    accessTokenExpiresAt: token.expiresAt,
  };
  await db
    .insert(authAccounts)
    .values({ provider: "github", providerAccountId: String(profile.id), ...account })
    .onConflictDoUpdate({ target: [authAccounts.provider, authAccounts.providerAccountId], set: account });
  return { user: user!, created: user!.id === id };
}

export const DEV_USER_EMAIL = "dev@localhost";

/** The local developer used by dev login (AUTH_DEV_LOGIN, never in production). */
export async function upsertDevUser(db: Db, now: Date): Promise<UserRow> {
  const find = async () => {
    const [row] = await db
      .select({ user: users })
      .from(authAccounts)
      .innerJoin(users, eq(authAccounts.userId, users.id))
      .where(and(eq(authAccounts.provider, "dev"), eq(authAccounts.providerAccountId, "local")));
    return row?.user;
  };
  const existing = await find();
  if (existing) {
    const [user] = await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, existing.id)).returning();
    return user!;
  }
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ id: newUserId(), name: "Local developer", email: DEV_USER_EMAIL, createdAt: now, lastLoginAt: now })
        .returning();
      await tx.insert(authAccounts).values({ userId: user!.id, provider: "dev", providerAccountId: "local", email: DEV_USER_EMAIL });
      return user!;
    });
  } catch (err) {
    if (isUniqueViolation(err, "auth_accounts_provider_account_uq")) {
      const user = await find();
      if (user) return user;
    }
    throw err;
  }
}
