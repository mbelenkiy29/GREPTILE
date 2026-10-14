import {repositoryDisplay,providerDisplay} from "../../../src/provider-display";
import Link from "next/link";
import { ReviewMarkdown } from "../markdown";
import { ScrollTable } from "../scroll-table";
import { ReviewError } from "../review-error";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { backend, current } from "../../../src/server";
import { MermaidDiagram } from "../mermaid";
import { lockableKeys } from "../../../src/review-settings";
import { fixPrompt } from "../../../src/fix-prompt";
import { findingSchema } from "../../../src/engine/types";
import {
  cancelReview,
  retryP4Answer,
  configureRepository,
  createWorkspace,
  feedback,
  invite,
  updateMember,
  logout,
  reindex,
  saveRule,
  saveSettings,
  revokeApiKey,
  switchWorkspace,
  switchTeam,
  reviewAgain,
} from "../actions";
import { ApiKeyForm } from "../api-key";
import {SummarySettings} from "../summary-settings";
import { Live, Copy } from "../live";
import { FixButton } from "../fix-button";
import { PullList } from "../pulls";
import { ProvidersPanel } from "../providers";
import { IntegrationsPanel } from "../integrations";
import {PreferencesPanel} from "../preferences";
import { ScopePanel, AuditPanel } from "../scopes";
import { AgentSettings } from "../agents";
import { Onboarding } from "../onboarding";
import { RuntimeSettings,RuntimeReview,ApprovalReview } from "../runtime";
import { PortalNav, AnalyticsView, settingsNavigation } from "../portal";
import { WorkspaceInvitations } from "../invitations";
import { InvitationForm } from "../invitation-form";
import { knowledgeView } from "../../../src/knowledge-view";

