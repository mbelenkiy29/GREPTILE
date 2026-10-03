import type { Metadata } from "next";
import Link from "next/link";
import { ConnectProviderForm } from "@/components/scm/ConnectProviderForm";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/ui/icons";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { scmEnv } from "@/lib/env";
import { PROVIDER_LABEL } from "@/lib/git/web-url";
import { BITBUCKET_REQUIRED_SCOPES, GITLAB_REQUIRED_SCOPES, listConnections, type ConnectionStatus } from "@/lib/scm/connections";
import { formatDate, formatDay } from "@/lib/ui/format";
import { checkConnectionAction, connectBitbucketAction, connectGitLabAction, disconnectAction } from "./actions";

export const metadata: Metadata = { title: "Git providers" };

const STATUS: Record<ConnectionStatus, { tone: "ok" | "warn" | "bad"; label: string }> = {
  ok: { tone: "ok", label: "Healthy" },
  expiring: { tone: "warn", label: "Expiring soon" },
  missing_scopes: { tone: "warn", label: "Missing scopes" },
  expired: { tone: "bad", label: "Expired" },
  invalid: { tone: "bad", label: "Check failed" },
};

/** Settings → Git providers (R3.6): GitLab and Bitbucket Cloud connections, their health, and connecting new ones. */
export default async function GitProvidersPage() {
  const { orgId, role } = await requireOrg();
  const manage = can(role, "repos.manage");
  const connections = await listConnections(db(), orgId);
  const e = scmEnv();
  return (
    <>
      <p className="dim">
        Connect GitLab (gitlab.com or self-managed) and Bitbucket Cloud with an access token. Tokens are encrypted at rest and never shown
        again. Enabling a repository creates its webhook automatically. GitHub is connected through the GitHub App on the GitHub tab.
        {!manage && " Only owners and admins can manage connections."}
      </p>
      {connections.length === 0 ? (
        <EmptyState icon="source" title="No GitLab or Bitbucket connections yet" headingLevel={2}>
          <p>{manage ? "Connect a provider below to review its merge requests and pull requests." : "Ask an owner or admin to connect a provider."}</p>
        </EmptyState>
      ) : (
        <Card title="Connections" titleId="connections-heading" flush>
          <Table caption="Git provider connections" captionHidden>
            <thead>
              <tr>
                <th scope="col">Connection</th>
                <th scope="col">Health</th>
                <th scope="col">Token</th>
                <th scope="col" className="num">
                  Repositories
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id} data-connection={c.id} data-status={c.status}>
                  <td>
                    <div className="strong">
                      <Icon name={c.provider === "gitlab" ? "gitlab" : "bitbucket"} size={14} /> {PROVIDER_LABEL[c.provider]}{" "}
                      {c.provider === "gitlab" ? new URL(c.baseUrl).host : c.workspace}
                    </div>
                    <div className="cell-sub">
                      {c.accountLogin ? `as ${c.accountLogin}` : "account not reported"}
                      {c.lastCheckedAt && ` · checked ${formatDate(c.lastCheckedAt)}`}
                    </div>
                  </td>
                  <td>
                    <Badge tone={STATUS[c.status].tone} dot>
                      {STATUS[c.status].label}
                    </Badge>
                    {c.lastError && <div className="cell-sub error-text">{c.lastError}</div>}
                  </td>
                  <td>
                    <div className="mono">{c.tokenName ?? (c.authKind === "app_password" ? `app password (${c.username ?? ""})` : "access token")}</div>
                    <div className="cell-sub">
                      {c.expiresAt ? `expires ${formatDay(c.expiresAt)}` : "no expiry reported"}
                      {c.missingScopes.length > 0 && (
                        <span className="error-text">
                          {" "}
                          · missing <span className="mono">{c.missingScopes.join(", ")}</span>
                        </span>
                      )}
                      {!c.scopesVerified && " · scopes not reported by the host"}
                    </div>
                  </td>
                  <td className="num">{c.enabledRepos}</td>
                  <td>
                    <div className="actions">
                      <Link href={`/dashboard/settings/git-providers/${c.id}`}>Repositories</Link>
                      {manage && (
                        <>
                          <form action={checkConnectionAction}>
                            <input type="hidden" name="credentialId" value={c.id} />
                            <button className="button button-sm" type="submit">
                              Check
                            </button>
                          </form>
                          <form action={disconnectAction}>
                            <input type="hidden" name="credentialId" value={c.id} />
                            <button className="button button-sm button-danger" type="submit">
                              Disconnect
                            </button>
                          </form>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {manage && (
        <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
          <Card title="Connect GitLab" titleId="connect-gitlab-heading" description={`Scopes: ${GITLAB_REQUIRED_SCOPES.join(", ")}.`}>
            <ConnectProviderForm provider="gitlab" action={connectGitLabAction} defaultGitLabUrl={e.GITLAB_URL} />
          </Card>
          <Card title="Connect Bitbucket Cloud" titleId="connect-bitbucket-heading" description={`Scopes: ${BITBUCKET_REQUIRED_SCOPES.join(", ")}.`}>
            <ConnectProviderForm provider="bitbucket" action={connectBitbucketAction} />
          </Card>
        </div>
      )}
      <p className="dim">
        Setup guides: <span className="mono">docs/gitlab.md</span> and <span className="mono">docs/bitbucket.md</span>. Webhooks point at{" "}
        <span className="mono">{e.APP_URL.replace(/\/+$/, "")}/api/webhooks/gitlab</span> and <span className="mono">/api/webhooks/bitbucket</span>.
      </p>
    </>
  );
}
