import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { RuntimePolicyForm,RuntimeWorkerForm } from "./runtime-form";
import { revokeRuntimeWorker } from "./actions";
import {ApprovalPolicyForm} from "./approval-form";
import {Live} from "./live";
export async function RuntimeSettings({token,organizationId}:{token:string;organizationId:Id<"organizations">}){
 const [settings,scopes,approvals]=await Promise.all([backend().query(api.runtime.settings,{token,organizationId}),backend().query(api.scopes.list,{token,organizationId}),backend().query(api.approvals.settings,{token,organizationId})]);
 return <><section><h2>Automatic approval</h2><p>Disabled by default. Settings are controlled by workspace admins and inherited by teams and repositories.</p><ApprovalPolicyForm organizationId={organizationId} policies={approvals.policies} teams={scopes.teams} repositories={scopes.repositories.filter(r=>approvals.repositoryIds.includes(r._id))}/></section><section><h2>Runtime validation</h2><p>Disabled by default. Approve the image and command at organization, team, or repository scope before enabling it. Source and logs are pinned to the reviewed revision.</p><RuntimePolicyForm organizationId={organizationId} policies={settings.policies} teams={scopes.teams} repositories={scopes.repositories}/></section><section><h2>Runtime workers</h2><RuntimeWorkerForm organizationId={organizationId}/>{settings.workers.map(w=><article key={w._id}><strong>{w.name}</strong><p>{w.revoked?"Revoked":w.expiresAt<Date.now()?"Expired":(w.lastSeen??0)>Date.now()-120000?"Connected":"Disconnected"} · Expires {new Date(w.expiresAt).toLocaleString()}</p>{!w.revoked&&<form action={revokeRuntimeWorker}><input type="hidden" name="workerId" value={w._id}/><button>Revoke worker</button></form>}</article>)}</section></>;
}
export async function RuntimeReview({token,reviewId,evidence}:{token:string;reviewId:Id<"reviews">;evidence?:Doc<"reviews">["runtimeEvidence"]}){
 const jobs=await backend().query(api.runtime.review,{token,reviewId});
 if(!jobs.length)return <>{evidence && (
                <section>
                  <h2>Recorded runtime evidence</h2>
                  <p>
                    {evidence.command} · Exit{" "}
                    {evidence.exitCode ?? "unknown"} ·{" "}
                    {evidence.executionStarted !== true ? "Execution not confirmed" : evidence.timedOut
                      ? "Limit reached"
                      : "Finished"}
                  </p>
                  <p className="muted">
                    Revision {evidence.headSha} · Network
                    disabled · {evidence.image}
                  </p>
                  <pre>{evidence.output}</pre>
                  {evidence.outputTruncated && (
                    <p>Logs truncated to the final 20,000 characters.</p>
                  )}
                </section>
              )}</>;
 return <section><h2>Automatic runtime validation</h2>{jobs.map(j=><article key={j._id}><p><span className={"badge "+j.status}>{j.status.replaceAll("_"," ")}</span> · Revision {j.headSha}</p><p>{j.policy.command} · Timeout {j.policy.timeout}s</p><p className="muted">{j.policy.image}</p>{j.error&&<p role="alert">{j.error}</p>}{j.evidence&&<><p>{j.evidence.executionStarted?"Approved command started":"Command execution not confirmed"} · Exit {j.evidence.exitCode??"unknown"} · Network disabled</p><pre>{j.evidence.output}</pre>{j.evidence.outputTruncated&&<p>Output truncated.</p>}</>}</article>)}</section>;
}
export async function ApprovalReview({token,reviewId}:{token:string;reviewId:Id<"reviews">}){
 const job=await backend().query(api.approvals.review,{token,reviewId});
 if(!job)return null;
 return <section><h2>Automatic approval</h2><Live active={["pending","evaluating","waiting_checks","revocation_pending"].includes(job.status)}/>{job.status==="revocation_pending"&&<p role="alert">Withdrawal pending. The native approval may still be active. OpenReview will retry withdrawal and will not publish another approval for this review.</p>}<p><span className={"badge "+job.status}>{job.status.replaceAll("_"," ")}</span> · Revision {job.headSha}</p>{job.reasons.map(reason=><p key={reason}>{reason}</p>)}{job.providerReviewId&&<p>Provider review {job.providerReviewId}. No merge is performed.</p>}</section>;
}
