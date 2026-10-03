import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { localModeEnabled } from "@/lib/git/local/guard";
import { findLocalPullRequestId } from "@/lib/git/local/view";
import { intParam, param, type SearchParams } from "@/lib/ui/url";

export const dynamic = "force-dynamic";

/** `/dashboard/local/pr?repo=owner/name&number=7` (the local host's pull request links) → the pull request page. */
export default async function LocalPullRequestLookup({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!localModeEnabled()) notFound();
  const { orgId } = await requireOrg();
  const sp = await searchParams;
  const repo = param(sp, "repo");
  const number = intParam(sp, "number");
  const id = repo && number ? await findLocalPullRequestId(db(), orgId, repo, number) : undefined;
  if (!id) notFound();
  redirect(`/dashboard/local/pr/${id}`);
}
