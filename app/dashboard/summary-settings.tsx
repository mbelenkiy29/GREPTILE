"use client";
import {useState} from "react";
import {defaults,summarySections,summaryLabels} from "../../src/review-settings";
import {findingComment} from "../../src/review-summary";
import {example,exampleSummary} from "./summary-example";
import {ReviewMarkdown} from "./markdown";
export function SummarySettings({initial,style="concise"}:{initial?:string[];style?:string}){
 const [selected,setSelected]=useState<string[]>(initial??[...defaults.summarySections]),[commentStyle,setCommentStyle]=useState(style);
 const summary=exampleSummary(selected);
 return <fieldset className="wide summary-settings"><legend>Review formatting</legend><input type="hidden" name="summaryConfigured" value="true"/><label>Comment style<select name="commentStyle" value={commentStyle} onChange={e=>setCommentStyle(e.target.value)}><option>concise</option><option>detailed</option></select></label><fieldset><legend>Summary sections</legend>{summarySections.map(section=><label className="check" key={section}><input type="checkbox" name="summarySections" value={section} checked={selected.includes(section)} onChange={e=>setSelected(summarySections.filter(s=>s===section?e.target.checked:selected.includes(s)))}/>{summaryLabels[section]}</label>)}</fieldset><p className="muted">Execution evidence and coverage always appear. These settings apply to future reviews.</p><details open><summary>Live comment preview · example data</summary><div aria-live="polite"><h3>Summary</h3><ReviewMarkdown>{summary}</ReviewMarkdown><h3>Inline finding</h3><ReviewMarkdown>{findingComment(example,commentStyle)}</ReviewMarkdown></div></details></fieldset>;
}
