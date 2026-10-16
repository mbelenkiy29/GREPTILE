export const summarySections=["overview","affectedAreas","diagram","findings","agentPrompt","requirements","score","risk","resolved","skipped","testSource","tips"] as const;
export const summaryLabels:Record<(typeof summarySections)[number],string>={overview:"Overview",affectedAreas:"Files changed",diagram:"Sequence diagram",findings:"Issues",agentPrompt:"Prompt for your coding agent",requirements:"Requirements",score:"Confidence score",risk:"Risk assessment",resolved:"Resolved findings",skipped:"Skipped files",testSource:"Test source",tips:"Feature tips"};
// Feature tips (a footer line, not a section) are off by default; the hosted cloud turns them on
// through deploymentDefaults().
const defaultSummarySections=summarySections.filter(s=>s!=="tips");
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
  // "agentic" uses the tool-calling investigator and "hypotheses" plans bug hypotheses investigated in
  // parallel; the default stays on the fixed pipeline until an approved live comparison says otherwise.
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
  // Learned team conventions start as suggestions; admins may auto-approve them per scope.
  autoApproveConventions: false,
  // "@openreview fix this in a new PR" may open a fix pull request on a new branch (needs contents:write).
  fixPullRequests: false,
  // Human replies in threads OpenReview started are answered without an @openreview mention.
  threadReplies: true,
  // Deterministic security checks on added lines and OSV advisories for changed dependencies.
  securityScan: true,
  commentStyle: "concise",
  summarySections:[...defaultSummarySections] as string[],
  // GitHub: the summary goes in the pull request description ("description") or one comment ("comment").
  summaryPlacement: "description",
  // GitHub check run: fail when the confidence score is below this (1–5; 0 = off).
  checkMinimumScore: 0,
};
/** Defaults for this deployment: the hosted cloud (BILLING_ENABLED=true) also shows feature tips. */
export const deploymentDefaults=(env:Record<string,string|undefined>=process.env)=>env.BILLING_ENABLED==="true"?{...defaults,summarySections:[...defaultSummarySections,"tips"]}:defaults;
type ScopeReviewSettings = Omit<typeof defaults,"targetBranches"|"ignoredBranches"|"ignoredPaths"|"summarySections"|"triggerLabels"|"excludedAuthors"|"lockedKeys"> & {
  targetBranches:string[]; ignoredBranches:string[]; ignoredPaths:string[]; summarySections?:string[]; triggerLabels:string[]; excludedAuthors:string[]; lockedKeys:string[];
};
/** Only explicitly selected keys participate; dormant saved values never mask a parent. */
export function scopeDefaults(scopes:readonly {teamId?:string;settings:Partial<ScopeReviewSettings>;overrideKeys:readonly string[]}[],teamId?:string,base:typeof defaults=defaults) {
  let value:ScopeReviewSettings={...base};
  for(const scope of [scopes.find(s=>!s.teamId),teamId?scopes.find(s=>s.teamId===teamId):undefined]) {
    if(scope)value={...value,...Object.fromEntries(Object.entries(scope.settings).filter(([key,setting])=>setting!==undefined&&scope.overrideKeys.includes(key)))};
  }
  return value;
}
export const reviewEngines=["pipeline","agentic","hypotheses"] as const;
export const validReviewEngine=(value:string|undefined)=>value===undefined||(reviewEngines as readonly string[]).includes(value);
// Optional trigger/limit settings stay valid when absent (older saved settings).
export const lockableKeys=["mode","minimumConfidence","severityThreshold","maxComments","categories","ignoredPaths","instructions","commentStyle","summarySections","strictness","reviewEngine"] as const;
export const validTriggerSettings=(s:{triggerLabels?:string[];excludedAuthors?:string[];maxFiles?:number;maxChangedLines?:number;strictness?:number;lockedKeys?:string[]})=>
 (s.lockedKeys??[]).every(k=>(lockableKeys as readonly string[]).includes(k))&&
 (s.triggerLabels??[]).length<=20&&(s.triggerLabels??[]).every(l=>l.trim().length>0&&l.length<=100)&&
 (s.excludedAuthors??[]).length<=50&&(s.excludedAuthors??[]).every(a=>a.trim().length>0&&a.length<=100)&&
 [s.maxFiles??0,s.maxChangedLines??0].every(n=>Number.isInteger(n)&&n>=0&&n<=1_000_000)&&[0,1,2,3].includes(s.strictness??0);
// Strictness presets map to the confidence and severity thresholds; 0 keeps the custom values.
export const strictnessPresets = { 1: { minimumConfidence: 0.95, severityThreshold: "high" }, 2: { minimumConfidence: 0.85, severityThreshold: "medium" }, 3: { minimumConfidence: 0.75, severityThreshold: "low" } } as const;
export function effectiveThresholds(settings: { strictness?: number; minimumConfidence: number; severityThreshold: string }) {
  const preset = strictnessPresets[settings.strictness as 1 | 2 | 3];
  return preset ? { ...preset } : { minimumConfidence: settings.minimumConfidence, severityThreshold: settings.severityThreshold };
}
export const checkFailureSeverities=["off","critical","high","medium","low"] as const;
export const validCheckFailureSeverity=(value:string|undefined)=>value===undefined||(checkFailureSeverities as readonly string[]).includes(value);
export const summaryPlacements=["description","comment"] as const;
// Publication settings are optional (older saved settings have neither).
export const validPublicationSettings=(s:{summaryPlacement?:string;checkMinimumScore?:number})=>(s.summaryPlacement===undefined||(summaryPlacements as readonly string[]).includes(s.summaryPlacement))&&(s.checkMinimumScore===undefined||Number.isInteger(s.checkMinimumScore)&&s.checkMinimumScore>=0&&s.checkMinimumScore<=5);
// generatedTests: opt-in reproduction tests for verified findings, run with testCommand ("{test}" is the
// generated file's path) in the same approved image and sandbox.
export const runtimeDefaults={enabled:false,image:"",command:"",timeout:120,requiredForApproval:false,generatedTests:false,testCommand:""};
export const approvalDefaults={enabled:false,maximumRisk:"low" as "low"|"medium"|"high",excludedPaths:[] as string[],excludedAuthors:[] as string[],requiredChecks:[] as {name:string;appId?:number}[]};
