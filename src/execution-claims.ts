import type {ReviewInput} from "./engine/types";
import {runtimeStatus} from "./review-summary";

/** Lexical safeguard: source assertions are not recorded command execution. */
export function executionClaimIssues(text:string,runtimeEvidence?:ReviewInput["runtimeEvidence"]):string[]{
 const issues:string[]=[];
    // Replace only the modal/negated predicate, retaining any separate assertion of a recorded outcome.
    const qualified=text.replace(/[*_`]/g,"").replace(/\b(?:cannot|can't|could\s+not|unable\s+to)\s+(?:confirm|verify)\b/gi,"unverified")
      .replace(/\b(?:will|would|could|may|might)\s+(?:(?:not|silently|also|still|otherwise|likely|probably)\s+){0,2}(?:pass|fail|run|execute|confirm|verify|time\s+out)\b/gi,"predicted behavior")
      // Remove only the imperative test-validation prefix; preserve separate outcome claims.
      .replace(/\b(?:run|execute|add|extend|update|write)\s+(?:(?:the|relevant|targeted|regression|unit|integration|existing|new)\s+){0,4}(?:tests?|test suite|checks?)\s+(?:to|and)\s+(?:confirm|verify|check)\b/gi,"requested validation");
    const prose=qualified.replace(/[*_`]/g,"").replace(/\b(?:but|however|although)\b|;/gi,"\n").replace(/\b(?:no|not)\s+(?:evidence|proof|records?|results?|claims?)[^,.\n]{0,100}\b(?:tests?|test execution|test suite)\b[^,.\n]{0,80}/gi,"no recorded execution evidence").replace(/\b(?:not|never)\s+(?:yet\s+)?(?:(?:been|actually)\s+)?(?:executed|run|ran|passed|failed|verified|confirmed|successful|green)\b|\bdid\s+not\s+(?:run|execute|pass|fail|verify|confirm)\b|\bno\s+tests?\s+(?:were|was)\s+(?:run|executed)\b/gi, "execution not performed");
    const executionProse=prose.replace(/\b(?:the|a|an|sole|only|each|every)\s+(?:(?:sole|only)\s+)?verified\s+(?:findings?|defects?|issues?|bugs?)\b/gi,phrase=>phrase.replace(/verified/i,"recorded"));
    const success=/(?:\b(?:tests?|test suite|checks?|recorded command)\b[^.\n]{0,80}\b(?:confirm(?:ed|s)?|verif(?:y|ied|ies)|pass(?:ed|es)?|succeeded|successful(?:ly)?|green)\b|\b(?:passed|verified)\b[^.\n]{0,40}\b(?:tests?|test suite|checks?)\b|\b(?:passing|successful|green)\s+(?:(?:regression|browser|integration|unit|automated)\s+)?(?:tests?|test suite|checks?)\b)/i.exec(executionProse);
    const failure=/\b(?:tests?|test suite|checks?|recorded command)\b[^.\n]{0,80}\b(?:fail(?:ed|ing|s|ures?)?)\b|\b(?:failed|failing)\s+(?:(?:existing|regression|browser|integration|unit|automated)\s+)?(?:tests?|test suite|checks?)\b/i.exec(prose);
    const timeout=/\b(?:tests?|test suite|checks?|recorded command)\b[^.\n]{0,80}\b(?:timed out|timeout)\b/i.exec(prose);
    const claim=success??failure??timeout??/(?:\b(?:tests?|test suite|checks?)\b[^.\n]{0,80}\b(?:executed|ran|were run|was run)\b|\b(?:ran|executed)\b[^.\n]{0,40}\b(?:tests?|test suite|checks?)\b)/i.exec(prose);
    const status=runtimeStatus(runtimeEvidence);
    if (runtimeEvidence?.executionStarted!==true && claim) {
      issues.push("No test execution evidence was supplied. Omit execution claims and describe test source as assertions only. Unsupported phrase: "+claim[0].slice(0,160));
    } else if ((success&&status!=="passed")||(failure&&status!=="failed")||(timeout&&status!=="timed out")) {
      issues.push(`Recorded command outcome is ${status}. Do not claim a different test outcome; describe test source as assertions only.`);
    }
 return issues;
}
export function executionExplanation(text:string,runtimeEvidence?:ReviewInput["runtimeEvidence"]){
 return executionClaimIssues(text,runtimeEvidence).length?"Explanation withheld because it claimed an unrecorded or inconsistent test outcome. Test source supplies assertions; runtime evidence is required for execution outcomes.":text;
}
