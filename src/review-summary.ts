import {summarySections,summaryLabels,validSummarySections} from "./review-settings";
import type {Finding,ReviewInput,ReviewResult,SourceFile} from "./engine/types";
import {suggestionBlock,type SuggestionSyntax} from "./suggestions";
import {changedLines} from "./engine/patch-lines";
import {reviewVerdict,verdictLine} from "./verdict";
import {priorityBadge,tagBadges} from "./priority";
import {tipLine,type TicketKind,type TipKey} from "./feature-tips";
import {generatedTestSection} from "./generated-tests";
import {requirementsSection,type RequirementResult} from "./requirements-check";

export function runtimeStatus(evidence:ReviewInput["runtimeEvidence"]){
 if(!evidence||evidence.executionStarted!==true)return "execution not confirmed";
 if(evidence.timedOut)return "timed out";
 return evidence.exitCode===0?"passed":evidence.exitCode===null?"outcome unavailable":"failed";
}
const code=(value:string)=>"`"+value.replaceAll("`","").replace(/[\r\n]/g," ")+"`";
// An inline code span that keeps backticks: the delimiter is longer than any backtick run inside.
export const codeSpan=(value:string)=>{const text=value.replace(/[\r\n]+/g," ");const run=Math.max(0,...(text.match(/`+/g)??[]).map(r=>r.length));const tick="`".repeat(run+1);return tick+(/^`|`$/.test(text)||/^ .* $/.test(text)?" "+text+" ":text)+tick;};
// A fenced block that cannot be closed early by fences inside the text.
export const fenced=(text:string,info="")=>{const run=Math.max(2,...(text.match(/`{3,}/g)??[]).map(r=>r.length));const fence="`".repeat(run+1);return fence+info+"\n"+text+"\n"+fence;};
const plural=(n:number,word:string)=>n+" "+word+(n===1?"":"s");
const priorityRank=(f:Finding)=>severityOrder[f.severity];
// One copyable prompt that hands every open finding to a coding agent. Finding text is quoted
// data inside a fence; the instruction asks the agent to confirm each problem before changing code.
export function agentPrompt(findings:readonly Finding[]){
 if(!findings.length)return "";
 const items=[...findings].sort((a,b)=>priorityRank(a)-priorityRank(b)).slice(0,20).map((f,i)=>{
  const where=f.filePath+":"+f.startLine+(f.endLine>f.startLine?"-"+f.endLine:"");
  const indent=(text:string)=>text.replace(/\s+$/,"").slice(0,1200).split("\n").join("\n   ");
  return (findings.length>1?(i+1)+". ":"")+"["+priorityBadge(f.severity).split(" ")[1]+"] "+f.title.replace(/[\r\n]+/g," ")+"\n   File: "+where+(f.outsideDiff?" (outside the changed lines)":"")+"\n   Problem: "+indent(f.description)+"\n   Suggested fix: "+indent(f.suggestedFix);
 });
 const intro=findings.length>1?"Fix the review findings below in this pull request's branch. For each one, first confirm the problem exists in the current code; if it does not, leave that code alone and say why. Keep each change as small as possible and run the relevant tests afterwards.":"Fix the review finding below in this pull request's branch. First confirm the problem exists in the current code; if it does not, leave the code alone and say why. Keep the change as small as possible and run the relevant tests afterwards.";
 return fenced(intro+"\n\n"+items.join("\n\n")+(findings.length>20?"\n\n("+(findings.length-20)+" more findings are listed on the review page.)":""),"text");
}
type Summary={overview:string;files:ReviewInput["diff"];findings:Finding[];resolved:Finding[];score?:ReviewResult["metadata"]["reviewScore"];assessment:ReviewResult["metadata"]["approvalAssessment"];runtimeEvidence:ReviewInput["runtimeEvidence"];coverageLimits:string[];contextCount:number;candidates:number;suppressed:number;requirementsContext?:{path:string;provenance?:SourceFile["provenance"]}[];skippedFiles?:{path:string;reason:string}[];fileSummaries?:{path:string;summary:string}[];diagram?:string;sourceLink?:(path:string,startLine:number,endLine:number)=>string|undefined;incomplete?:boolean;knowledgeUsed?:string[];requirements?:RequirementResult[]};
// Findings anchored on lines the change did not modify are summary-only; providers post the rest inline.
export const inlineFindings=<T extends Pick<Finding,"outsideDiff">>(findings:readonly T[])=>findings.filter(f=>!f.outsideDiff);
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
const cell=(value:string)=>value.replace(/[\r\n]+/g," ").replace(/\|/g,"\\|").slice(0,300);
const firstSentence=(text:string)=>{const sentence=text.replace(/\s+/g," ").trim().match(/^.*?[.!?](?=\s|$)/)?.[0]??text.trim();return sentence.length>300?sentence.slice(0,297)+"…":sentence;};
const lineStats=(patch:string)=>{let added=0,removed=0;for(const line of patch.split("\n")){if(/^\+(?!\+\+)/.test(line))added++;else if(/^-(?!--)/.test(line))removed++;}return `+${added} −${removed}`;};
const severityOrder={critical:0,high:1,medium:2,low:3} as const;
// Hidden per-row token; GitHub publication replaces it with a link to the finding's inline thread.
export const threadToken=(fingerprint:string)=>/^[a-f0-9]+$/.test(fingerprint)?" <!-- openreview-thread:"+fingerprint+" -->":"";
const badge=(f:Finding)=>priorityBadge(f.severity).replace(/P\d$/,"**$&**")+" · "+f.severity;
const tags=(f:Finding)=>tagBadges(f).map(t=>" · "+t).join("");
// The changed line an outside-the-diff finding cites as its cause.
function cause(f:Finding,files:Summary["files"]){
 for(const e of f.evidence){
  const file=files.find(d=>d.path===e.filePath);if(!file)continue;
  const lines=changedLines(file.patch);
  for(let line=e.startLine;line<e.startLine+e.quote.split("\n").length;line++)if(lines.has(line))return code(e.filePath+":"+line);
 }
 return "";
}
export function reviewSummary(data:Summary,selected:readonly string[]=summarySections){
 if(!validSummarySections(selected))throw new Error("Invalid summary sections");
 const describe=new Map((data.fileSummaries??[]).map(f=>[f.path,f.summary]));
 const location=(f:Finding)=>{const text=code(f.filePath+":"+f.startLine+(f.endLine>f.startLine?"–"+f.endLine:""));const url=data.sourceLink?.(f.filePath,f.startLine,f.endLine);return url&&/^https:\/\//.test(url)?"["+text+"](<"+url.replaceAll(">","%3E")+">)":text;};
 const files=data.files.slice(0,60);
 const inline=inlineFindings(data.findings),outside=data.findings.filter(f=>f.outsideDiff).sort((a,b)=>severityOrder[a.severity]-severityOrder[b.severity]);
 const sections:Record<(typeof summarySections)[number],string>={
  overview:data.overview,
  diagram:data.diagram?"```mermaid\n"+data.diagram+"\n```":"",
  affectedAreas:files.length?"| File | Change |\n| --- | --- |\n"+files.map(f=>"| "+code(f.path)+" | "+cell(describe.get(f.path)??(f.status+" · "+lineStats(f.patch)))+" |").join("\n")+(data.files.length>files.length?"\n\n…and "+(data.files.length-files.length)+" more changed files.":""):"No remaining changed files.",
  findings:inline.length?"| Priority | Location | Issue |\n| --- | --- | --- |\n"+[...inline].sort((a,b)=>severityOrder[a.severity]-severityOrder[b.severity]).map(f=>"| "+badge(f)+" | "+location(f)+" | "+cell(f.title)+tags(f)+threadToken(f.fingerprint)+" |").join("\n"):outside.length?"No verified findings on the changed lines; see Outside the changed code.":"No verified findings. This does not establish that the change is risk-free.",
  score:data.score?"**"+data.score.value+"/5** — "+firstSentence(data.score.reason):"Not recorded for this review.",
  risk:data.assessment?data.assessment.risk+" risk\n\n"+data.assessment.reason:"Unknown: no structured risk assessment was recorded.",
  resolved:data.resolved.map(f=>"- "+f.title+" · "+code(f.filePath)).join("\n")||"No previously reported findings were confirmed resolved in this review.",
  skipped:data.skippedFiles?.length?skippedList(data.skippedFiles).replace(/^\n\nSkipped files:\n/,""):"No changed files were skipped.",
  tips:"",
  agentPrompt:agentPrompt(data.findings),
  requirements:data.requirements?requirementsSection(data.requirements):"",
  testSource:data.files.filter(f=>/(?:^|\/)(?:tests?|__tests__)(?:\/|\.)|\.(?:test|spec)\.[^/]+$/.test(f.path)).map(f=>"- "+code(f.path)).join("\n")||"No changed test source identified by filename. This does not measure test coverage.",
 };
 const runtime=data.runtimeEvidence;
 const verdict=reviewVerdict({score:data.score?.value,findings:data.findings,incomplete:data.incomplete});
 // Tips are a footer line added at publication (see reviewFooter), not a summary section.
 const shown=selected.filter(s=>s!=="tips"&&(s!=="diagram"||data.diagram)&&(s!=="requirements"||data.requirements)&&(s!=="agentPrompt"||data.findings.length));
 const blocks=shown.map(s=>"### "+summaryLabels[s as keyof typeof summaryLabels]+"\n"+sections[s as keyof typeof sections]);
 // Always shown when present: these findings have no inline comment, so the summary is their only place.
 if(outside.length){
  const pivot=summarySections.indexOf("findings");
  const at=shown.reduce((last,s,i)=>summarySections.indexOf(s as (typeof summarySections)[number])<=pivot?i+1:last,0);
  blocks.splice(at,0,"### Outside the changed code\nVerified findings on lines this change did not modify, caused by lines it did. They are not posted as inline comments.\n\n"+outside.slice(0,20).map(f=>{const by=cause(f,data.files);return "- "+badge(f)+" · "+location(f)+" · "+cell(f.title)+tags(f)+"\n  "+(by?"Caused by "+by+". ":"")+firstSentence(f.description)+" **Fix:** "+firstSentence(f.suggestedFix);}).join("\n")+(outside.length>20?"\n- "+(outside.length-20)+" more on the review page.":""));
 }
 return [verdictLine(verdict,selected.includes("score")?data.score:undefined),...blocks,
  "### Test execution\n"+(runtime?"Recorded command: "+code(runtime.command)+" · "+runtimeStatus(runtime)+" at "+runtime.headSha+".":"Not executed by OpenReview. Test files and CI metadata are context, not proof of a successful test run."),
  `### Coverage\n${plural(data.files.length,"changed file")}; ${plural(data.contextCount,"retrieved context file")}. ${plural(data.candidates,"candidate")}; ${plural(data.findings.length,"verified finding")}; ${data.suppressed} suppressed.`+(data.coverageLimits.length?"\n\n"+data.coverageLimits.map(l=>"- "+l).join("\n"):"")+(selected.includes("skipped")?"":skippedList(data.skippedFiles))+(data.knowledgeUsed?.length?"\n\nKnowledge base entries supplied as background (not evidence): "+data.knowledgeUsed.slice(0,10).map(k=>code(k.slice(0,100))).join(", ")+(data.knowledgeUsed.length>10?" and "+(data.knowledgeUsed.length-10)+" more":"")+".":"")+fetchedContextLinks(data.requirementsContext)].join("\n\n");
}

export function findingComment(f: Finding, style: string = "detailed", suggestion?: { syntax: SuggestionSyntax; start: number; end: number }, options: { agentPrompt?: boolean } = {}): string {
  const evidence = f.evidence
    .map((e) =>
      style === "concise"
        ? `Evidence: \`${e.filePath}:${e.startLine}\` — ${codeSpan(e.quote.split("\n")[0].trim())}`
        : `Evidence: \`${e.filePath}:${e.startLine}\`\n\n\`\`\`\n${e.quote.replace(/```/g, "` ` `")}\n\`\`\``,
    )
    .join("\n\n") + f.evidence.filter(e => e.sourceUrl).map(e => "\n\n[Source: "+e.repository+" @ "+e.revision+"]("+e.sourceUrl+")").join("");
  const fix = f.suggestion && suggestion ? suggestionBlock(f.suggestion, suggestion.syntax, suggestion) : "";
  return `**${priorityBadge(f.severity)} · ${f.title}**${tagBadges(f).map((t) => " · " + t).join("")} (${f.severity}, ${Math.round(f.confidence * 100)}% confidence)\n\n${f.description}\n\n**Impact:** ${f.impact}\n\n**Fix:** ${f.suggestedFix}${fix}${f.generatedTest ? generatedTestSection(f.generatedTest) : ""}${f.question ? `\n\n**Question for the author:** ${f.question.replace(/[\r\n]+/g, " ").replace(/@(?=[\w-])/g, "@\u200b")}` : ""}\n\n${evidence}${options.agentPrompt ? "\n\n<details><summary>Prompt for your coding agent</summary>\n\n" + agentPrompt([f]) + "\n\n</details>" : ""}\n\n<!-- openreview-finding:${f.fingerprint} -->`;
}

// Footer line: which review this is on the pull request, and the comment that re-runs it where the
// provider's dispatch supports one (Azure DevOps service hooks take no commands; Perforce needs the
// whole-comment native form).
export type FooterProvider="azure-devops"|"perforce"|"other";
export const rerunCommand=(provider:FooterProvider)=>provider==="azure-devops"?undefined:provider==="perforce"?"@openreview review again":"@openreview review";
export function reviewFooter(reviewNumber:number|undefined,provider:FooterProvider,tip?:{sections:readonly string[];key:TipKey;ticket?:TicketKind}|null){
 if(reviewNumber!==undefined&&(!Number.isSafeInteger(reviewNumber)||reviewNumber<1))throw new Error("Invalid review number");
 const command=rerunCommand(provider);
 const parts=[reviewNumber?"Review "+reviewNumber+" on this pull request":"",command?"Comment `"+command+"` to re-run it":"Re-run it from the dashboard"].filter(Boolean);
 return "\n\n"+parts.join(" · ")+"."+(tip&&tip.sections.includes("tips")?tipLine(tip.key,tip.ticket):"");
}
export function reviewLinks(reviewId:string,unresolvedCount:number){
 if(!process.env.APP_URL)return "";
 const origin=new URL(process.env.APP_URL);
 if(!["http:","https:"].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=="/"||origin.search||origin.hash)throw new Error("Invalid application origin");
 if(!Number.isSafeInteger(unresolvedCount)||unresolvedCount<0)throw new Error("Invalid unresolved finding count");
 const id=encodeURIComponent(reviewId);
 return `\n\n[View review / Re-review](${origin.origin}/dashboard/pulls/${id})`+(unresolvedCount?` · [Fix All](${origin.origin}/fix/${id})`:"");
}
