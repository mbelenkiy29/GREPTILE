import { z } from "zod";
import picomatch from "picomatch";
import { approvalAssessmentSchema } from "./engine/types";
export {approvalDefaults} from "./review-settings";

export const approvalPolicySchema = z.object({
  enabled: z.boolean(),
  maximumRisk: z.enum(["low", "medium", "high"]),
  excludedPaths: z.array(z.string().min(1).max(300)).max(100),
  excludedAuthors: z.array(z.string().min(1).max(100)).max(100),
  requiredChecks: z.array(z.object({name:z.string().min(1).max(200),appId:z.number().int().positive().optional()})).max(100),
});
export function approvalPolicyKey(policy:z.infer<typeof approvalPolicySchema>){return JSON.stringify(approvalPolicySchema.parse(policy));}
export type ApprovalState = {
  supported:boolean; open:boolean; draft:boolean; head:string; reviewedHead:string;
  revisionKey?:string; reviewedRevisionKey?:string; latest:boolean; completed:boolean;
  coverageLimits?:string[]; unresolved:number;
  assessment?:z.infer<typeof approvalAssessmentSchema>;
  author:string; changedPaths:string[]; humanChangeRequested:boolean;
  requiredChecksKnown:boolean;
  checks:{name:string;appId?:number;status:string;conclusion:string|null}[];
  nativeRequiredChecks:{name:string;appId?:number}[];
  runtimeRequired:boolean; runtimePassed:boolean;
};
/** All inputs come from trusted settings, recorded review state, and fresh provider reads. */
export function approvalBlockers(policy:z.infer<typeof approvalPolicySchema>,state:ApprovalState){
  const p=approvalPolicySchema.parse(policy),reasons:string[]=[];
  if(!p.enabled)reasons.push("Automatic approval is disabled");
  if(!state.supported)reasons.push("Provider approval is unsupported");
  if(!state.open||state.draft)reasons.push("Change is closed or a draft");
  if(!state.latest||state.head!==state.reviewedHead||state.revisionKey!==state.reviewedRevisionKey)reasons.push("Review does not cover the current revision");
  if(!state.completed)reasons.push("Review is incomplete");
  if(!state.coverageLimits||state.coverageLimits.length)reasons.push("Review coverage is incomplete or unknown");
  if(state.unresolved!==0)reasons.push("Unresolved verified findings remain");
  const assessment=approvalAssessmentSchema.safeParse(state.assessment);
  if(!assessment.success||assessment.data.confidence!==1)reasons.push("Maximum review confidence is required");
  if(!assessment.success||assessment.data.risk==="unknown"||["low","medium","high"].indexOf(assessment.data.risk)>["low","medium","high"].indexOf(p.maximumRisk))reasons.push("Risk exceeds the configured ceiling or is unknown");
  const excluded=picomatch(p.excludedPaths);
  if(p.excludedAuthors.some(a=>a.toLowerCase()===state.author.toLowerCase())||state.changedPaths.some(path=>excluded(path)))reasons.push("Approval exclusion rule matched");
  if(state.humanChangeRequested)reasons.push("A human has requested changes");
  if(!state.requiredChecksKnown)reasons.push("Required provider checks could not be determined");
  const required=[...state.nativeRequiredChecks,...p.requiredChecks];
  if(required.some(required=>{const matches=state.checks.filter(c=>c.name===required.name&&(required.appId===undefined||required.appId===c.appId));return !matches.length||matches.some(c=>c.status!=="completed"||c.conclusion!=="success");}))reasons.push("Required checks have not passed");
  if(state.runtimeRequired&&!state.runtimePassed)reasons.push("Required runtime validation has not passed");
  return reasons;
}
