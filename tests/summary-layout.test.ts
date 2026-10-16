import test from "node:test";
import assert from "node:assert/strict";
import {disclosureLayout,threadLinks,withDescriptionSummary,withoutDescriptionSummary,descriptionStart,descriptionEnd} from "../src/summary-layout";
import {agentPrompt,codeSpan,fenced,findingComment,reviewFooter,reviewSummary} from "../src/review-summary";
import type {Finding} from "../src/engine/types";

const finding=(over:Partial<Finding>={}):Finding=>({symbol:"lines",title:"Totals become dollars",description:"`total()` now divides cents by 100.",severity:"high",confidence:0.95,category:"correctness",filePath:"src/cart.ts",startLine:6,endLine:8,evidence:[{filePath:"src/cart.ts",startLine:6,quote:"lines.push(`${item.qty} × ${item.name}`)"}],impact:"Customers are charged a hundredth.",suggestedFix:"Keep integer cents.",fingerprint:"ab12",agent:"correctness",commitSha:"a".repeat(40),...over});
const data=(findings:Finding[])=>({overview:"Adds receipt lines.",files:[{path:"src/cart.ts",status:"modified",patch:"@@ -1 +1 @@\n-a\n+b"}],findings,resolved:[],score:{value:2,reason:"A high-severity defect changes every total. More text."},assessment:{risk:"high" as const,confidence:0.9,reason:"Money paths changed."},runtimeEvidence:undefined,coverageLimits:[],contextCount:1,candidates:1,suppressed:0,diagram:"sequenceDiagram\n  cart->>receipt: lines()"});

