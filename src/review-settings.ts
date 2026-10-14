export const summarySections=["overview","affectedAreas","findings","resolved","score","risk","testSource"] as const;
export const summaryLabels:Record<(typeof summarySections)[number],string>={overview:"Changes",affectedAreas:"Affected files",findings:"Verified findings",resolved:"Resolved findings",score:"Review score",risk:"Risk assessment",testSource:"Test source"};
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
  commentStyle: "concise",
  summarySections:[...summarySections],
};
type ScopeReviewSettings = Omit<typeof defaults,"targetBranches"|"ignoredBranches"|"ignoredPaths"|"summarySections"> & {
  targetBranches:string[]; ignoredBranches:string[]; ignoredPaths:string[]; summarySections?:string[];
};
/** Only explicitly selected keys participate; dormant saved values never mask a parent. */
export function scopeDefaults(scopes:readonly {teamId?:string;settings:Partial<ScopeReviewSettings>;overrideKeys:readonly string[]}[],teamId?:string) {
  let value:ScopeReviewSettings={...defaults};
  for(const scope of [scopes.find(s=>!s.teamId),teamId?scopes.find(s=>s.teamId===teamId):undefined]) {
    if(scope)value={...value,...Object.fromEntries(Object.entries(scope.settings).filter(([key,setting])=>setting!==undefined&&scope.overrideKeys.includes(key)))};
  }
  return value;
}
export const runtimeDefaults={enabled:false,image:"",command:"",timeout:120,requiredForApproval:false};
export const approvalDefaults={enabled:false,maximumRisk:"low" as "low"|"medium"|"high",excludedPaths:[] as string[],excludedAuthors:[] as string[],requiredChecks:[] as {name:string;appId?:number}[]};
