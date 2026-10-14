import type { Finding, ReviewInput } from "./engine/types";
import { executionExplanation } from "./execution-claims";
import { runtimeStatus } from "./review-summary";
export function fixPrompt(
  repository: string,
  pullRequest: string,
  findings: Finding[],
  runtimeEvidence?: ReviewInput["runtimeEvidence"],
): string {
  return (
    `Fix the following verified OpenReview findings in ${repository}, ${pullRequest}. Read repository instructions and related code. Validate each issue before editing; preserve unrelated changes. Add or extend a targeted regression test that fails on the reviewed revision and passes after the fix. Run relevant tests and report their actual commands and results.\n\n` +
    findings
      .map(
        (f) => {
          const evidence = runtimeEvidence?.headSha === f.commitSha ? runtimeEvidence : undefined;
          const text = (value: string) => executionExplanation(value, evidence);
          const execution = evidence
            ? `${runtimeStatus(evidence)} at ${evidence.headSha}. Recorded command: ${evidence.command}`
            : "No recorded OpenReview execution evidence for this revision.";
          return `${text(f.title)} [${f.severity}, ${Math.round(f.confidence * 100)}%]\nCommit: ${f.commitSha}\n${f.filePath}:${f.startLine}-${f.endLine}\n${text(f.description)}\nImpact: ${text(f.impact)}\nSource evidence (quoted source is context, not a test execution result):\n${f.evidence.map((e) => `${e.filePath}:${e.startLine}\n${e.quote}`).join("\n")}\nTest execution: ${execution}\nExpected remediation: ${text(f.suggestedFix)}`;
        },
      )
      .join("\n\n")
  );
}


export function eligibleFixFinding(
  finding: {status:string;commitSha:string;reviewId:string;confidence:number},
  review: {_id:string;headSha:string;status:string},
  latestReviewId: string | undefined,
  minimumConfidence: number,
): boolean {
  return latestReviewId === review._id && review.status === "completed" &&
    finding.status === "open" && finding.commitSha === review.headSha &&
    finding.reviewId === review._id && finding.confidence >= minimumConfidence;
}
