import type {Finding} from "./engine/types";

// One-line merge verdict computed only from recorded data (score, unresolved severities and
// coverage), never from free model text.
export const verdicts=["ready","fixes","changes","incomplete"] as const;
export type Verdict=(typeof verdicts)[number];
export const verdictLabels:Record<Verdict,string>={ready:"Ready to merge",fixes:"Merge after fixes",changes:"Needs changes",incomplete:"Review incomplete"};
export function reviewVerdict({score,findings,incomplete}:{score?:number;findings:Pick<Finding,"severity">[];incomplete?:boolean}):Verdict{
 if(findings.some(f=>f.severity==="critical"||f.severity==="high")||score!==undefined&&score<=2)return "changes";
 if(findings.some(f=>f.severity==="medium")||score===3)return "fixes";
 // Only low-severity findings (or none) and a score of 4–5: ready unless coverage was cut short.
 return incomplete||score===undefined?"incomplete":"ready";
}
export function verdictLine(verdict:Verdict,score?:{value:number}){
 return "**"+verdictLabels[verdict]+"**"+(score?" · Confidence score **"+score.value+"/5**":"");
}
