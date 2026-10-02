import Link from "next/link";
import { UserMenu } from "@/components/auth/UserMenu";
import { requireUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listInvitationsForUser } from "@/lib/data/members";
import { listUserOrgs, ORG_ERROR_MESSAGES, orgErrorCode } from "@/lib/data/orgs";
import { acceptListedInvitation, createOrgAction, switchOrg } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Organizations · OpenReview" };

export default async function OrgsPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const session = await requireUser();
  const [orgs, invitations] = await Promise.all([
    listUserOrgs(db(), session.userId),
    listInvitationsForUser(db(), { id: session.userId, email: session.user.email, githubLogin: session.user.githubLogin }, new Date()),
  ]);
  const { error } = await searchParams;
  const errorCode = orgErrorCode(error);
  const errorText = errorCode ? ORG_ERROR_MESSAGES[errorCode] : null;

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/dashboard" className="brand">
          OpenReview
        </Link>
        <div className="spacer" />
        <UserMenu user={session.user} />
      </header>
      <main className="stack">
        <div className="page-head">
          <h1>Organizations</h1>
        </div>
        {errorText && (
          <p className="notice notice-bad" role="alert">
            {errorText}
          </p>
        )}

        {invitations.length > 0 && (
          <section className="stack-sm" aria-labelledby="invites-heading">
            <h2 id="invites-heading">Invitations for you</h2>
            <ul className="comments">
              {invitations.map((inv) => (
                <li key={inv.id} className="comment row" data-invitation={inv.id}>
                  <span>
                    <span className="strong">{inv.orgName}</span>{" "}
                    <span className="dim">
                      as {ROLE_LABEL[inv.role]}
                      {inv.invitedByName ? ` · invited by ${inv.invitedByName}` : ""}
                    </span>
                  </span>
                  <span className="spacer" />
                  <form action={acceptListedInvitation}>
                    <input type="hidden" name="invitationId" value={inv.id} />
                    <button className="button button-primary" type="submit">
                      Accept
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="stack-sm" aria-labelledby="orgs-heading">
          <h2 id="orgs-heading">Your organizations</h2>
          {orgs.length === 0 ? (
            <p className="empty">You&apos;re not a member of any organization yet. Create one below or open an invitation link.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Organization</th>
                    <th scope="col">Your role</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orgs.map((o) => (
                    <tr key={o.id} data-org={o.slug}>
                      <td>
                        <div className="strong">
                          {o.name} {o.personal && <span className="badge badge-muted">Personal</span>}
                        </div>
                        <div className="dim mono">{o.slug}</div>
                      </td>
                      <td>{ROLE_LABEL[o.role]}</td>
                      <td className="actions">
                        <form action={switchOrg}>
                          <input type="hidden" name="orgId" value={o.id} />
                          <button className="button" type="submit">
                            {o.id === session.activeOrgId ? "Open" : "Switch"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="stack-sm" aria-labelledby="create-heading">
          <h2 id="create-heading">Create an organization</h2>
          <form action={createOrgAction} className="comment row">
            <label>
              Name <input name="name" required minLength={1} maxLength={80} placeholder="Acme Engineering" />
            </label>
            <button className="button button-primary" type="submit">
              Create organization
            </button>
          </form>
          <p className="dim">You become its owner and can invite teammates from the Team page.</p>
        </section>
      </main>
    </div>
  );
}
