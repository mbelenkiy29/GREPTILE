import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FreshnessBadge, KIND_ICONS, kindLabel } from "@/components/dashboard/KnowledgeGrid";
import { Alert } from "@/components/ui/Alert";
import { Badge, StatusPill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Field";
import { Icon } from "@/components/ui/icons";
import { Markdown } from "@/components/ui/Markdown";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { getKnowledgeEntry, knowledgeEnabled } from "@/lib/data/knowledge";
import { siteEnv } from "@/lib/env";
import { formatCount, formatDate, githubBlobUrl, githubCommitUrl, shortSha } from "@/lib/ui/format";
import { decideKnowledgeProposal, regenerateKnowledge, saveKnowledgeDescription } from "../actions";

export const metadata: Metadata = { title: "Knowledge entry" };

export default async function KnowledgeEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { orgId, role } = await requireOrg();
  const id = Number((await params).id);
  const detail = Number.isSafeInteger(id) && id > 0 ? await getKnowledgeEntry(db(), orgId, id) : null;
  if (!detail) notFound();
  const { entry, repo } = detail;
  const admin = can(role, "repos.manage");
  const githubUrl = siteEnv().GITHUB_WEB_URL;
  // Files link to GitHub at the commit the entry was generated from (else the indexed commit).
  const sha = entry.lastCommitSha ?? repo.indexedSha;
  const fileHref = (path: string) => (sha ? githubBlobUrl(repo.fullName, sha, path, undefined, githubUrl) : null);
  const path = `/dashboard/knowledge/${entry.id}`;
  const roles = new Map(entry.keyFiles.map((k) => [k.path, k.role]));
  const others = entry.relatedFiles.filter((p) => !roles.has(p));
  const canRegenerate = admin && knowledgeEnabled() && Boolean(repo.indexedSha);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Knowledge", href: `/dashboard/knowledge?repo=${repo.id}` }, { label: repo.fullName, href: `/dashboard/knowledge?repo=${repo.id}` }, { label: entry.title }]}
        title={entry.title}
        meta={
          <>
            <Badge tone="outline">
              <Icon name={KIND_ICONS[entry.kind]} size={12} /> {kindLabel(entry.kind)}
            </Badge>
            <FreshnessBadge entry={entry} />
            {entry.source === "edited" && <Badge tone="accent">Edited{entry.editedAt ? ` ${formatDate(entry.editedAt)}` : ""}</Badge>}
            <span className="dim">
              {entry.lastCommitSha ? (
                <>
                  Updated {formatDate(entry.lastUpdatedAt)} from{" "}
                  <a className="mono" href={githubCommitUrl(repo.fullName, entry.lastCommitSha, githubUrl)} target="_blank" rel="noreferrer">
                    {shortSha(entry.lastCommitSha)}
                  </a>
                </>
              ) : (
                "Not generated yet"
              )}
            </span>
          </>
        }
        actions={
          canRegenerate ? (
            <form action={regenerateKnowledge}>
              <input type="hidden" name="entryId" value={entry.id} />
              <input type="hidden" name="returnTo" value={path} />
              <SubmitButton icon="refresh" size="sm" pendingLabel="Queuing…">
                Regenerate
              </SubmitButton>
            </form>
          ) : undefined
        }
      />

      {entry.lastError && (
        <Alert tone={entry.lastUpdatedAt ? "warning" : "error"} title="The last regeneration did not complete">
          {entry.lastError}
        </Alert>
      )}

      {entry.proposedDescription !== null && (
        <Card
          title="Proposed update"
          titleId="proposal-heading"
          description={`This entry was edited by hand, so regeneration ${entry.proposedAt ? `on ${formatDate(entry.proposedAt)} ` : ""}proposed a new description instead of replacing it.`}
          actions={
            admin ? (
              <>
                <form action={decideKnowledgeProposal}>
                  <input type="hidden" name="entryId" value={entry.id} />
                  <input type="hidden" name="decision" value="accept" />
                  <input type="hidden" name="returnTo" value={path} />
                  <SubmitButton size="sm" variant="primary" icon="check">
                    Accept
                  </SubmitButton>
                </form>
                <form action={decideKnowledgeProposal}>
                  <input type="hidden" name="entryId" value={entry.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <input type="hidden" name="returnTo" value={path} />
                  <SubmitButton size="sm" icon="x">
                    Keep current text
                  </SubmitButton>
                </form>
              </>
            ) : undefined
          }
        >
          <Markdown source={entry.proposedDescription} headingOffset={2} />
        </Card>
      )}

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card title="Description" titleId="description-heading">
          {entry.description ? (
            <Markdown source={entry.description} headingOffset={2} />
          ) : (
            <p className="dim">{entry.stale ? "This entry is queued for generation." : "No description yet."}</p>
          )}
          {admin && (
            <details className="knowledge-edit">
              <summary>Edit description</summary>
              <form action={saveKnowledgeDescription} className="stack-sm">
                <input type="hidden" name="entryId" value={entry.id} />
                <input type="hidden" name="returnTo" value={path} />
                <Textarea
                  name="description"
                  label="Description (Markdown)"
                  help="At most 1,500 words. Once edited, regenerations propose changes for you to accept instead of overwriting your text."
                  defaultValue={entry.description}
                  rows={14}
                  required
                />
                <div className="row-tight">
                  <SubmitButton variant="primary" size="sm" pendingLabel="Saving…">
                    Save description
                  </SubmitButton>
                </div>
              </form>
            </details>
          )}
        </Card>

        <div className="stack-md">
          <Card title="Risks" titleId="risks-heading">
            {entry.risks.length ? (
              <ul className="knowledge-list">
                {entry.risks.map((r, i) => (
                  <li key={i}>
                    <div className="row-tight">
                      <StatusPill kind="risk" value={r.severity} />
                      <span className="strong">{r.title}</span>
                    </div>
                    <p className="dim">{r.detail}</p>
                    {r.files.length > 0 && (
                      <p className="dim mono">
                        {r.files.map((f, j) => {
                          const href = fileHref(f);
                          return (
                            <span key={f}>
                              {j > 0 && ", "}
                              {href ? (
                                <a href={href} target="_blank" rel="noreferrer">
                                  {f}
                                </a>
                              ) : (
                                f
                              )}
                            </span>
                          );
                        })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dim">No known risks recorded.</p>
            )}
          </Card>

          <Card title="Conventions" titleId="conventions-heading">
            {entry.conventions.length ? (
              <ul className="knowledge-list">
                {entry.conventions.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="dim">No conventions recorded.</p>
            )}
          </Card>

          <Card
            title="Past findings"
            titleId="findings-heading"
            actions={<Link href={`/dashboard/findings?repo=${repo.id}`}>All findings</Link>}
          >
            {entry.pastFindings.total ? (
              <>
                <p className="dim">
                  {formatCount(entry.pastFindings.total)} published finding{entry.pastFindings.total === 1 ? "" : "s"} in these files: {entry.pastFindings.counts.critical} critical,{" "}
                  {entry.pastFindings.counts.high} high, {entry.pastFindings.counts.medium} medium, {entry.pastFindings.counts.low} low.
                </p>
                <ul className="knowledge-list">
                  {entry.pastFindings.recent.map((f) => (
                    <li key={f.id} className="row-tight">
                      <StatusPill kind="severity" value={f.severity} />
                      <Link href={`/dashboard/reviews/${f.reviewId}#finding-${f.id}-title`}>{f.title}</Link>
                      <StatusPill kind="finding" value={f.status} />
                      <span className="dim mono truncate">{f.path}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="dim">No review findings in these files yet.</p>
            )}
          </Card>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <Card title="Related files" titleId="files-heading" description={`${formatCount(entry.facts.fileCount || entry.relatedFiles.length)} files in this subsystem${sha ? ` at ${shortSha(sha)}` : ""}, most central first`}>
          <ul className="knowledge-list">
            {[...entry.keyFiles.map((k) => k.path), ...others].map((f) => {
              const href = fileHref(f);
              const role = roles.get(f);
              return (
                <li key={f}>
                  {href ? (
                    <a className="mono" href={href} target="_blank" rel="noreferrer">
                      {f}
                    </a>
                  ) : (
                    <span className="mono">{f}</span>
                  )}
                  {role && <span className="dim"> — {role}</span>}
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="stack-md">
          <Card title="Dependencies" titleId="deps-heading">
            {entry.dependencies.internal.length || entry.dependencies.external.length ? (
              <dl className="kv">
                {entry.dependencies.internal.length > 0 && (
                  <>
                    <dt>Uses internally</dt>
                    <dd>
                      <ul className="knowledge-list">
                        {entry.dependencies.internal.map((d) => (
                          <li key={`${d.subsystem ?? ""}:${d.path}`}>
                            <span className={d.subsystem ? undefined : "mono"}>{d.path}</span> <span className="dim">({d.imports} import{d.imports === 1 ? "" : "s"})</span>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {entry.dependencies.external.length > 0 && (
                  <>
                    <dt>Packages</dt>
                    <dd>
                      <ul className="knowledge-list">
                        {entry.dependencies.external.map((d) => (
                          <li key={d.name}>
                            <span className="mono">{d.name}</span>
                            {d.version && <span className="dim mono"> {d.version}</span>}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              <p className="dim">No dependencies found in the index.</p>
            )}
          </Card>

          {(entry.facts.routes.length > 0 || entry.facts.tables.length > 0 || entry.facts.tests.length > 0 || entry.facts.ciJobs.length > 0) && (
            <Card title="From the index" titleId="facts-heading">
              <dl className="kv">
                {entry.facts.routes.length > 0 && (
                  <>
                    <dt>Routes</dt>
                    <dd className="mono">{entry.facts.routes.join(", ")}</dd>
                  </>
                )}
                {entry.facts.tables.length > 0 && (
                  <>
                    <dt>Tables and models</dt>
                    <dd className="mono">{entry.facts.tables.join(", ")}</dd>
                  </>
                )}
                {entry.facts.tests.length > 0 && (
                  <>
                    <dt>Tests</dt>
                    <dd className="mono">{entry.facts.tests.join(", ")}</dd>
                  </>
                )}
                {entry.facts.ciJobs.length > 0 && (
                  <>
                    <dt>CI jobs</dt>
                    <dd className="mono">{entry.facts.ciJobs.join(", ")}</dd>
                  </>
                )}
              </dl>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
