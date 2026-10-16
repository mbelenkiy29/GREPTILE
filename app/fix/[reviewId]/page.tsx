import { redirect } from "next/navigation";
import { current,backend } from "../../../src/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { FixButton } from "../../dashboard/fix-button";
import Link from "next/link";
import { Copy } from "../../dashboard/live";
import { AgentLinks } from "../../dashboard/agent-links";
import { devinHandoff } from "../../../src/agent-links";
import { fixPrompt } from "../../../src/fix-prompt";
import { findingSchema } from "../../../src/engine/types";
export default async function Fix({params,searchParams}:{params:Promise<{reviewId:string}>;searchParams:Promise<{finding?:string;agent?:string}>}) {
 const {token}=await current();const {reviewId}=await params;const q=await searchParams;
 const detail=await backend().query(api.reviews.detail,{token,reviewId:reviewId as Id<"reviews">});const selected=q.finding?detail.findings.find(f=>f.fingerprint===q.finding):undefined;
 if(detail.latestReviewId&&detail.latestReviewId!==reviewId&&(!q.finding||selected)){
  const latest=await backend().query(api.reviews.detail,{token,reviewId:detail.latestReviewId});
  const finding=q.finding?latest.findings.find(f=>f.fingerprint===q.finding):undefined;
  if(latest.review.headSha===detail.review.headSha&&latest.review.revisionKey===detail.review.revisionKey&&(q.finding?finding?.canFix:latest.canFix)){
   const query=new URLSearchParams();if(q.finding)query.set("finding",q.finding);if(q.agent)query.set("agent",q.agent);
   redirect(`/fix/${latest.review._id}`+(query.size?"?"+query.toString():""));
  }
 }
 const [personal,credentials]=await Promise.all([backend().query(api.bridge.personal,{token,organizationId:detail.review.organizationId}),backend().query(api.personalCredentials.status,{token})]);const devin=credentials.devin.configured;const agent=["codex","claude","cursor"].includes(q.agent??"")?q.agent!:personal.agent;
 // The same portable prompt the bridge would send, for copy or an official agent deep link.
 const eligible=(selected?[selected]:detail.findings).filter(f=>f.canFix);
 const repository=(await backend().query(api.repositories.list,{token,organizationId:detail.review.organizationId}).catch(()=>[])).find(r=>r._id===detail.review.repositoryId);
 const prompt=fixPrompt(repository?.fullName??"the repository",`PR #${detail.review.prNumber}`,eligible.map(f=>({...findingSchema.parse(f),agent:f.agent,fingerprint:f.fingerprint,commitSha:f.commitSha})),detail.review.runtimeEvidence);
 return <main className="onboarding"><Link className="brand" href="/dashboard">OpenReview</Link><h1>{selected?selected.title:"Fix review findings"}</h1><p>PR #{detail.review.prNumber} · revision {detail.review.headSha.slice(0,8)}</p>{q.finding&&!selected?<p>This finding is no longer available in this review. Open the latest review to see its current status.</p>:!(selected ? selected.canFix : detail.canFix)?<p>No eligible unresolved findings are available for you at this revision. Check the latest review and repository settings.</p>:<><p>Your selected local agent receives the issue, evidence, file locations, and expected remediation. Review its changes before committing.</p><FixButton reviewId={reviewId} findingId={selected?._id} agent={agent} label={selected?"Fix this issue":"Fix All"}/><h2>No bridge? Hand the prompt to your agent</h2><Copy value={prompt}/><AgentLinks prompt={prompt} repo={repository??undefined} devin={devinHandoff(devin,eligible.length>0,detail.review._id,selected?.fingerprint)}/></>}{detail.latestReviewId && <Link href={`/dashboard/pulls/${detail.latestReviewId}`}>Open latest review</Link>}<Link href="/dashboard/settings/agents">Set up your local bridge</Link></main>;
}
