import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { PROVIDER_LABEL } from "@/lib/git/web-url";
import { errorMessage, log } from "@/lib/log";
import { listConnectionRepos, listConnections } from "@/lib/scm/connections";
import { productionScmDeps } from "@/lib/scm/deps";
import { disableRepoAction, enableRepoAction } from "../actions";

export const metadata: Metadata = { title: "Git provider repositories" };

/** The repositories a GitLab / Bitbucket connection can reach, and which ones OpenReview reviews (R3.6). */
export default async function ConnectionReposPage({ params }: { params: Promise<{ id: string }> }) {
  const { orgId, role } = await requireOrg();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const connection = (await listConnections(db(), orgId)).find((c) => c.id === id);
  if (!connection) notFound();
  const manage = can(role, "repos.manage");
  const path = `/dashboard/settings/git-providers/${id}`;
  let repos: Awaited<ReturnType<typeof listConnectionRepos>> = [];
  let error: string | null = null;
  try {
    repos = (await listConnectionRepos(productionScmDeps(), orgId, id)) ?? [];
  } catch (err) {
    log.warn("could not list a connection's repositories", { orgId, credentialId: id, error: errorMessage(err) });
    error = `${PROVIDER_LABEL[connection.provider]} could not be reached with this connection's token. Check the connection on the Git providers tab.`;
  }
  const label = connection.provider === "gitlab" ? new URL(connection.baseUrl).host : connection.workspace;
  return (
    <>
      <p>
        <Link href="/dashboard/settings/git-providers">← Git providers</Link>
      </p>
      <h2>
        {PROVIDER_LABEL[connection.provider]} · {label}
      </h2>
      <p className="dim">
        {connection.provider === "gitlab"
          ? "Projects where the token has the Maintainer role (needed to create webhooks)."
          : "Repositories in the workspace."}{" "}
        Enabling one creates its webhook and queues the first index; disabling removes the webhook and keeps the history.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {!error && repos.length === 0 ? (
        <EmptyState icon="repo" title="No repositories reachable" headingLevel={3}>
          <p>The token can&apos;t see any repositories it may add webhooks to.</p>
        </EmptyState>
      ) : (
        repos.length > 0 && (
          <Card flush>
            <Table caption={`${PROVIDER_LABEL[connection.provider]} repositories`} captionHidden>
              <thead>
                <tr>
                  <th scope="col">Repository</th>
                  <th scope="col">Reviews</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {repos.map((r) => (
                  <tr key={r.id} data-repo={r.fullName}>
                    <td>
                      <div className="strong">{r.repoId ? <Link href={`/dashboard/repos/${r.repoId}`}>{r.fullName}</Link> : r.fullName}</div>
                      <div className="cell-sub">
                        <span className="mono">{r.defaultBranch}</span> · {r.private ? "private" : "public"}
                      </div>
                    </td>
                    <td>
                      {r.enabled ? (
                        <Badge tone="ok" dot>
                          On
                        </Badge>
                      ) : (
                        <Badge tone="muted">Off</Badge>
                      )}
                    </td>
                    <td>
                      {manage &&
                        (r.enabled && r.repoId ? (
                          <form action={disableRepoAction}>
                            <input type="hidden" name="repoId" value={r.repoId} />
                            <input type="hidden" name="returnTo" value={path} />
                            <button className="button button-sm" type="submit">
                              Disable
                            </button>
                          </form>
                        ) : (
                          <form action={enableRepoAction}>
                            <input type="hidden" name="credentialId" value={id} />
                            <input type="hidden" name="externalId" value={r.id} />
                            <input type="hidden" name="returnTo" value={path} />
                            <button className="button button-sm button-primary" type="submit">
                              Enable
                            </button>
                          </form>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )
      )}
    </>
  );
}
