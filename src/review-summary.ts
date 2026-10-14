import {summarySections,summaryLabels,validSummarySections} from "./review-settings";
import type {Finding,ReviewInput,ReviewResult,SourceFile} from "./engine/types";
import {suggestionBlock,type SuggestionSyntax} from "./suggestions";

export function runtimeStatus(evidence:ReviewInput["runtimeEvidence"]){
 if(!evidence||evidence.executionStarted!==true)return "execution not confirmed";
 if(evidence.timedOut)return "timed out";
 return evidence.exitCode===0?"passed":evidence.exitCode===null?"outcome unavailable":"failed";
}
const code=(value:string)=>"`"+value.replaceAll("`","").replace(/[\r\n]/g," ")+"`";
type Summary={overview:string;files:ReviewInput["diff"];findings:Finding[];resolved:Finding[];score?:ReviewResult["metadata"]["reviewScore"];assessment:ReviewResult["metadata"]["approvalAssessment"];runtimeEvidence:ReviewInput["runtimeEvidence"];coverageLimits:string[];contextCount:number;candidates:number;suppressed:number;requirementsContext?:{path:string;provenance?:SourceFile["provenance"]}[];skippedFiles?:{path:string;reason:string}[]};
const label=(value:string)=>value.slice(0,200).replace(/[\r\n]/g," ").replace(/[\\[\]*_<>]/g,"\\$&");
function requirementsLinks(context:Summary["requirementsContext"],cross=false,seen=new Set<string>()){
 const links:string[]=[];let bytes=0,omitted=0;
 for(const source of context??[]){
  if((cross?!source.path.startsWith("context/"):!/^requirements\/(?:linear|atlassian)\//.test(source.path))||!source.provenance)continue;
  const p=source.provenance;let url:URL;
  try{url=new URL(p.sourceUrl);}catch{continue;}
  if(url.protocol!=="https:"||url.username||url.password)continue;
  const key=url.href+":"+p.revision;if(seen.has(key))continue;seen.add(key);
  const link="- ["+label(p.repository)+" · "+label(source.path.split("/").at(-1)??source.path)+"](<"+url.href.replaceAll("<","%3C").replaceAll(">","%3E")+">) · revision "+code(p.revision.slice(0,200));
  const size=new TextEncoder().encode(link).byteLength;
  if(links.length>=20||bytes+size>8000){omitted++;continue;}
  bytes+=size;links.push(link);
 }
 return links.length||omitted?"\n\n"+(cross?"Fetched repository sources":"Fetched requirements")+" supplied as review context:\n"+links.join("\n")+(omitted?"\n- "+omitted+(cross?" additional fetched repository source links omitted by the summary size limit.":" additional fetched requirements links omitted by the summary size limit."):""):"";
}
function fetchedContextLinks(context:Summary["requirementsContext"]){const seen=new Set<string>();return requirementsLinks(context,false,seen)+requirementsLinks(context,true,seen);}
function skippedList(files:Summary["skippedFiles"]){
 if(!files?.length)return "";
 return "\n\nSkipped files:\n"+files.slice(0,50).map(f=>"- "+code(f.path.slice(0,300))+" · "+label(f.reason)).join("\n")+(files.length>50?"\n- "+(files.length-50)+" more skipped files omitted from this summary.":"");
}
export function reviewSummary(data:Summary,selected:readonly string[]=summarySections){
 if(!validSummarySections(selected))throw new Error("Invalid summary sections");
 const sections:Record<(typeof summarySections)[number],string>={
  overview:data.overview,
  affectedAreas:data.files.map(f=>"- "+code(f.path)+" · "+f.status).join("\n")||"No remaining changed files.",
  findings:data.findings.map(f=>"- **"+f.severity+"** · "+f.title+" · "+code(f.filePath+":"+f.startLine)).join("\n")||"No verified findings. This does not establish that the change is risk-free.",
  resolved:data.resolved.map(f=>"- "+f.title+" · "+code(f.filePath)).join("\n")||"No previously reported findings were confirmed resolved in this review.",
  score:data.score?data.score.value+"/5 · Merge readiness\n\n"+data.score.reason:"Not recorded for this review.",
  risk:data.assessment?data.assessment.risk+" · Confidence "+Math.round(data.assessment.confidence*100)+"%\n\n"+data.assessment.reason:"Unknown: no structured risk assessment was recorded.",
  testSource:data.files.filter(f=>/(?:^|\/)(?:tests?|__tests__)(?:\/|\.)|\.(?:test|spec)\.[^/]+$/.test(f.path)).map(f=>"- "+code(f.path)).join("\n")||"No changed test source identified by filename. This does not measure test coverage.",
 };
 const runtime=data.runtimeEvidence;
 return [...selected.map(s=>"### "+summaryLabels[s as keyof typeof summaryLabels]+"\n"+sections[s as keyof typeof sections]),
  "### Test execution\n"+(runtime?"Recorded command: "+code(runtime.command)+" · "+runtimeStatus(runtime)+" at "+runtime.headSha+".":"Not executed by OpenReview. Test files and CI metadata are context, not proof of a successful test run."),
  `### Coverage\n${data.files.length} changed files; ${data.contextCount} retrieved context files. ${data.candidates} candidates; ${data.findings.length} verified findings; ${data.suppressed} suppressed.`+(data.coverageLimits.length?"\n\n"+data.coverageLimits.map(l=>"- "+l).join("\n"):"")+skippedList(data.skippedFiles)+fetchedContextLinks(data.requirementsContext)].join("\n\n");
}

export function findingComment(f: Finding, style: string = "detailed", suggestion?: { syntax: SuggestionSyntax; start: number; end: number }): string {
  const evidence = f.evidence
    .map((e) =>
      style === "concise"
        ? `Evidence: \`${e.filePath}:${e.startLine}\` — ${e.quote.split("\n")[0].replaceAll("`", "")}`
        : `Evidence: \`${e.filePath}:${e.startLine}\`\n\n\`\`\`\n${e.quote.replace(/```/g, "` ` `")}\n\`\`\``,
    )
    .join("\n\n") + f.evidence.filter(e => e.sourceUrl).map(e => "\n\n[Source: "+e.repository+" @ "+e.revision+"]("+e.sourceUrl+")").join("");
  const fix = f.suggestion && suggestion ? suggestionBlock(f.suggestion, suggestion.syntax, suggestion) : "";
  return `**${f.severity.toUpperCase()}: ${f.title}** (${Math.round(f.confidence * 100)}% confidence)\n\n${f.description}\n\n**Impact:** ${f.impact}\n\n**Fix:** ${f.suggestedFix}${fix}\n\n${evidence}\n\n<!-- openreview-finding:${f.fingerprint} -->`;
}

export function reviewLinks(reviewId:string,unresolvedCount:number){
 if(!process.env.APP_URL)return "";
 const origin=new URL(process.env.APP_URL);
 if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw new Error("Invalid application origin");
 if(!Number.isSafeInteger(unresolvedCount)||unresolvedCount<0)throw new Error("Invalid unresolved finding count");
 const id=encodeURIComponent(reviewId);
 return `\n\n[View review / Re-review](${origin.origin}/dashboard/pulls/${id})`+(unresolvedCount?` · [Fix All](${origin.origin}/fix/${id})`:"");
}
