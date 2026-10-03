import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FindingFeedback } from "@/components/dashboard/FindingFeedback";
import { ReviewDetailView } from "@/components/dashboard/ReviewDetailView";
import { FixAllMenu } from "@/components/fix/FixWithAi";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { Icon } from "@/components/ui/icons";
import { Markdown } from "@/components/ui/Markdown";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { StatusPill } from "@/components/ui/Badge";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { feedbackForFindings } from "@/lib/data/feedback";
import { TERMINAL_RUN_STATUSES } from "@/lib/data/lifecycle";
import { getReviewDetail } from "@/lib/data/reviews";
import { siteEnv } from "@/lib/env";
import { REVIEW_MODES } from "@/lib/llm/types";
import { prUrl as hostPrUrl, PROVIDER_LABEL, repoWeb } from "@/lib/git/web-url";
import { intParam, type SearchParams } from "@/lib/ui/url";
import { giveFindingFeedback, retractFindingFeedback } from "../../findings/actions";
import { cancelReviewRun, rerunReview } from "../actions";

export const metadata: Metadata = { title: "Review" };

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { orgId, userId, role } = await requireOrg();
  const id = Number((await params).id);
  const runId = intParam(await searchParams, "run");
  const review = Number.isSafeInteger(id) ? await getReviewDetail(db(), orgId, id, { runId }) : undefined;
  if (!review) notFound();
  const feedback = await feedbackForFindings(db(), orgId, userId, review.findings.items.map((f) => f.id));
  const githubUrl = siteEnv().GITHUB_WEB_URL;
  const latest = review.runHistory[0];
  const shownRun = review.runHistory.some((r) => r.id === runId) ? runId : undefined;
  const active = latest !== undefined && !(TERMINAL_RUN_STATUSES as readonly string[]).includes(latest.status);
  const trigger = can(role, "reviews.trigger");
  const storedUrl = review.pullRequest?.url;
  // The stored URL came from the git host; only an http(s) link is used as is.
  const prUrl = storedUrl && /^https?:\/\//i.test(storedUrl) ? storedUrl : hostPrUrl(repoWeb(review.provider, review.hostWebUrl, githubUrl), review.repoFullName, review.prNumber);

  const fixAll = review.findings.total > 0 ? <FixAllMenu reviewId={review.id} /> : null;
  const actions = trigger ? (
    <div className="row-tight">
      {fixAll}
      {active && latest && (
        <form action={cancelReviewRun}>
          <input type="hidden" name="runId" value={latest.id} />
          <input type="hidden" name="reviewId" value={review.id} />
          <SubmitButton size="sm" variant="danger" icon="stop" disabled={latest.cancelRequested}>
            {latest.cancelRequested ? "Cancelling…" : "Cancel run"}
          </SubmitButton>
        </form>
      )}
      <details className="menu popover">
        <summary className="button button-sm">
          <Icon name="refresh" size={14} /> Re-review <Icon name="chevron-down" size={14} />
        </summary>
        <form action={rerunReview} className="menu-panel stack-sm" data-align="end" style={{ padding: 12, minWidth: 260 }} aria-label="Re-review options">
          <input type="hidden" name="reviewId" value={review.id} />
          <div className="field">
            <label className="field-label" htmlFor="rr-mode">
              Mode
            </label>
            <select id="rr-mode" name="mode" className="select" defaultValue={review.mode}>
              {REVIEW_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" name="focus" value="security" />
            <span>Security focus</span>
          </label>
          <label className="check">
            <input type="checkbox" name="full" value="true" />
            <span>Full review (ignore earlier runs)</span>
          </label>
          <SubmitButton variant="primary" size="sm" pendingLabel="Queuing…">
            Queue re-review
          </SubmitButton>
        </form>
      </details>
    </div>
  ) : (
    fixAll ?? undefined
  );

  return (
    <>
      <AutoRefresh active={active} />
      <PageHeader
        breadcrumbs={[{ label: "Reviews", href: "/dashboard/reviews" }, { label: `${review.repoFullName}#${review.prNumber}` }]}
        title={
          <>
            {review.prTitle || `Pull request #${review.prNumber}`} <span className="dim" style={{ fontSize: "0.7em", fontWeight: 500 }}>#{review.prNumber}</span>
          </>
        }
        meta={
          <>
            <StatusPill kind="review" value={review.status} />
            <span className="dim">
              {review.repoFullName}
              {review.prAuthor && <> · @{review.prAuthor}</>}
              {review.pullRequest && (
                <>
                  {" "}
                  · <span className="mono">{review.pullRequest.headRef}</span> → <span className="mono">{review.pullRequest.baseRef}</span>
                  {review.pullRequest.draft ? " · draft" : ""} · {review.pullRequest.state}
                </>
              )}
            </span>
            <a href={prUrl} rel="noreferrer" target="_blank">
              Open on {PROVIDER_LABEL[review.provider] ?? review.provider} <Icon name="external" size={12} />
            </a>
          </>
        }
      />
      {review.pullRequest?.body && (
        <details className="disclosure">
          <summary>Pull request description</summary>
          <div className="disclosure-body">
            <Markdown source={review.pullRequest.body.slice(0, 20_000)} />
          </div>
        </details>
      )}
      <ReviewDetailView
        review={review}
        actions={actions}
        githubUrl={githubUrl}
        runId={shownRun}
        findingActions={(f) => {
          const view = feedback.get(f.id);
          return view ? (
            <FindingFeedback
              findingId={f.id}
              status={f.status}
              view={view}
              canGive={can(role, "findings.feedback")}
              showStatus={false}
              actions={{ give: giveFindingFeedback, retract: retractFindingFeedback }}
            />
          ) : null;
        }}
      />
    </>
  );
}