test("GitHub layout: verdict with the confidence reason first, details collapsed, diagram open, footer outside",()=>{
 const summary=reviewSummary(data([finding()]))+reviewFooter(3,"other");
 const layout=disclosureLayout(summary);
 assert.match(layout,/^\*\*Needs changes\*\* · Confidence score \*\*2\/5\*\*\n\nA high-severity defect changes every total\.\n\n### Overview\nAdds receipt lines\./);
 assert.doesNotMatch(layout,/### Confidence score/);
 assert.match(layout,/### Issues\n\| Priority \| Location \| Issue \|/);
 for(const label of ["Files changed","Prompt for your coding agent","Risk assessment","Resolved findings","Skipped files","Test source","Test execution","Coverage"])assert.match(layout,new RegExp("<details><summary><strong>"+label+"</strong></summary>\\n\\n"),label);
 assert.match(layout,/<details open><summary><strong>Sequence diagram<\/strong><\/summary>\n\n```mermaid/);
 assert.match(layout,/<\/details>\n\nReview 3 on this pull request · Comment `@openreview review` to re-run it\.$/);
 const order=["### Overview","### Issues","<strong>Sequence diagram","<strong>Prompt for your coding agent","<strong>Files changed","<strong>Risk assessment","<strong>Coverage"].map(h=>layout.indexOf(h));
 assert.deepEqual([...order].sort((a,b)=>a-b),order,"verdict, overview and issues first; then the open diagram; then the collapsed details, prompt first");
 assert.equal((layout.match(/<details/g)??[]).length,(layout.match(/<\/details>/g)??[]).length);
});

test("model text cannot close a disclosure early, but code fences are left alone",()=>{
 const summary=reviewSummary({...data([]),assessment:{risk:"low",confidence:1,reason:"Done.</details><details open>"}});
 const layout=disclosureLayout(summary);
 assert.match(layout,/Done\.&lt;\/details>&lt;details open>/);
 const fencedSummary="**Ready to merge**\n\n### Coverage\n```\n</details>\n```";
 assert.match(disclosureLayout(fencedSummary),/```\n<\/details>\n```\n\n<\/details>$/);
});

test("issue rows link to their inline threads; unknown or unsafe links are dropped",()=>{
 const summary=reviewSummary(data([finding(),finding({fingerprint:"cd34",title:"Second",startLine:9,endLine:9})]));
 assert.match(summary,/<!-- openreview-thread:ab12 -->/);
 const linked=threadLinks(summary,f=>f==="ab12"?"https://github.com/o/r/pull/1#discussion_r10":f==="cd34"?"javascript:alert(1)":undefined);
 assert.match(linked,/Totals become dollars · \[thread\]\(https:\/\/github\.com\/o\/r\/pull\/1#discussion_r10\) \|/);
 assert.match(linked,/\| Second \|/);
 assert.doesNotMatch(linked,/openreview-thread|javascript:/);
});

test("the description block replaces itself and keeps the author's text",()=>{
 const once=withDescriptionSummary("Adds receipts.\r\n\r\nCloses #4",  "## OpenReview\n\nfirst");
 assert.equal(once,"Adds receipts.\r\n\r\nCloses #4\n\n"+descriptionStart+"\n## OpenReview\n\nfirst\n"+descriptionEnd);
 const twice=withDescriptionSummary(once+"\n\nAuthor note added later","## OpenReview\n\nsecond");
 assert.equal(twice,"Adds receipts.\r\n\r\nCloses #4\n\nAuthor note added later\n\n"+descriptionStart+"\n## OpenReview\n\nsecond\n"+descriptionEnd);
 assert.equal(withDescriptionSummary(null,"x"),descriptionStart+"\nx\n"+descriptionEnd);
 assert.equal(withoutDescriptionSummary(twice),"Adds receipts.\r\n\r\nCloses #4\n\nAuthor note added later");
 assert.equal(withoutDescriptionSummary("Intro\n"+descriptionStart+"\ntruncated"),"Intro","a block missing its end marker runs to the end");
 assert.equal(withoutDescriptionSummary("No block here"),"No block here");
});

test("agent prompts keep code intact, list priorities first and cap the list",()=>{
 const tricky=finding({description:"Uses ```js\nfence``` inside text.",severity:"medium",fingerprint:"ef56"});
 const prompt=agentPrompt([tricky,finding()]);
 const fence=prompt.match(/^`+/)![0];
 assert.ok(fence.length>3,"the fence is longer than any fence in the findings");
 assert.ok(prompt.endsWith("\n"+fence));
 assert.ok(prompt.indexOf("[P1] Totals become dollars")<prompt.indexOf("[P2] Totals become dollars"),"P1 before P2");
 assert.match(prompt,/File: src\/cart\.ts:6-8/);
 assert.match(agentPrompt([finding()]),/^```text\nFix the review finding below[^\n]*\n\n\[P1\] Totals become dollars\n   File:/,"one finding: singular, unnumbered");
 assert.match(agentPrompt(Array.from({length:23},(_,i)=>finding({fingerprint:"a"+i}))),/3 more findings are listed on the review page/);
 assert.equal(agentPrompt([]),"");
 assert.equal(fenced("plain"),"```\nplain\n```");
});

test("inline comments keep backticks in evidence and can carry a per-finding agent prompt",()=>{
 assert.equal(codeSpan("a `b` c"),"``a `b` c``");
 assert.equal(codeSpan("`edge`"),"`` `edge` ``");
 const plain=findingComment(finding(),"concise");
 assert.match(plain,/Evidence: `src\/cart\.ts:6` — ``lines\.push\(`\$\{item\.qty\} × \$\{item\.name\}`\)``/);
 assert.doesNotMatch(plain,/<details>/);
 const withPrompt=findingComment(finding(),"concise",undefined,{agentPrompt:true});
 assert.match(withPrompt,/<details><summary>Prompt for your coding agent<\/summary>\n\n```text\n/);
 assert.match(withPrompt,/<\/details>\n\n<!-- openreview-finding:ab12 -->$/);
});

test("summary counts read naturally and the risk line has one confidence number",()=>{
 const summary=reviewSummary(data([finding()]));
 assert.match(summary,/### Coverage\n1 changed file; 1 retrieved context file\. 1 candidate; 1 verified finding; 0 suppressed\./);
 assert.match(summary,/### Risk assessment\nhigh risk\n\nMoney paths changed\./);
 assert.match(summary,/### Prompt for your coding agent\n```text\n/);
 assert.doesNotMatch(reviewSummary(data([])),/Prompt for your coding agent/,"no prompt without findings");
});
