export const summarySections=["overview","affectedAreas","diagram","findings","score","risk","resolved","skipped","testSource"] as const;
export const summaryLabels:Record<(typeof summarySections)[number],string>={overview:"Overview",affectedAreas:"Files changed",diagram:"Sequence diagram",findings:"Issues",score:"Confidence score",risk:"Risk assessment",resolved:"Resolved findings",skipped:"Skipped files",testSource:"Test source"};
export const validSummarySections=(value:readonly string[]|undefined)=>value===undefined||value.length<=summarySections.length&&new Set(value).size===value.length&&value.every(s=>(summarySections as readonly string[]).includes(s));
export const defaults = {
  automatic: true,
  drafts: false,
  targetBranches: [],
  ignoredBranches: [],
  ignoredPaths: [],
  maxComments: 10,
  minimumConfidence: 0.85,
  severityThreshold: "medium",
  categories: [
    "correctness",
    "security",
    "data",
    "compatibility",
    "testing",
    "performance",
    "rules",
  ],
  model: "",
  instructions: "",
  rereview: true,
  mode: "standard",
  // "agentic" uses the tool-calling investigator; the default stays on the fixed pipeline until
  // an approved live comparison says otherwise.
  reviewEngine: "pipeline",
  // GitHub check run conclusion: "off" reports neutral; a severity fails the check when findings reach it.
  checkFailureSeverity: "off",
  // Triggers and filters (GitHub webhooks): labels that start a review, excluded author globs,
  // size limits for automatic reviews (0 = none) and a strictness preset (0 = custom thresholds).
  triggerLabels: [] as string[],
  excludedAuthors: [] as string[],
  maxFiles: 0,
  maxChangedLines: 0,
  strictness: 0,
  // Keys the repository config file (.openreview.json, base branch) may not override.
  lockedKeys: [] as string[],
  commentStyle: "concise",
  summarySections:[...summarySections],
};
type ScopeReviewSettings = Omit<typeof defaults,"targetBranches"|"ignoredBranches"|"ignoredPaths"|"summarySections"|"triggerLabels"|"excludedAuthors"|"lockedKeys"> & {
  targetBranches:string[]; ignoredBranches:string[]; ignoredPaths:string[]; summarySections?:string[]; triggerLabels:string[]; excludedAuthors:string[]; lockedKeys:string[];
};
/** Only explicitly selected keys participate; dormant saved values never mask a parent. */
export function scopeDefaults(scopes:readonly {teamId?:string;settings:Partial<ScopeReviewSettings>;overrideKeys:readonly string[]}[],teamId?:string) {
  let value:ScopeReviewSettings={...defaults};
  for(const scope of [scopes.find(s=>!s.teamId),teamId?scopes.find(s=>s.teamId===teamId):undefined]) {
    if(scope)value={...value,...Object.fromEntries(Object.entries(scope.settings).filter(([key,setting])=>setting!==undefined&&scope.overrideKeys.includes(key)))};
  }
  return value;
}
export const reviewEngines=["pipeline","agentic"] as const;
export const validReviewEngine=(value:string|undefined)=>value===undefined||(reviewEngines as readonly string[]).includes(value);
// Optional trigger/limit settings stay valid when absent (older saved settings).
export const lockableKeys=["mode","minimumConfidence","severityThreshold","maxComments","categories","ignoredPaths","instructions","commentStyle","summarySections","strictness","reviewEngine"] as const;
export const validTriggerSettings=(s:{triggerLabels?:string[];excludedAuthors?:string[];maxFiles?:number;maxChangedLines?:number;strictness?:number;lockedKeys?:string[]})=>
 (s.lockedKeys??[]).every(k=>(lockableKeys as readonly string[]).includes(k))&&
 (s.triggerLabels??[]).length<=20&&(s.triggerLabels??[]).every(l=>l.trim().length>0&&l.length<=100)&&
 (s.excludedAuthors??[]).length<=50&&(s.excludedAuthors??[]).every(a=>a.trim().length>0&&a.length<=100)&&
 [s.maxFiles??0,s.maxChangedLines??0].every(n=>Number.isInteger(n)&&n>=0&&n<=1_000_000)&&[0,1,2,3].includes(s.strictness??0);
export const checkFailureSeverities=["off","critical","high","medium","low"] as const;
export const validCheckFailureSeverity=(value:string|undefined)=>value===undefined||(checkFailureSeverities as readonly string[]).includes(value);
export const runtimeDefaults={enabled:false,image:"",command:"",timeout:120,requiredForApproval:false};
export const approvalDefaults={enabled:false,maximumRisk:"low" as "low"|"medium"|"high",excludedPaths:[] as string[],excludedAuthors:[] as string[],requiredChecks:[] as {name:string;appId?:number}[]};
