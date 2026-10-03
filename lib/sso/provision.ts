/**
 * Just-in-time provisioning for SSO sign-in (R4.6). An IdP identity (`auth_accounts` provider `oidc` / `saml`,
 * providerAccountId `issuer|subject`) maps to one OpenReview user:
 *
 * - a known identity signs in as its user;
 * - a new identity started by someone already signed in (`linkUserId`) is linked to that user, so a GitHub user can
 *   satisfy an org's SSO enforcement without becoming a second account;
 * - otherwise a new user is created.
 *
 * The user then becomes a member of the connection's org with its default role (an existing role is kept).
 *
 * The IdP-asserted email is stored on the linked identity, not as the user's email: an org's own IdP may assert any
 * address, and `users.email` is what invitations for other orgs are matched against, so trusting it there would let one
 * org's admin claim invitations addressed to people elsewhere. Emails are only trusted within the connection's org,
 * after the allowed-domain check.
 */
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { recordAudit } from "@/lib/data/audit";
import { isUniqueViolation } from "@/lib/data/orgs";
import { scoped } from "@/lib/data/tenant";
import { authAccounts, memberships, users } from "@/lib/db/schema";
import { newUserId, type UserRow } from "@/lib/auth/users";
import { emailDomainAllowed, type SsoConnectionRow } from "./connections";
import { SsoError } from "./errors";

export interface SsoIdentity {
  protocol: "oidc" | "saml";
  /** `issuer|subject` from the IdP. */
  subject: string;
  email: string;
  name: string;
}

export interface ProvisionResult {
  user: UserRow;
  createdUser: boolean;
  joinedOrg: boolean;
}

export async function provisionSsoUser(
  db: Db,
  connection: SsoConnectionRow,
  identity: SsoIdentity,
  opts: { linkUserId?: string | null; now: Date; ip?: string | null },
): Promise<ProvisionResult> {
  if (!emailDomainAllowed(identity.email, connection.allowedDomains)) {
    throw new SsoError("sso_domain_not_allowed", `the email domain of ${identity.email.slice(identity.email.indexOf("@"))} is not allowed by this connection`);
  }
  const providerAccountId = identity.subject.slice(0, 1024);

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ user: users })
      .from(authAccounts)
      .innerJoin(users, eq(authAccounts.userId, users.id))
      .where(and(eq(authAccounts.provider, identity.protocol), eq(authAccounts.providerAccountId, providerAccountId)));

    let user: UserRow;
    let createdUser = false;
    if (existing) {
      if (opts.linkUserId && opts.linkUserId !== existing.user.id) {
        throw new SsoError("sso_identity_linked", "the SSO identity is already linked to a different user");
      }
      if (!opts.linkUserId) {
        // An identity linked to an account that also signs in another way (GitHub) only confirms SSO for a session
        // that account already has: the org's IdP must never become a way into the rest of that account.
        const others = await tx
          .select({ provider: authAccounts.provider })
          .from(authAccounts)
          .where(and(eq(authAccounts.userId, existing.user.id), notInArray(authAccounts.provider, ["oidc", "saml"])))
          .limit(1);
        if (others.length) throw new SsoError("sso_use_primary_sign_in", "the SSO identity is linked to an account with another sign-in method");
      }
      [user] = (await tx.update(users).set({ lastLoginAt: opts.now }).where(eq(users.id, existing.user.id)).returning()) as [UserRow];
      await tx
        .update(authAccounts)
        .set({ email: identity.email, login: identity.email, updatedAt: opts.now })
        .where(and(eq(authAccounts.provider, identity.protocol), eq(authAccounts.providerAccountId, providerAccountId)));
    } else {
      if (opts.linkUserId) {
        const [linked] = await tx.update(users).set({ lastLoginAt: opts.now }).where(eq(users.id, opts.linkUserId)).returning();
        if (!linked) throw new SsoError("sso_invalid_state", "the signed-in user no longer exists");
        user = linked;
      } else {
        // email stays null on purpose; see the module comment.
        const [created] = await tx.insert(users).values({ id: newUserId(), name: identity.name, email: null, createdAt: opts.now, lastLoginAt: opts.now }).returning();
        user = created!;
        createdUser = true;
      }
      await tx.insert(authAccounts).values({ userId: user.id, provider: identity.protocol, providerAccountId, login: identity.email, email: identity.email });
    }

    const [member] = await tx.select({ id: memberships.id }).from(memberships).where(scoped(memberships, connection.orgId, eq(memberships.userId, user.id)));
    let joinedOrg = false;
    if (!member) {
      await tx.insert(memberships).values({ orgId: connection.orgId, userId: user.id, role: connection.defaultRole, createdAt: opts.now }).onConflictDoNothing();
      joinedOrg = true;
    }
    return { user, createdUser, joinedOrg };
  }).catch((err: unknown) => {
    if (isUniqueViolation(err, "auth_accounts_provider_account_uq")) {
      throw new SsoError("sso_identity_linked", "the SSO identity was linked concurrently; sign in again", { cause: err });
    }
    throw err;
  });

  await recordAudit(db, {
    orgId: connection.orgId,
    actorType: "user",
    actorId: result.user.id,
    action: "sso.signed_in",
    targetType: "sso_connection",
    targetId: connection.id,
    metadata: { protocol: identity.protocol, email: identity.email, newUser: result.createdUser, joined: result.joinedOrg, ...(result.joinedOrg ? { role: connection.defaultRole } : {}) },
    ip: opts.ip ?? null,
    now: opts.now,
  });
  return result;
}
