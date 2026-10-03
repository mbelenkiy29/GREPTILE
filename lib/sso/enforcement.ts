/**
 * SSO enforcement lookup (R4.6), kept free of the SAML/OIDC libraries because every authorized request runs it.
 */
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { scoped } from "@/lib/data/tenant";
import { ssoConnections } from "@/lib/db/schema";

/** The enabled connection that enforces SSO for an org, if any. */
export async function enforcedSsoConnection(db: Db, orgId: string): Promise<{ id: string; name: string } | undefined> {
  const [row] = await db
    .select({ id: ssoConnections.id, name: ssoConnections.name })
    .from(ssoConnections)
    .where(scoped(ssoConnections, orgId, eq(ssoConnections.enabled, true), eq(ssoConnections.enforce, true)))
    .orderBy(asc(ssoConnections.createdAt))
    .limit(1);
  return row;
}