const navigation = [
  "Overview",
  "Repositories",
  "Reviews",
  "Findings",
  "Knowledge",
  "Rules",
  "Team",
  "Usage",
  "Settings",
];
const when = (value: number) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }) + " UTC";
const status = (value: string) => (
  <span className={`badge ${value}`}>{value.replaceAll("_", " ")}</span>
);
export default async function Dashboard({
  params,
  searchParams,
}: {
  params: Promise<{ section?: string[] }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { section = [] } = await params,
    user = await current(),
    jar = await cookies();
  const organization =
    user.organizations.find(
      (o) => o._id === jar.get("openreview_workspace")?.value,
    ) ?? user.organizations[0];
  const filters = await searchParams;
  const aliases: Record<string, string[]> = { overview: ["analytics"], repositories: ["settings", "repositories"], reviews: ["pulls"], findings: ["pulls", "findings"], knowledge: ["memory", "knowledge"], rules: ["memory", "rules"], team: ["settings", "people"], usage: ["settings", "usage"] };
  if (!section[0] || aliases[section[0]]) {
    const parts = aliases[section[0] ?? "overview"];
    const suffix = section.slice(1);
    const query = new URLSearchParams(Object.entries(filters).filter((e): e is [string,string] => e[1] !== undefined));
    redirect(`/dashboard/${[...parts, ...suffix].join("/")}${query.size ? `?${query}` : ""}`);
  }
  const route = section[0];
  if(route === "settings" && !section[1]) {
    const query = new URLSearchParams(Object.entries(filters).filter((e): e is [string,string] => e[1] !== undefined));
    redirect(`/dashboard/settings/${filters.repository ? "review" : "repositories"}${query.size ? "?"+query : ""}`);
  }
  if(route === "settings" && !settingsNavigation.some(([key])=>key === section[1]))notFound();
  const view = ["analytics","onboarding"].includes(route) ? "overview" : route === "pulls" ? section[1] === "findings" ? "findings" : "reviews" : route === "memory" ? section[1] === "knowledge" ? "knowledge" : "rules" : route === "settings" ? ({ repositories: "repositories", people: "team", usage: "usage" }[section[1] ?? ""] ?? "settings") : route;
  const reviewDetailId = route === "pulls" && section[1] !== "findings" ? section[1] : undefined;
  const requestedRepository = filters.repository;
  if (!navigation.some((n) => n.toLowerCase() === view)) notFound();
  if (!organization?._id)
    return (
      <main className="onboarding">
        <div className="brand">
          <span className="mark">⌘</span> OpenReview
        </div>
        <h1>Create your workspace</h1>
        <p>
          Your workspace owns repositories, rules, review history, and team
          access.
        </p>
        <form action={createWorkspace}>
          <label>
            Workspace name
            <input name="name" required maxLength={100} autoFocus />
          </label>
          <button className="primary">Create workspace</button>
        </form>
        <WorkspaceInvitations invitations={user.invitations}/>
      </main>
    );
  const scopes=await backend().query(api.scopes.list,{token:user.token,organizationId:organization._id});
  const savedTeam=jar.get("openreview_team")?.value;
  const selectedTeam=scopes.teams.find(t=>t._id===(filters.team??savedTeam));
  if(filters.team&&!selectedTeam)notFound();
  if(selectedTeam)filters.team=selectedTeam._id;
  const data = await backend().query(api.dashboard.overview, {
    token: user.token,
    organizationId: organization._id,
    ...(selectedTeam?{teamId:selectedTeam._id}:{}),
  });
  const findingsPage =
    view === "findings"
      ? await backend().query(api.findings.list, {
          token: user.token,
          organizationId: organization._id,
          cursor: filters.cursor,
          ...(selectedTeam?{teamId:selectedTeam._id}:{}),
          ...(filters.repository
            ? { repositoryId: filters.repository as Id<"repositories"> }
            : {}),
          severity: filters.severity || undefined,
          category: filters.category || undefined,
          status: filters.status || undefined,
          author: filters.author || undefined,
          usefulness: filters.usefulness || undefined,
          since:
            filters.since && Number.isFinite(Date.parse(filters.since))
              ? Date.parse(filters.since)
              : undefined,
        })
      : null;
  const visibleFindings = findingsPage?.page ?? data.findings.map(f=>({...f,canFix:false}));
  const ruleView=view==="rules"&&!["clusters","integrations","preferences"].includes(section[1]??"");
  if(ruleView&&requestedRepository&&!data.repositories.some(r=>r._id===requestedRepository))notFound();
  const rulesPage=ruleView?await backend().query(api.dashboard.rulesPage,{token:user.token,organizationId:organization._id,
    ...(selectedTeam?{teamId:selectedTeam._id}:{}),...(requestedRepository?{repositoryId:requestedRepository as Id<"repositories">}:{}),cursor:filters.cursor}):null;
  const visibleRules=rulesPage?.page??data.rules;
  const repoName = (id: string) =>
    data.repositories.find((r) => r._id === id)?.fullName ?? id;
  const repoLabel = (id: string) => repositoryDisplay(data.repositories.find(r => r._id === id));
  const isAdmin = ["owner", "admin"].includes(organization.role);
  const pendingInvitations = view === "team" && isAdmin
    ? await backend().query(api.users.invitations,{token:user.token,organizationId:organization._id}) : [];
  let active =
    data.repositories.some(
      (r) =>
        ["queued","indexing"].includes(r.indexStatus) ||
        ["queued", "generating"].includes(r.knowledgeStatus ?? ""),
    ) ||
    data.reviews.some(
      (r) => !["completed", "failed", "cancelled"].includes(r.status),
    );
  let detail = null;
  if (view === "reviews" && reviewDetailId)
    detail = await backend().query(api.reviews.detail, {
      token: user.token,
      reviewId: reviewDetailId as Id<"reviews">,
      historyCursor: filters.historyCursor,
    });
  if(detail&&!['completed','failed','cancelled'].includes(detail.review.status))active=true;
  const diagnostics=detail?.review.resultStorageId?await backend().action(api.jobs.diagnostics,{token:user.token,reviewId:detail.review._id}):null;
  const personalAgent=(await backend().query(api.bridge.personal,{token:user.token,organizationId:detail?.review.organizationId??organization._id})).agent;
  if(view === "knowledge" && requestedRepository && !data.repositories.some(r=>r._id===requestedRepository))notFound();
  const knowledgeState = await knowledgeView(view === "knowledge" ? data.repositories : [],
    { team: filters.team, repository: requestedRepository, q: filters.q },
    (r, search) => backend().query(api.dashboard.knowledge, {
      token: user.token, repositoryId: r._id, search,
    }));
  const knowledge = knowledgeState.results;
  const apiKeys =
    route === "settings" && section[1] === "keys" && isAdmin
      ? await backend().query(api.apiKeys.list, {
          token: user.token,
          organizationId: organization._id,
        })
      : [];
  if(route === "settings" && section[1] === "review" && requestedRepository && !data.repositories.some(r=>r._id===requestedRepository))notFound();
  const repoSettings =
    route === "settings" && section[1] === "review" && requestedRepository
      ? await backend().query(api.settings.repository, {
          token: user.token,
          repositoryId: requestedRepository as Id<"repositories">,
        })
      : null;
  const semantic = repoSettings ? await backend().query(api.embeddings.status, { token: user.token, repositoryId: repoSettings.repo._id }) : null;
  return (
    <div className="shell">
      <PortalNav organization={(organization.name ?? "Workspace")+(selectedTeam?" / "+selectedTeam.name:"")} login={user.user.login} route={route} section={section[1]} team={filters.team} scopeSelector={<><form action={switchWorkspace}><label className="sr-only" htmlFor="workspace">Workspace</label><select key={organization._id} id="workspace" name="organizationId" defaultValue={organization._id}>{user.organizations.map(o => <option key={o._id} value={o._id}>{o.name}</option>)}</select><button className="small">Switch workspace</button></form><form action={switchTeam}><label htmlFor="scope-team">Team</label><select key={organization._id+":"+(selectedTeam?._id??"")} id="scope-team" name="teamId" defaultValue={selectedTeam?._id??""}><option value="">All accessible teams</option>{scopes.teams.map(t=><option key={t._id} value={t._id}>{t.name}</option>)}</select><input type="hidden" name="returnTo" value={"/dashboard/"+(reviewDetailId?"pulls":section.join("/"))}/><button className="small">Apply team</button></form><p className="muted">Team selection filters repository activity. Workspace administration applies across the workspace.</p><form action={createWorkspace}><label>New workspace name<input name="name" required maxLength={100}/></label><button>Create workspace</button></form></>}>
        <form action={logout}><button className="small">Sign out</button></form>
      </PortalNav>
      <main className="content">
        <header>
          <div>
            <p className="muted">{organization.name}{selectedTeam&&" / "+selectedTeam.name}</p>
            <h1>{route === "onboarding" ? "Workspace setup" : view === "overview" ? "Analytics" : view === "reviews" ? "Pull Requests" : route === "memory" ? ({clusters:"Cross-repository context",preferences:"Learned preferences",integrations:"Integrations",rules:"Custom rules",knowledge:"Knowledge Base"}[section[1]??"rules"]??"Memory") : route === "settings" ? settingsNavigation.find(([key])=>key===section[1])?.[1] : navigation.find((n) => n.toLowerCase() === view)}</h1>
          </div>
          <Live active={active} />
        </header>
        <WorkspaceInvitations invitations={user.invitations}/>
        {savedTeam&&!selectedTeam&&filters.team===undefined&&<p role="status">Your previously selected team is no longer accessible. Showing all accessible repositories; use the workspace menu to select a team.</p>}
        {route === "onboarding" && <Onboarding token={user.token} organizationId={organization._id} admin={isAdmin} />}
        {view === "overview" && route !== "onboarding" && <AnalyticsView token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters} />}
        {view === "repositories" && (
          <>
            <div className="toolbar">
              <p>
                Enable a repository to build its codebase context and review new
                pull requests.
              </p>
              {isAdmin && (
                <a
                  className="button primary"
                  href={`/api/github/install?organization=${organization._id}`}
                >
                  Connect GitHub App
                </a>
              )}
            </div>
            {!data.repositories.length && (
              <Empty
                title="No repositories connected"
                text="Install the GitHub App above. Choose access to specific repositories in GitHub."
              />
            )}
            {data.repositories.map((r) => (
              <section className="repository" key={r._id}>
                <div className="row">
                  <div>
                    <h2>{r.fullName}</h2>
                    <p className="muted repository-identity">{providerDisplay(r.provider)}</p>
                    <p className="muted">
                      {r.defaultBranch}{" "}
                      {r.indexedSha && <> · <code>{r.indexedSha}</code></>}{" "}
                      {r.indexedAt && ` · ${when(r.indexedAt)}`}
                    </p>
                  </div>
                  {status(r.indexStatus)}
                </div>
                {r.indexStatus === "ready" && (
                  <p>
                    Ready for review. Open a change in your connected code provider
                    or select an existing change from Pull Requests to request a review.
                  </p>
                )}
                {data.indexJobs
                  .filter((j) => j?.repositoryId === r._id)
                  .map(
                    (j) =>
                      j && (
                        <div key={j._id}>
                          <p className="muted">
                            Processed {j.processed} of {j.total} eligible files · Attempt{" "}
                            {j.attempts}
                          </p>
                          {!!j.skippedTotal && <details><summary>{j.skippedTotal} skipped files</summary><ul>{j.skipped?.map(f=><li key={f.path}><code>{f.path}</code> — {f.reason}</li>)}</ul>{j.skippedTotal > (j.skipped?.length??0) && <p>Showing the first {j.skipped?.length??0} exclusions.</p>}</details>}
                          <progress
                            aria-label={`Indexing ${r.fullName}`}
                            value={j.processed}
                            max={Math.max(1, j.total)}
                          />
                        </div>
                      ),
                  )}
                {r.error && (
                  <p role="alert" className="error">
                    {r.error}
                  </p>
                )}
                {r.knowledgeStatus && (
                  <p className="muted">Knowledge: {r.knowledgeStatus}</p>
                )}
                {r.branches && (
                  <details>
                    <summary>
                      Branches ({r.branches.length}
                      {r.branchesLimited ? "+" : ""})
                    </summary>
                    <ul>
                      {r.branches.map((branch) => (
                        <li key={branch.name}>
                          {branch.name} · {branch.sha.slice(0, 8)}
                          {branch.protected ? " · Protected" : ""}
                        </li>
                      ))}
                    </ul>
                    {r.branchesLimited && (
                      <p className="muted">
                        Showing the first 200 branches. Reviews use the exact PR
                        head commit.
                      </p>
                    )}
                  </details>
                )}
                {r.knowledgeError && (
                  <p role="alert" className="error">
                    Knowledge generation: {r.knowledgeError}
                  </p>
                )}
                <div className="toolbar">
                  {isAdmin && (
                    <>
                      <form action={configureRepository}>
                        <input
                          type="hidden"
                          name="repositoryId"
                          value={r._id}
                        />
                        <input
                          type="hidden"
                          name="enabled"
                          value={String(!r.enabled)}
                        />
                        <button disabled={r.indexStatus === "unavailable"} className={r.enabled ? "" : "primary"}>
                          {r.indexStatus === "unavailable" ? "Indexing unavailable" : r.enabled ? "Disable reviews" : "Enable and index"}
                        </button>
                      </form>
                      <form action={reindex}>
                        <input
                          type="hidden"
                          name="repositoryId"
                          value={r._id}
                        />
                        <button disabled={r.indexStatus === "unavailable"}>Re-index changed files</button>
                      </form>
                      <Link
                        className="button"
                        href={`/dashboard/settings/review?repository=${r._id}`}
                      >
                        Review settings
                      </Link>
                    </>
                  )}
                  <Link href={`/dashboard/memory/knowledge?repository=${r._id}`}>Browse knowledge</Link>
                </div>
              </section>
            ))}
          </>
        )}
        {view === "reviews" &&
          (detail ? (
            <>
              <div className="row">
                <h2>
                  {repoName(detail.review.repositoryId)} #
                  {detail.review.prNumber}
                </h2>
                {status(detail.review.status)}
              </div>
              <p className="muted repository-identity">{repoLabel(detail.review.repositoryId)}</p>
              <p className="muted">
                Reviewed revision {detail.review.headSha} · {when(detail.review.createdAt)}
              </p>
              {detail.latestReviewId && detail.latestReviewId !== detail.review._id && (
                <p role="status">
                  You’re viewing a historical review.{" "}
                  <Link href={`/dashboard/pulls/${detail.latestReviewId}`}>View latest review</Link>
                </p>
              )}
              <p>
                {detail.review.title ?? "Awaiting PR ingestion"} · @
                {detail.review.author ?? "unknown"}
                {detail.review.prUrl && (
                  <>
                    {" "}
                    · <a href={detail.review.prUrl}>View pull request</a>
                  </>
                )}
              </p>
              {detail.review.headBranch && (
                <p className="muted">
                  {detail.review.headBranch} → {detail.review.baseBranch}
                </p>
              )}
              <p className="muted">
                Started {when(detail.review.createdAt)} · {detail.review.status === "cancelled" ? "Cancelled" : "Finished"}{" "}
                {detail.review.finishedAt
                  ? when(detail.review.finishedAt)
                  : ["completed","failed","cancelled"].includes(detail.review.status) ? "Time not recorded" : "In progress"}{" "}
                · Models: {detail.review.models || [...new Set(detail.modelCalls.map(call => call.model))].join(", ") || "Not called yet"}
              </p>
              {detail.review.error && (
                <ReviewError error={detail.review.error} alert/>
              )}
              {detail.retryPending&&<p role="status">Retry {detail.review.retryAt ? "scheduled for "+when(detail.review.retryAt) : "pending"}. The review will update automatically.</p>}
              <RuntimeReview token={user.token} reviewId={detail.review._id} evidence={detail.review.runtimeEvidence}/>{detail.review.nativeP4?<p>Automatic approval is not available for Perforce reviews.</p>:<ApprovalReview token={user.token} reviewId={detail.review._id}/>}
              <section aria-label="Confidence score">
                <h2>Confidence score</h2>
                {detail.review.reviewScore ? <><p><strong>{detail.review.reviewScore.value}/5</strong> · confidence that the change is safe to merge</p><p>{detail.review.reviewScore.reason}</p></> : <p className="muted">Not recorded for this review.</p>}
              </section>
              {detail.review.approvalAssessment && (
                <section>
                  <h2>Approval assessment</h2>
                  <p>Risk: {detail.review.approvalAssessment.risk} · Confidence: {Math.round(detail.review.approvalAssessment.confidence*100)}%</p>
                  <p>{detail.review.approvalAssessment.reason}</p>
                  <p className="muted">Approval requires the configured policy and current provider checks.</p>
                  {detail.review.coverageLimits?.map(limit=><p key={limit}>{limit}</p>)}
                </section>
              )}
              <section aria-label="Review history">
                <h2>Review history</h2>
                <ol className="timeline">
                  {detail.history.page.map(r => <li key={r._id}>
                    <Link href={`/dashboard/pulls/${r._id}`} aria-current={r._id === detail.review._id ? "page" : undefined}>
                      {when(r.createdAt)} · {r.headSha} · {r.status.replaceAll("_", " ")}
                    </Link>
                    <span>{r.findingCount ?? "Pending"} findings · Score {r.reviewScore ? `${r.reviewScore.value}/5` : "not recorded"}</span>
                  </li>)}
                </ol>
                {!detail.history.isDone && <Link href={`/dashboard/pulls/${detail.review._id}?historyCursor=${encodeURIComponent(detail.history.continueCursor)}`}>Older reviews</Link>}
                {filters.historyCursor && <Link href={`/dashboard/pulls/${detail.review._id}`}>Latest reviews</Link>}
              </section>
              <section>
                <h2>Processing lifecycle</h2>
                <ol className="timeline">
                  {detail.runs.map((r) => (
                    <li key={r._id}>
                      <strong>{r.stage.replaceAll("_", " ")}</strong>
                      <span>
                        {when(r.createdAt)} {r.detail}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
              {!["completed", "failed", "cancelled"].includes(
                detail.review.status,
              ) && (
                <form action={cancelReview}>
                  <input
                    type="hidden"
                    name="reviewId"
                    value={detail.review._id}
                  />
                  <button>Cancel review</button>
                </form>
              )}
              <section>
                <div className="row"><h2>Review summary</h2>{detail.review.nativeP4&&isAdmin&&detail.review.status==="failed"&&detail.review.resultStorageId&&<form action={reviewAgain}><input type="hidden" name="reviewId" value={detail.review._id}/><input type="hidden" name="fresh" value="true"/><button>Re-review current shelf</button></form>}{(!detail.review.nativeP4||isAdmin)&&<form action={reviewAgain}><input type="hidden" name="reviewId" value={detail.review._id}/><button>{detail.review.nativeP4?(detail.review.status==="failed"&&detail.review.resultStorageId?"Retry saved publication":"Re-review current shelf"):"Re-review current PR"}</button></form>}</div>
                <ReviewMarkdown>
                  {detail.review.summary ??
                    (detail.review.status === "failed" ? "No summary was generated. Review the error above before retrying." : detail.review.status === "cancelled" ? "This review was cancelled before a summary was generated." : "The summary will appear when analysis finishes.")}
                </ReviewMarkdown>
              </section>
              {detail.review.nativeP4&&<section aria-label="Native follow-up answers"><h2>Native follow-up answers</h2><p>Questions mentioning @openreview are discovered while native polling is enabled. Authors must link their native identity in Personal agents. Answers use the permitted sources of each author; they do not resolve findings or establish test execution.</p>{!detail.nativeConversations.length&&<p>No native questions recorded for this review.</p>}{detail.nativeConversations.map(answer=><article key={answer.id}><p><strong>@{answer.author}</strong> · {answer.status} · {answer.attempts} {answer.attempts===1?"attempt":"attempts"} · {when(answer.updatedAt)}</p><p>{answer.question}</p>{answer.error&&<p role="alert">{answer.error}</p>}{answer.answer&&<details><summary>{answer.status==="completed"?"Published answer":"Saved answer; publication not complete"}</summary><ReviewMarkdown>{answer.answer}</ReviewMarkdown></details>}{answer.replyId&&<p>Native reply #{answer.replyId}</p>}{answer.command?.requestedReviewId&&<p><a href={"/dashboard/pulls/"+answer.command.requestedReviewId}>View requested re-review</a></p>}{answer.canRetry&&<form action={retryP4Answer}><input type="hidden" name="conversationId" value={answer.id}/><button>Retry native answer</button></form>}</article>)}{detail.nativeConversationsTruncated&&<p className="muted">Showing the latest 20 native questions.</p>}</section>}
              {diagnostics&&diagnostics.diagrams.length>0&&<section aria-label="Sequence diagram"><h2>Sequence diagram</h2><MermaidDiagram code={diagnostics.diagrams[0]}/></section>}
              {diagnostics&&<section aria-label="Review diagnostics"><h2>Review diagnostics</h2>{diagnostics.coverageLimits.map(limit=><p key={limit}>{limit}</p>)}{diagnostics.failedSpecialists.length>0&&<><h3>Failed specialists</h3><ul>{diagnostics.failedSpecialists.map(f=><li key={f.category}><strong>{f.category}</strong><p>{f.error}</p></li>)}</ul></>}{diagnostics.skippedFiles.length>0&&<><h3>Skipped files</h3><ul aria-label="Skipped files">{diagnostics.skippedFiles.slice(0,200).map((f,i)=><li key={i}><code>{f.path}</code> · {f.reason}</li>)}</ul>{diagnostics.skippedFiles.length>200&&<p>{diagnostics.skippedFiles.length-200} more skipped files not shown.</p>}</>}<h3>Suppressed candidates</h3>{diagnostics.suppressions.length?<ul>{diagnostics.suppressions.map((s,i)=><li key={i}><strong>{s.title}</strong> · {s.agent}<p>{s.reason}</p></li>)}</ul>:<p>No suppressed candidates.</p>}</section>}
              {!detail.historicalFindingsAvailable && detail.review.resultStorageId && <p role="status">Historical finding snapshots are unavailable for this review. An administrator can recover them from the saved review result.</p>}
              {detail.findings.length > 0 && (
                <section>
                  <h2>Verified findings</h2>
                  {detail.canFix && <FixButton reviewId={detail.review._id} agent={personalAgent} label="Fix All" />}
                  {detail.canFix && <Copy
                    value={fixPrompt(
                      repoName(detail.review.repositoryId),
                      `PR #${detail.review.prNumber}`,
                      detail.findings
                        .filter(
                          (finding) =>
                            finding.canFix,
                        )
                        .map((finding) => ({
                          ...findingSchema.parse(finding),
                          agent: finding.agent,
                          fingerprint: finding.fingerprint,
                          commitSha: finding.commitSha,
                        })),
                      detail.review.runtimeEvidence,
                    )}
                    label="Copy Fix All prompt"
                  />}
                  {detail.findings.map((finding) => (
                    <article key={finding._id}>
                      <h3>
                        {status(finding.severity)} {finding.title}
                      </h3>
                      <p>
                        {finding.filePath}:{finding.startLine} ·{" "}
                        {Math.round(finding.confidence * 100)}% confidence ·{" "}
                        Verified at this revision · Current status: {finding.currentStatus}
                      </p>
                      <p>{finding.description}</p>
                      <p>Impact: {finding.impact}</p>
                      {finding.evidence.map((e, index) => (
                        <div key={index}>{e.sourceUrl&&<a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.repository} · {e.revision?.slice(0,8)} · source</a>}<pre>{e.filePath}:{e.startLine}{"\n"}{e.quote}</pre></div>
                      ))}
                      <p>Suggested fix: {finding.suggestedFix}</p>
                      {finding.canFix && <FixButton reviewId={detail.review._id} agent={personalAgent} findingId={finding._id} />}
                    </article>
                  ))}
                </section>
              )}
              <h2>Model calls</h2>
              <ScrollTable label="Model calls table">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Model</th>
                      <th>Tokens</th>
                      <th>Duration</th>
                      <th>Cost</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.modelCalls.map((c) => (
                      <tr key={c._id}>
                        <td>{c.task}</td>
                        <td>{c.model}</td>
                        <td>{c.inputTokens + c.outputTokens}</td>
                        <td>{(c.latencyMs / 1000).toFixed(1)}s</td>
                        <td>${c.estimatedCost.toFixed(4)}</td>
                        <td>
                          {c.error ? <ReviewError error={c.error}/> : c.cached ? "Cached" : "Completed"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            </>
          ) : (
            <>
              <PullList admin={isAdmin} token={user.token} organizationId={organization._id} repositories={data.repositories} filters={filters} />
            </>
          ))}
        {view === "findings" && (
          <>
            <form method="get" className="toolbar">
              {filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}
              <label>
                Repository
                <select
                  name="repository"
                  defaultValue={filters.repository ?? ""}
                >
                  <option value="">All repositories</option>
                  {data.repositories.map((r) => (
                    <option key={r._id} value={r._id}>
                      {repositoryDisplay(r)}
                    </option>
                  ))}
                </select>
              </label>
              {[
                ["severity", ["critical", "high", "medium", "low"]],
                [
                  "category",
                  [
                    "correctness",
                    "security",
                    "data",
                    "compatibility",
                    "testing",
                    "performance",
                    "rules",
                  ],
                ],
                ["status", ["open", "resolved", "wont_fix", "false_positive"]],
                ["usefulness", ["useful", "not_useful", "false_positive"]],
              ].map(([key, options]) => (
                <label key={String(key)}>
                  {String(key)}
                  <select
                    name={String(key)}
                    defaultValue={filters[String(key)] ?? ""}
                  >
                    <option value="">All</option>
                    {(options as string[]).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                PR author
                <input name="author" defaultValue={filters.author ?? ""} />
              </label>
              <label>
                Since
                <input
                  name="since"
                  type="date"
                  defaultValue={filters.since ?? ""}
                />
              </label>
              <button>Filter findings</button>
              <Link href="/dashboard/findings">Reset filters</Link>
            </form>
            {!visibleFindings.length && (
              <Empty
                title="No findings yet"
                text="Open a pull request in an enabled repository. Verified findings will appear here."
              />
            )}
            {visibleFindings.some((f) => f.canFix) && (
              <Copy
                label="Copy eligible tasks on this page"
                value={visibleFindings
                    .filter((f) => f.canFix)
                    .map((f) => fixPrompt(repoName(f.repositoryId), `PR #${f.prNumber}`, [{
                      ...findingSchema.parse(f),
                      agent: f.agent,
                      fingerprint: f.fingerprint,
                      commitSha: f.commitSha,
                    }]))
                    .join("\n\n--- Next finding task: use its named repository, PR and revision ---\n\n")}
              />
            )}
            {visibleFindings.map((f) => {
              const prompt = fixPrompt(
                repoName(f.repositoryId),
                `PR #${f.prNumber}`,
                [
                  {
                    ...findingSchema.parse(f),
                    agent: f.agent,
                    fingerprint: f.fingerprint,
                    commitSha: f.commitSha,
                  },
                ],
              );
              return (
                <section className="finding" key={f._id}>
                  <div className="row">
                    <h2>{f.title}</h2>
                    <div>
                      {status(f.severity)} {status(f.status)}
                    </div>
                  </div>
                  <p className="muted">
                    {repoName(f.repositoryId)} #{f.prNumber} · {f.filePath}:
                    {f.startLine} · {Math.round(f.confidence * 100)}% confidence
                  </p>
                  <p>{f.description}</p>
                  {f.ruleId && (
                    <p className="muted">
                      Rule:{" "}
                      {data.rules.find((rule) => rule._id === f.ruleId)
                        ?.title ?? f.ruleId}
                    </p>
                  )}
                  <p>
                    <strong>Impact:</strong> {f.impact}
                  </p>
                  {f.evidence.map((e, i) => (
                    <div key={i}>
                      {e.sourceUrl&&<a href={e.sourceUrl} target="_blank" rel="noreferrer">{e.repository} · {e.revision?.slice(0,8)} · source</a>}
                      <p className="muted">
                        {e.filePath}:{e.startLine}
                      </p>
                      <pre>
                        <code>{e.quote}</code>
                      </pre>
                    </div>
                  ))}
                  <p>
                    <strong>Suggested fix:</strong> {f.suggestedFix}
                  </p>
                  {f.canFix && <FixButton reviewId={f.reviewId} agent={personalAgent} findingId={f._id} />}
                  {f.status === "open" && !f.canFix && data.writableRepositoryIds.includes(f.repositoryId) && <p className="muted">Fix requires this finding to belong to the latest completed review, meet the current confidence threshold, and have current repository access.</p>}
                  <Copy value={prompt} />
                  <details>
                    <summary>
                      Portable prompt for Codex, Claude Code, or Cursor
                    </summary>
                    <pre>{prompt}</pre>
                  </details>
                  {data.writableRepositoryIds.includes(f.repositoryId) && <form action={feedback} className="feedback">
                    <input type="hidden" name="findingId" value={f._id} />
                    <label>
                      Feedback
                      <select name="value">
                        <option value="useful">Useful</option>
                        <option value="not_useful">Not useful</option>
                        <option value="resolved">Resolved</option>
                        <option value="wont_fix">Won’t fix</option>
                        <option value="false_positive">False positive</option>
                      </select>
                    </label>
                    <label>
                      Reason
                      <input name="comment" maxLength={5000} />
                    </label>
                    <button>Save feedback</button>
                  </form>}
                </section>
              );
            })}
            {findingsPage && !findingsPage.isDone && (
              <Link
                className="button"
                href={`/dashboard/findings?${new URLSearchParams(Object.entries({ ...filters, cursor: findingsPage.continueCursor }).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString()}`}
              >
                Next findings
              </Link>
            )}
          </>
        )}
        {view === "rules" && !["clusters","integrations","preferences"].includes(section[1] ?? "") && (
          <>
            <form className="toolbar" method="get" action="/dashboard/memory/rules">
              {selectedTeam&&<input type="hidden" name="team" value={selectedTeam._id}/>}
              <label>Rules for repository<select name="repository" defaultValue={requestedRepository??""}>
                <option value="">All accessible repositories</option>
                {data.repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}
              </select></label><button>Apply filter</button>
            </form>
            {requestedRepository&&<p>Workspace rules are inherited by this repository. Disabled rules remain visible for management but do not run in reviews.</p>}
            {isAdmin && (
              <section>
                <h2>Add a review rule</h2>
                <form action={saveRule} className="form-grid">
                  <input
                    type="hidden"
                    name="organizationId"
                    value={organization._id}
                  />
                  <label>
                    Title
                    <input name="title" required />
                  </label>
                  <label>
                    Repository scope
                    <select name="repositoryId" defaultValue={requestedRepository??""}>
                      <option value="">Entire workspace</option>
                      {data.repositories.map((r) => (
                        <option key={r._id} value={r._id}>
                          {repositoryDisplay(r)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="wide">
                    Instructions
                    <textarea name="instructions" rows={3} required />
                  </label>
                  <label>
                    Severity
                    <select name="severity">
                      <option>medium</option>
                      <option>high</option>
                      <option>critical</option>
                      <option>low</option>
                    </select>
                  </label>
                  <label>
                    File globs (comma separated)
                    <input name="globs" />
                  </label>
                  <button className="primary">Create rule</button>
                </form>
              </section>
            )}
            {!visibleRules.length && (
              <Empty
                title="Your codebase, your conventions"
                text="Add specific rules such as requiring organization membership validation in API endpoints."
              />
            )}
            {visibleRules.map((r) => (
              <section key={r._id}>
                <h2>
                  {r.title} {status(r.enabled ? "enabled" : "disabled")}
                </h2>
                <p>{r.instructions}</p>
                <p className="muted">
                  {r.repositoryId ? repoName(r.repositoryId) : "Workspace"} ·{" "}
                  {r.severity}
                  {!r.repositoryId&&<span className="badge">{requestedRepository?"Inherited from workspace":"Workspace default"}</span>}
                </p>
                {isAdmin && (
                  <details>
                    <summary>Edit rule</summary>
                    <form action={saveRule} className="form-grid" key={JSON.stringify(r)}>
                      <input
                        type="hidden"
                        name="organizationId"
                        value={organization._id}
                      />
                      <input type="hidden" name="id" value={r._id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={String(r.enabled)}
                      />
                      <label>
                        Title
                        <input name="title" required defaultValue={r.title} />
                      </label>
                      <label>
                        Repository scope
                        <select
                          name="repositoryId"
                          defaultValue={r.repositoryId ?? ""}
                        >
                          <option value="">Workspace</option>
                          {data.repositories.map((repo) => (
                            <option key={repo._id} value={repo._id}>
                              {repositoryDisplay(repo)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="wide">
                        Instructions
                        <textarea
                          name="instructions"
                          required
                          defaultValue={r.instructions}
                        />
                      </label>
                      <label>
                        Severity
                        <select name="severity" defaultValue={r.severity}>
                          {["critical", "high", "medium", "low"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Globs
                        <input name="globs" defaultValue={r.globs.join(",")} />
                      </label>
                      <input type="hidden" name="category" value={r.category} />
                      <button>Save rule</button>
                    </form>
                  </details>
                )}
                {isAdmin && (
                  <form action={saveRule}>
                    <input
                      type="hidden"
                      name="organizationId"
                      value={organization._id}
                    />
                    <input type="hidden" name="id" value={r._id} />
                    <input type="hidden" name="title" value={r.title} />
                    <input
                      type="hidden"
                      name="instructions"
                      value={r.instructions}
                    />
                    <input type="hidden" name="severity" value={r.severity} />
                    <input
                      type="hidden"
                      name="repositoryId"
                      value={r.repositoryId ?? ""}
                    />
                    <input
                      type="hidden"
                      name="globs"
                      value={r.globs.join(",")}
                    />
                    <input type="hidden" name="category" value={r.category} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={String(!r.enabled)}
                    />
                    <button>
                      {r.enabled ? "Disable rule" : "Enable rule"}
                    </button>
                    <button name="remove" value="true">
                      Delete rule
                    </button>
                  </form>
                )}
              </section>
            ))}
            {rulesPage&&<nav className="toolbar" aria-label="Rules pagination">
              {filters.cursor&&<Link href={`/dashboard/memory/rules?${new URLSearchParams({...requestedRepository?{repository:requestedRepository}:{},...selectedTeam?{team:selectedTeam._id}:{}})}`}>Newest rules</Link>}
              {!rulesPage.isDone&&<Link href={`/dashboard/memory/rules?${new URLSearchParams({cursor:rulesPage.continueCursor,...requestedRepository?{repository:requestedRepository}:{},...selectedTeam?{team:selectedTeam._id}:{}})}`}>Older rules</Link>}
              <p className="muted">{visibleRules.length} rules on this page{rulesPage.isDone?" · End of rules":""}.</p>
            </nav>}
          </>
        )}
        {view === "team" && (
          <>
            {isAdmin && (
              <form action={invite} className="toolbar">
                <input
                  type="hidden"
                  name="organizationId"
                  value={organization._id}
                />
                <label>
                  GitHub login
                  <input name="login" required />
                </label>
                <label>
                  Role
                  <select name="role">
                    <option>member</option>
                    <option>viewer</option>
                    <option>admin</option>
                  </select>
                </label>
                <button className="primary">Invite member</button>
              </form>
            )}
            {isAdmin&&<section aria-label="Pending invitations"><h2>Pending invitations</h2>{pendingInvitations.length?<ScrollTable label="Pending invitations table"><table><thead><tr><th>GitHub login</th><th>Role</th><th>Expires</th><th>Action</th></tr></thead><tbody>{pendingInvitations.map(i=><tr key={i._id}><td>@{i.githubLogin}</td><td>{i.role}</td><td>{new Date(i.expiresAt).toLocaleString("en-US",{timeZone:"UTC"})} UTC</td><td><InvitationForm id={i._id} label={`Revoke invitation for ${i.githubLogin}`} revoke/></td></tr>)}</tbody></table></ScrollTable>:<p>No pending invitations.</p>}<p className="muted">Invitees see invitations when they sign in with their GitHub identity. Sending a new invitation replaces the previous invitation for that login in this workspace.</p></section>}
            <ScrollTable label="Workspace members table">
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m._id}>
                      <td>@{m.user?.login}</td>
                      <td>
                        {isAdmin ? (
                          <form action={updateMember}>
                            <input
                              type="hidden"
                              name="memberId"
                              value={m._id}
                            />
                            <select
                              name="role"
                              aria-label={`Role for ${m.user?.login}`}
                              defaultValue={m.role}
                            >
                              <option>member</option>
                              <option>viewer</option>
                              <option>admin</option>
                              {organization.role === "owner" && (
                                <option>owner</option>
                              )}
                            </select>
                            <button>Save role</button>
                            <button name="remove" value="true">
                              Remove member
                            </button>
                          </form>
                        ) : (
                          m.role
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollTable>
          </>
        )}
        {view === "knowledge" && (
          <>
            <form className="filter-bar">
              {filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}
              <label>Repository<select name="repository" defaultValue={requestedRepository??""}><option value="">All accessible repositories</option>{data.repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select></label>
              <label>Search knowledge<input name="q" defaultValue={filters.q} maxLength={200}/></label>
              <button>Apply</button>
            </form>
            {knowledgeState.searchError && <p role="alert">Search must contain at most 200 characters. Shorten it and apply the filters again.</p>}
            {!knowledgeState.searchError && <p className="muted">{knowledgeState.count} matching entries{knowledgeState.incomplete ? " from repositories successfully loaded · Results are incomplete." : ""} · Search covers subsystems, descriptions, files, dependencies, risks and conventions. Related findings show the latest 100 findings per repository.</p>}
            {knowledge.filter(k=>k.failed).map(k=><section key={k.repo._id}><h2>{k.repo.fullName}</h2><p className="muted repository-identity">{providerDisplay(k.repo.provider)}</p><p role="alert">Knowledge could not be loaded. Retry the request; if access changed, choose an accessible repository.</p><a className="button" href={knowledgeState.retryUrl}>Retry knowledge</a></section>)}
            {knowledgeState.empty && (
              <Empty
                title={filters.q || requestedRepository ? "No matching knowledge" : "Repository knowledge"}
                text={filters.q || requestedRepository ? "Adjust the search or repository filter. Knowledge is generated after repository indexing." : "Codebase knowledge is generated after indexing. Enable a repository to begin."}
              />
            )}
            {knowledge.flatMap((k) =>
              k.entries.map((e) => (
                <section key={e._id}>
                  <p className="muted">
                    {repositoryDisplay(k.repo)} · <code>{e.sha}</code>
                  </p>
                  <h2>{e.subsystem}</h2>
                  <p>{e.description}</p>
                  <p className="muted">
                    Dependencies: {e.dependencies.join(", ") || "None recorded"}{" "}
                    · Risks: {e.risks.join("; ") || "None recorded"}
                  </p>
                  {e.pastFindings.length > 0 && (
                    <ul>
                      {e.pastFindings.map((finding) => (
                        <li key={finding.id}>
                          <Link href={`/dashboard/reviews/${finding.reviewId}`}>
                            {finding.title}
                          </Link>{" "}
                          · PR #{finding.prNumber} · {finding.status}
                        </li>
                      ))}
                    </ul>
                  )}
                  <details>
                    <summary>Related files and conventions</summary>
                    <ul>{e.sources.map(source => <li key={source.path}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.path}</a> : <>{source.path} <span className="muted">· Source link unavailable</span></>}</li>)}</ul>
                    <pre>{e.conventions.join("\n")}</pre>
                  </details>
                </section>
              )),
            )}
          </>
        )}
        {view === "usage" && (
          <>
            <p>
              Workspace cost: $
              {data.usage
                .reduce((sum, event) => sum + event.estimatedCost, 0)
                .toFixed(4)}{" "}
              · Indexing embeddings: $
              {data.usage
                .filter((event) => event.kind === "embedding")
                .reduce((sum, event) => sum + event.estimatedCost, 0)
                .toFixed(4)}
            </p>
            <p>
              Average completed review: $
              {(() => {
                const completed = new Set(
                  data.reviews
                    .filter((review) => review.status === "completed")
                    .map((review) => review._id),
                );
                return completed.size
                  ? (
                      data.usage
                        .filter(
                          (event) =>
                            event.reviewId && completed.has(event.reviewId),
                        )
                        .reduce((sum, event) => sum + event.estimatedCost, 0) /
                      completed.size
                    ).toFixed(4)
                  : "0.0000";
              })()}{" "}
              · Duration:{" "}
              {(() => {
                const completed = data.reviews.filter(
                  (review) =>
                    review.status === "completed" && review.finishedAt,
                );
                return completed.length
                  ? `${Math.round(completed.reduce((sum, review) => sum + (review.finishedAt! - review.createdAt), 0) / completed.length / 1000)} seconds`
                  : "Awaiting reviews";
              })()}
            </p>
            <p>
              Estimated costs use your configured input and output token prices.
              A zero cost means pricing has not been configured or the call was
              cached.
            </p>
            <ScrollTable label="Repository usage table">
              <table>
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Model calls</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Estimated cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.repositories.map((r) => {
                    const usage = data.usage.filter(
                      (u) => u.repositoryId === r._id,
                    );
                    return (
                      <tr key={r._id}>
                        <td>{repositoryDisplay(r)}</td>
                        <td>{usage.length}</td>
                        <td>
                          {usage
                            .reduce((s, u) => s + u.inputTokens, 0)
                            .toLocaleString()}
                        </td>
                        <td>
                          {usage
                            .reduce((s, u) => s + u.outputTokens, 0)
                            .toLocaleString()}
                        </td>
                        <td>
                          $
                          {usage
                            .reduce((s, u) => s + u.estimatedCost, 0)
                            .toFixed(4)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollTable>
            <p className="muted">Most recent 1,000 usage events.</p>
          </>
        )}
        {route === "settings" && section[1] === "agents" && <AgentSettings token={user.token} organizationId={organization._id} />}
        {route === "settings" && section[1] === "automation" && (isAdmin?<RuntimeSettings token={user.token} organizationId={organization._id}/>:<p>Workspace admin access required.</p>)}
        {route === "memory" && section[1] === "preferences" && <PreferencesPanel token={user.token} organizationId={organization._id} repositories={data.repositories} admin={isAdmin} filters={filters}/>}
        {route === "memory" && section[1] === "integrations" && <IntegrationsPanel token={user.token} organizationId={organization._id} admin={isAdmin} repositories={data.repositories} selected={filters.integration} error={filters.error} saved={filters.saved} />}
        {route === "memory" && section[1] === "clusters" && <ScopePanel token={user.token} organizationId={organization._id} admin={isAdmin} clusters />}
        {route === "settings" && section[1] === "teams" && <ScopePanel token={user.token} organizationId={organization._id} admin={isAdmin} />}
        {route === "settings" && section[1] === "audit" && (isAdmin ? <AuditPanel token={user.token} organizationId={organization._id} cursor={filters.activityCursor} /> : <p>Workspace admin access required.</p>)}
        {route === "settings" && section[1] === "providers" && (isAdmin ? <ProvidersPanel token={user.token} organizationId={organization._id} connectionId={filters.connection} projectId={filters.project} after={filters.after} inspect={filters.inspect} /> : <p>Workspace admin access required.</p>)}
        {route === "settings" && ["review","keys"].includes(section[1]) && (
          <>
            {section[1] === "keys" && (isAdmin ? (
              <section>
                <h2>Developer API keys</h2>
                <ApiKeyForm organizationId={organization._id} />
                {apiKeys.map((k) => (
                  <form action={revokeApiKey} key={k._id}>
                    <p>
                      {k.name} · {k.prefix}… ·{" "}
                      {k.revoked ? "Revoked" : "Active"}
                    </p>
                    <input type="hidden" name="keyId" value={k._id} />
                    {!k.revoked && <button>Revoke key</button>}
                  </form>
                ))}
              </section>
            ) : <p>Workspace admin access required.</p>)}
            {section[1] === "review" && <form method="get" className="filter-bar">{filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}<label>Repository<select name="repository" defaultValue={requestedRepository??""} required><option value="" disabled>Choose a repository</option>{data.repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select></label><button>View review settings</button></form>}
            {section[1] === "review" && !repoSettings && <p>Select a repository to inspect its effective review settings. <Link href="/dashboard/settings/teams">Manage workspace and team defaults</Link>.</p>}
            {repoSettings && (
              <section>
                <h2>{repoSettings.repo.fullName}</h2>
                <p className="muted repository-identity">{repoLabel(repoSettings.repo._id)}</p>
                <details className="effective-config"><summary>Effective configuration and sources</summary>
                  {repoSettings.repo.configFile ? <p>Repository config from base revision <code>{repoSettings.repo.configFile.sha.slice(0, 7)}</code>: {repoSettings.repo.configFile.files.map((f) => <code key={f}>{f} </code>)}{repoSettings.repo.configFile.rules ? ` · ${repoSettings.repo.configFile.rules} rules` : ""}</p> : <p className="muted">No <code>.openreview.json</code> or <code>.openreview/</code> configuration was found on a reviewed base branch yet.</p>}
                  {repoSettings.repo.configFile?.warnings.map((w) => <p key={w} className="warning" role="alert">{w}</p>)}
                  <table><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>{lockableKeys.map((key) => {
                    const fromFile = repoSettings.repo.configFile?.applied.includes(key), locked = repoSettings.repo.configFile?.blocked.includes(key);
                    const fileValues = fromFile ? JSON.parse(repoSettings.repo.configFile!.values) as Record<string, unknown> : {};
                    const value = fromFile ? fileValues[key] : (repoSettings.settings as Record<string, unknown>)[key];
                    return <tr key={key}><td>{key}</td><td><code>{JSON.stringify(value ?? null).slice(0, 120)}</code></td><td>{fromFile ? "repository file" : (repoSettings.provenance[key] ?? "default") + ((repoSettings.settings.lockedKeys ?? []).includes(key) ? " · locked" : "") + (locked ? " (file value ignored)" : "")}</td></tr>;
                  })}</tbody></table>
                </details>
                {semantic && <p className="muted" aria-label="Semantic retrieval status">{semantic.configured ? <>Semantic retrieval: <strong>on</strong> · {semantic.model} · {semantic.chunks}{semantic.more ? "+" : ""} chunks across {semantic.files} files{semantic.stale ? ` · ${semantic.stale} chunks from another model are replaced on the next re-index` : ""}{!semantic.chunks ? " · re-index to build chunk embeddings" : ""}</> : <>Semantic retrieval: <strong>off</strong>. Set <code>EMBEDDING_MODEL</code> (an OpenAI-compatible 1,536-dimension endpoint) in the backend environment and re-index; full-text and code-graph retrieval run either way.</>}</p>}
                <form action={saveSettings}><fieldset className="form-grid" disabled={!isAdmin}><legend>Repository review settings</legend>
                  <input
                    type="hidden"
                    name="repositoryId"
                    value={repoSettings.repo._id}
                  />
                  {(["automatic", "drafts", "rereview"] as const).map((key) => (
                    <label key={key}>
                      <span>
                        <input
                          type="checkbox"
                          name={key}
                          defaultChecked={repoSettings.settings[key]}
                        />{" "}
                        {key === "automatic"
                          ? "Automatic reviews (off: only on @openreview review or a trigger label)"
                          : key === "drafts"
                            ? "Review draft PRs"
                            : "Re-review new commits"}
                      </span>
                    </label>
                  ))}
                  {(
                    [
                      "targetBranches",
                      "ignoredBranches",
                      "ignoredPaths",
                    ] as const
                  ).map((key) => (
                    <label key={key}>
                      {key.replace(/([A-Z])/g, " $1")} (comma separated)
                      <input
                        name={key}
                        defaultValue={repoSettings.settings[key].join(", ")}
                      />
                    </label>
                  ))}
                  <label>
                    Maximum comments
                    <input
                      name="maxComments"
                      type="number"
                      min={0}
                      max={30}
                      defaultValue={repoSettings.settings.maxComments}
                    />
                  </label>
                  <label>
                    Minimum confidence
                    <input
                      name="minimumConfidence"
                      type="number"
                      min={0.5}
                      max={1}
                      step={0.01}
                      defaultValue={repoSettings.settings.minimumConfidence}
                    />
                  </label>
                  <label>
                    Severity threshold
                    <select
                      name="severityThreshold"
                      defaultValue={repoSettings.settings.severityThreshold}
                    >
                      {["critical", "high", "medium", "low"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Depth
                    <select
                      name="mode"
                      defaultValue={repoSettings.settings.mode}
                    >
                      {["fast", "standard", "deep"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Review engine
                    <select
                      name="reviewEngine"
                      defaultValue={repoSettings.settings.reviewEngine ?? "pipeline"}
                    >
                      <option value="pipeline">pipeline (specialists)</option>
                      <option value="agentic">agentic (tool-calling, experimental)</option>
                    </select>
                  </label>
                  <label>
                    Strictness
                    <select name="strictness" defaultValue={String(repoSettings.settings.strictness ?? 0)}>
                      <option value="0">custom thresholds</option>
                      <option value="1">1 · fewest, highest-confidence comments</option>
                      <option value="2">2 · balanced</option>
                      <option value="3">3 · most thorough</option>
                    </select>
                  </label>
                  <label>
                    Trigger labels
                    <input name="triggerLabels" placeholder="openreview, needs-review" defaultValue={(repoSettings.settings.triggerLabels ?? []).join(", ")} />
                  </label>
                  <label>
                    Excluded authors (globs)
                    <input name="excludedAuthors" placeholder="dependabot[bot], *-bot" defaultValue={(repoSettings.settings.excludedAuthors ?? []).join(", ")} />
                  </label>
                  <label>
                    Skip automatic reviews above changed files (0 = no limit)
                    <input name="maxFiles" type="number" min={0} defaultValue={repoSettings.settings.maxFiles ?? 0} />
                  </label>
                  <label>
                    Skip automatic reviews above changed lines (0 = no limit)
                    <input name="maxChangedLines" type="number" min={0} defaultValue={repoSettings.settings.maxChangedLines ?? 0} />
                  </label>
                  <fieldset className="wide">
                    <legend>Lock against the repository config file</legend>
                    <input type="hidden" name="lockedConfigured" value="true" />
                    {lockableKeys.map((key) => (
                      <label key={key} className="check"><input type="checkbox" name="lockedKeys" value={key} defaultChecked={(repoSettings.settings.lockedKeys ?? []).includes(key)} /> {key}</label>
                    ))}
                  </fieldset>
                  <label>
                    GitHub check run
                    <select
                      name="checkFailureSeverity"
                      defaultValue={repoSettings.settings.checkFailureSeverity ?? "off"}
                    >
                      <option value="off">neutral (never fails)</option>
                      {["critical", "high", "medium", "low"].map((s) => (
                        <option key={s} value={s}>fail at {s} or above</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Model override
                    <input
                      name="model"
                      defaultValue={repoSettings.settings.model}
                    />
                  </label>
                  <SummarySettings key={JSON.stringify([repoSettings.repo._id,repoSettings.settings.summarySections,repoSettings.settings.commentStyle])} initial={repoSettings.settings.summarySections} style={repoSettings.settings.commentStyle}/>
                  <fieldset className="wide">
                    <legend>Review categories</legend>
                    {[
                      "correctness",
                      "security",
                      "data",
                      "compatibility",
                      "testing",
                      "performance",
                      "rules",
                      "style",
                      "syntax",
                    ].map((c) => (
                      <label key={c}>
                        <span>
                          <input
                            type="checkbox"
                            name="categories"
                            value={c}
                            defaultChecked={repoSettings.settings.categories.includes(
                              c,
                            )}
                          />{" "}
                          {c}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <label className="wide">
                    Custom instructions
                    <textarea
                      name="instructions"
                      rows={4}
                      defaultValue={repoSettings.settings.instructions}
                    />
                  </label>
                  <button className="primary">Save review settings</button>
                </fieldset></form>
                {!isAdmin&&<p>Workspace admin access is required to edit these settings.</p>}
                <h2>Learned preferences</h2><Link href={"/dashboard/memory/preferences?repository="+repoSettings.repo._id}>Inspect sources and manage learned preferences</Link>

              </section>
            )}

          </>
        )}
      </main>
    </div>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}
