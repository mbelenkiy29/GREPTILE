import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export interface OrgSession {
  userId: string;
  orgId: string;
  orgName: string;
}

/**
 * The signed-in user's active Clerk organization. Every dashboard query is
 * scoped by the returned `orgId` (R1.1). Users without an active org are sent
 * to pick or create one.
 */
export async function requireOrg(): Promise<OrgSession> {
  const session = await auth();
  if (!session.userId) redirect("/sign-in");
  if (!session.orgId) redirect("/select-org");
  return { userId: session.userId, orgId: session.orgId, orgName: session.orgSlug ?? session.orgId };
}
