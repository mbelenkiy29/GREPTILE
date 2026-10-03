import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/Badge";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listRepoOverview } from "@/lib/data/repos";
import { siteEnv } from "@/lib/env";
import { formatCount, formatRelative } from "@/lib/ui/format";
import { intParam, type SearchParams } from "@/lib/ui/url";

export const metadata: Metadata = { title: "Knowledge" };

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId } = await requireOrg();
  const sp = await searchParams;
  const focus = intParam(sp, "repo");
  const repos = await listRepoOverview(db(), orgId, { pageSize: 100 });
  const docs = `${siteEnv().SOURCE_CODE_URL}/blob/main/docs/OPENREVIEW_SPEC.md`;
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Knowledge"
        description="What reviews know about your code: the index of each repository, and the docs and conventions reviewers read."
      />
      <EmptyState
        icon="knowledge"
        title="No knowledge sources added yet"
        actions={
          <>
            <ButtonLink href="/dashboard/rules">Write rules</ButtonLink>
            <ButtonLink href={docs} external variant="ghost">
              Read the docs
            </ButtonLink>
          </>
        }
      >
        <p>
          This page will list the documents, architecture notes, and team conventions OpenReview uses as review context, with search
          across them. Until then, reviews already use each repository&apos;s code index below, its <code>openreview.json</code> context
          files, and your rules.
        </p>
      </EmptyState>
      <Card title="Code index" titleId="code-index-heading" description="Indexed files and symbols per repository" flush>
        {repos.items.length ? (
          <Table caption="Code index by repository" compact>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Index</th>
                <th scope="col" className="num">
                  Files
                </th>
                <th scope="col" className="num">
                  Symbols
                </th>
                <th scope="col">Indexed</th>
              </tr>
            </thead>
            <tbody>
              {repos.items.map((r) => (
                <tr key={r.id} data-repo={r.fullName} aria-current={r.id === focus ? "true" : undefined} style={r.id === focus ? { outline: "2px solid var(--accent)" } : undefined}>
                  <td>
                    <Link className="cell-title" href={`/dashboard/repos/${r.id}`}>
                      {r.fullName}
                    </Link>
                  </td>
                  <td>
                    <StatusPill kind="index" value={r.indexJob ? "indexing" : r.indexStatus} />
                  </td>
                  <td className="num">{formatCount(r.fileCount)}</td>
                  <td className="num">{formatCount(r.symbolCount)}</td>
                  <td className="nowrap">{formatRelative(r.indexedAt, now)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="empty">
            No repositories connected yet. <Link href="/dashboard/repos">Connect one</Link> to build its index.
          </p>
        )}
      </Card>
    </>
  );
}
