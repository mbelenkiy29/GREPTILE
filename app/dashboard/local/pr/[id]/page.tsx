import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LocalPullRequest } from "@/components/local/LocalPullRequestView";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { localModeEnv } from "@/lib/env";
import { localModeBlocker } from "@/lib/git/local/guard";
import { getLocalPullRequestView } from "@/lib/git/local/view";

export const metadata: Metadata = { title: "Local pull request" };
export const dynamic = "force-dynamic";

/** A pull request on the local demo host (R6.22): its diff with inline comments, from the local repository. */
export default async function LocalPullRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const mode = localModeEnv();
  if (localModeBlocker(mode)) notFound();
  const { orgId } = await requireOrg();
  const id = Number((await params).id);
  const view = Number.isSafeInteger(id) && id > 0 ? await getLocalPullRequestView(db(), orgId, id, mode.LOCAL_GIT_ROOT) : undefined;
  if (!view) notFound();
  const { pr } = view;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Reviews", href: "/dashboard/reviews" }, { label: `${view.repo.fullName}#${pr.number}` }]}
        title={
          <>
            {pr.title} <span className="dim" style={{ fontSize: "0.7em", fontWeight: 500 }}>#{pr.number}</span>
          </>
        }
        description={pr.body || undefined}
        meta={
          <>
            <Badge tone={pr.state === "open" ? "ok" : "muted"}>{pr.state}</Badge>
            <span className="dim">
              @{pr.author} · <span className="mono">{pr.headRef}</span> → <span className="mono">{pr.baseRef}</span> · local demo host
            </span>
          </>
        }
      />
      <LocalPullRequest view={view} />
    </>
  );
}
