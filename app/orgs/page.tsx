import { UserMenu } from "@/components/auth/UserMenu";
import { Brand } from "@/components/shell/Brand";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table } from "@/components/ui/Table";
import { requireUser } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listInvitationsForUser } from "@/lib/data/members";
import { listUserOrgs, ORG_ERROR_MESSAGES, orgErrorCode } from "@/lib/data/orgs";
import { acceptListedInvitation, createOrgAction, switchOrg } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Organizations" };

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
        <Brand />
        <div className="spacer" />
        <div style={{ minWidth: 0, maxWidth: 260 }}>
          <UserMenu user={session.user} align="end" />
        </div>
      </header>
      <main id="main" className="stack">
        <PageHeader title="Organizations" description="Switch between the workspaces you belong to, accept invitations, or start a new one." />
        {errorText && <Alert tone="error">{errorText}</Alert>}

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
                    <SubmitButton variant="primary" size="sm">
                      Accept
                    </SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="stack-sm" aria-labelledby="orgs-heading">
          <h2 id="orgs-heading">Your organizations</h2>
          {orgs.length === 0 ? (
            <EmptyState icon="building" title="You're not in any organization yet" headingLevel={3}>
              <p>Create one below, or open an invitation link a teammate sent you.</p>
            </EmptyState>
          ) : (
            <Table caption="Your organizations">
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
                        {o.name} {o.personal && <Badge>Personal</Badge>} {o.id === session.activeOrgId && <Badge tone="accent">Current</Badge>}
                      </div>
                      <div className="dim mono">{o.slug}</div>
                    </td>
                    <td>{ROLE_LABEL[o.role]}</td>
                    <td>
                      <form action={switchOrg} className="actions">
                        <input type="hidden" name="orgId" value={o.id} />
                        <SubmitButton size="sm" variant={o.id === session.activeOrgId ? "primary" : "default"}>
                          {o.id === session.activeOrgId ? "Open" : "Switch"}
                        </SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>

        <Card title="Create an organization" titleId="create-heading" description="You become its owner and can invite teammates from the Team page.">
          <form action={createOrgAction} className="row" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: "1 1 240px" }}>
              <label className="field-label" htmlFor="org-name">
                Name
              </label>
              <input id="org-name" className="input" name="name" required minLength={1} maxLength={80} placeholder="Acme Engineering" />
            </div>
            <SubmitButton variant="primary" icon="plus">
              Create organization
            </SubmitButton>
          </form>
        </Card>
      </main>
    </div>
  );
}
