import Link from "next/link";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { findInvitationByToken, invitationState, invitationTargetsUser } from "@/lib/data/members";
import { getMembership, ORG_ERROR_MESSAGES, orgErrorCode, type OrgErrorCode } from "@/lib/data/orgs";
import { acceptInviteAction } from "../actions";
import { Brand } from "@/components/shell/Brand";
import { Alert } from "@/components/ui/Alert";
import { SubmitButton } from "@/components/ui/SubmitButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invitation" };

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Brand href="/dashboard" />
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const session = await requireUser();
  const { token } = await params;
  const { error } = await searchParams;
  const found = await findInvitationByToken(db(), token);
  const account = session.user.githubLogin ? `@${session.user.githubLogin}` : (session.user.email ?? session.user.name);

  if (!found) {
    return (
      <Card title="Invitation not found">
        <p>{ORG_ERROR_MESSAGES.invalid}</p>
        <Link className="button" href="/orgs">
          Go to your organizations
        </Link>
      </Card>
    );
  }

  const inv = found.invitation;
  const state = invitationState(inv, new Date());
  // Existing members are not asked to accept: doing so would not change anything, and an open link must stay
  // usable for the teammate it was meant for. "Open" switches to the org without consuming the invitation.
  if (await getMembership(db(), inv.orgId, session.userId)) {
    return (
      <Card title={`You're a member of ${found.orgName}`}>
        <p className="dim">
          {state === "accepted" && inv.acceptedBy === session.userId
            ? "You already accepted this invitation."
            : "You're already in this organization, so this invitation isn't needed. It stays available for the person it was meant for."}
        </p>
        <form action={acceptInviteAction}>
          <input type="hidden" name="token" value={token} />
          <button className="button button-primary button-block" type="submit">
            Open {found.orgName}
          </button>
        </form>
      </Card>
    );
  }

  const identity = { id: session.userId, email: session.user.email, githubLogin: session.user.githubLogin };
  let problem: OrgErrorCode | null = null;
  if (state === "accepted") problem = "already_accepted";
  else if (state !== "pending") problem = state;
  else if (!invitationTargetsUser(inv, identity)) problem = "wrong_user";
  // An error reported back by a failed accept attempt (e.g. a concurrent revoke).
  const reported = orgErrorCode(error);

  if (problem) {
    return (
      <Card title="This invitation can't be used">
        <Alert tone="error">{ORG_ERROR_MESSAGES[problem]}</Alert>
        <p className="dim">You&apos;re signed in as {account}.</p>
        <Link className="button" href="/orgs">
          Go to your organizations
        </Link>
      </Card>
    );
  }

  return (
    <Card title={`Join ${found.orgName}`}>
      <p>
        {found.invitedByName ? `${found.invitedByName} invited you` : "You've been invited"} to join <strong>{found.orgName}</strong> on
        OpenReview as <strong>{ROLE_LABEL[inv.role]}</strong>.
      </p>
      {reported && (
        <Alert tone="error">{ORG_ERROR_MESSAGES[reported]}</Alert>
      )}
      <form action={acceptInviteAction}>
        <input type="hidden" name="token" value={token} />
        <SubmitButton variant="primary" block pendingLabel="Joining…">
          Accept invitation
        </SubmitButton>
      </form>
      <p className="dim">Signed in as {account}. The invitation expires {inv.expiresAt.toISOString().slice(0, 10)}.</p>
    </Card>
  );
}
