import type { Metadata } from "next";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/icons";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { getInstallationHealth, listRepos, REQUIRED_PERMISSIONS } from "@/lib/data/installations";
import { siteEnv } from "@/lib/env";
import { githubInstallationSettingsUrl } from "@/lib/ui/format";

export const metadata: Metadata = { title: "GitHub" };

const STATUS = {
  ok: { tone: "ok", label: "Healthy" },
  missing_permissions: { tone: "warn", label: "Missing permissions" },
  suspended: { tone: "bad", label: "Suspended" },
} as const;

/** Settings → GitHub: the org's GitHub App installations with their health and repositories (R1.1). */
export default async function GitHubSettingsPage() {
  const { orgId, role } = await requireOrg();
  const [installations, repos] = await Promise.all([getInstallationHealth(db(), orgId), listRepos(db(), orgId)]);
  const web = siteEnv().GITHUB_WEB_URL;
  const manage = can(role, "repos.manage");
  const required = Object.entries(REQUIRED_PERMISSIONS).map(([k, v]) => `${k}:${v}`);
  const addButton = manage ? (
    <ButtonLink href="/api/github/install" icon="github" variant="primary">
      Add installation
    </ButtonLink>
  ) : undefined;
  return (
    <>
      <p className="dim">
        OpenReview works through a GitHub App installed on your accounts and organizations. Repository access is managed on GitHub.
        {!manage && " Only owners and admins can add installations."}
      </p>
      {installations.length === 0 ? (
        <EmptyState icon="github" title="No GitHub installations yet" headingLevel={2} actions={addButton}>
          <p>Install the GitHub App to connect repositories. Already installed it? Connect it from onboarding.</p>
        </EmptyState>
      ) : (
        <Card title="Installations" titleId="installations-heading" actions={addButton} flush>
          <Table caption="GitHub installations" captionHidden>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Health</th>
                <th scope="col">Permissions</th>
                <th scope="col" className="num">
                  Repositories
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {installations.map((i) => {
                const count = repos.filter((r) => r.installationId === i.id).length;
                return (
                  <tr key={i.id} data-installation={i.externalId} data-status={i.status}>
                    <td>
                      <div className="strong">{i.accountLogin}</div>
                      <div className="cell-sub">
                        {i.accountType ?? "Account"}
                        {i.repositorySelection === "all" ? " · all repositories" : i.repositorySelection === "selected" ? " · selected repositories" : ""}
                      </div>
                    </td>
                    <td>
                      <Badge tone={STATUS[i.status].tone} dot>
                        {STATUS[i.status].label}
                      </Badge>
                    </td>
                    <td>
                      {!i.permissionsVerified ? (
                        <span className="dim">Not reported yet</span>
                      ) : i.missingPermissions.length ? (
                        <span className="error-text">
                          Missing <span className="mono">{i.missingPermissions.join(", ")}</span>
                        </span>
                      ) : (
                        <span className="dim">All required granted</span>
                      )}
                      {i.missingRecommended.length > 0 && (
                        <div className="cell-sub">
                          Recommended: <span className="mono">{i.missingRecommended.join(", ")}</span>
                        </div>
                      )}
                    </td>
                    <td className="num">{count}</td>
                    <td>
                      <a href={githubInstallationSettingsUrl(i, web)} target="_blank" rel="noreferrer" className="nowrap">
                        Manage on GitHub <Icon name="external" size={12} />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      <p className="dim">
        Required permissions: <span className="mono">{required.join(", ")}</span>. A suspended installation is not reviewed until it&apos;s unsuspended on
        GitHub.
        {manage && (
          <>
            {" "}
            Installed the app before connecting it here? <a href="/onboarding?step=install">Connect an existing installation</a>.
          </>
        )}
      </p>
    </>
  );
}
