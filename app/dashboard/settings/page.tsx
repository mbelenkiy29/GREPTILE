import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireOrg } from "@/lib/auth";
import { can, ROLE_LABEL } from "@/lib/auth/permissions";
import { ORG_ERROR_MESSAGES, orgErrorCode } from "@/lib/data/orgs";
import { param, type SearchParams } from "@/lib/ui/url";
import { deleteOrganization, renameOrganization } from "./actions";

export const metadata: Metadata = { title: "Settings" };

/** Settings → General: the org's name and slug, and deleting the org. */
export default async function GeneralSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const ctx = await requireOrg();
  const code = orgErrorCode(param(await searchParams, "error"));
  const canRename = can(ctx.role, "org.update");
  const canDelete = can(ctx.role, "org.delete");
  return (
    <>
      {code && <Alert tone="error">{ORG_ERROR_MESSAGES[code]}</Alert>}
      <Card title="Organization" titleId="org-heading" description="The name appears across the dashboard; the slug identifies the organization in URLs and the API.">
        <form action={renameOrganization} className="stack-md" data-testid="org-rename">
          <fieldset className="fieldset form-row" disabled={!canRename}>
            <div className="field">
              <label className="field-label" htmlFor="org-name">
                Name
              </label>
              <input id="org-name" name="name" className="input" required minLength={1} maxLength={80} defaultValue={ctx.orgName} autoComplete="organization" />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="org-slug">
                Slug
              </label>
              <input
                id="org-slug"
                name="slug"
                className="input mono"
                required
                maxLength={40}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                defaultValue={ctx.orgSlug}
                aria-describedby="org-slug-help"
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="field-help" id="org-slug-help">
                Lowercase letters, digits, and dashes.
              </p>
            </div>
          </fieldset>
          {canRename ? (
            <div className="form-actions">
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Save
              </SubmitButton>
            </div>
          ) : (
            <p className="dim">You&apos;re a {ROLE_LABEL[ctx.role].toLowerCase()}. Only owners and admins can rename the organization.</p>
          )}
        </form>
      </Card>

      <Card title="Members and roles" titleId="members-heading">
        <p className="dim">
          Invite teammates and change roles on the <Link href="/dashboard/team">Team</Link> page.
        </p>
      </Card>

      <Card title="Delete organization" titleId="delete-heading" description="Permanently deletes the organization with its repositories, index, reviews, findings, rules, and learned preferences.">
        {ctx.personal ? (
          <p className="dim">This is your personal workspace, so it can&apos;t be deleted.</p>
        ) : canDelete ? (
          <form action={deleteOrganization} className="stack-sm" data-testid="org-delete">
            <Alert tone="warning">This can&apos;t be undone. The GitHub App stays installed on GitHub; uninstall it there if you no longer need it.</Alert>
            <div className="field" style={{ maxWidth: 360 }}>
              <label className="field-label" htmlFor="org-delete-confirm">
                Type <span className="mono strong">{ctx.orgSlug}</span> to confirm
              </label>
              <input id="org-delete-confirm" name="confirm" className="input mono" required autoComplete="off" spellCheck={false} />
            </div>
            <div>
              <SubmitButton variant="danger" pendingLabel="Deleting…">
                Delete this organization
              </SubmitButton>
            </div>
          </form>
        ) : (
          <p className="dim">Only owners can delete the organization.</p>
        )}
      </Card>
    </>
  );
}
