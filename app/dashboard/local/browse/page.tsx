import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/ui/Code";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { localModeEnv } from "@/lib/env";
import { localModeBlocker } from "@/lib/git/local/guard";
import { browseLocalRepo } from "@/lib/git/local/view";
import { shortSha } from "@/lib/ui/format";
import { param, type SearchParams } from "@/lib/ui/url";

export const metadata: Metadata = { title: "Local repository" };
export const dynamic = "force-dynamic";

/** Files and commits of a repository on the local demo host (R6.22); where the dashboard's local links lead. */
export default async function LocalBrowsePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const mode = localModeEnv();
  if (localModeBlocker(mode)) notFound();
  const { orgId } = await requireOrg();
  const sp = await searchParams;
  const repo = param(sp, "repo");
  if (!repo) notFound();
  const view = await browseLocalRepo(db(), orgId, mode.LOCAL_GIT_ROOT, { repo, ref: param(sp, "ref"), path: param(sp, "path"), view: param(sp, "view") });
  if (!view) notFound();
  const ref = /^[0-9a-f]{40}$/.test(view.ref) ? shortSha(view.ref) : view.ref;
  const fileHref = (p: string) => `/dashboard/local/browse?${new URLSearchParams({ repo: view.repo, ref: view.ref, path: p }).toString()}`;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Repositories", href: "/dashboard/repos" }, { label: view.repo }]}
        title={view.kind === "file" ? view.path : view.kind === "commit" ? `Commit ${ref}` : view.repo}
        description={`Local demo host · ${ref}`}
      />
      {view.kind === "file" && <CodeBlock code={view.content} title={`${view.path} @ ${ref}`} />}
      {view.kind === "commit" && <CodeBlock code={view.text} title={`git show ${ref}`} />}
      {view.kind === "tree" && (
        <ul className="comments">
          {view.paths.map((p) => (
            <li key={p} className="mono">
              <Link href={fileHref(p)}>{p}</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
