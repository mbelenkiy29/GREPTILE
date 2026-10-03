import type { ReactNode } from "react";
import { Badge, ConfidencePill, humanize, StatusPill } from "@/components/ui/Badge";
import { CodeBlock } from "@/components/ui/Code";
import { Icon } from "@/components/ui/icons";
import { Markdown } from "@/components/ui/Markdown";
import type { FindingRow } from "@/lib/data/findings";
import { githubBlobUrl, githubCommentUrl } from "@/lib/ui/format";

function location(f: Pick<FindingRow, "path" | "startLine" | "endLine">) {
  return f.endLine > f.startLine ? `${f.path}:${f.startLine}–${f.endLine}` : `${f.path}:${f.startLine}`;
}

/** Why a held-back or rejected finding was not posted, from its verification record. */
export function verificationNote(v: unknown): { stage: string | null; reasons: string[]; heldBack: string | null } {
  const rec = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const reasons = Array.isArray(rec.reasons) ? rec.reasons.filter((r): r is string => typeof r === "string") : [];
  return {
    stage: typeof rec.stage === "string" ? rec.stage : null,
    reasons,
    heldBack: typeof rec.heldBack === "string" ? rec.heldBack : null,
  };
}

/**
 * One published finding (R6.9): severity, confidence, location, status, rule, description, evidence with code,
 * suggested fix, and the GitHub comment that posted it. Model-written text is rendered as safe Markdown.
 */
export function FindingCard({
  finding: f,
  repoFullName,
  prNumber,
  githubUrl,
  actions,
}: {
  finding: FindingRow;
  repoFullName: string;
  prNumber: number;
  githubUrl?: string;
  /** Controls shown at the end of the header row (e.g. "Fix with AI"). */
  actions?: ReactNode;
}) {
  const note = verificationNote(f.verification);
  return (
    <article className="finding" data-finding={f.id} data-severity={f.severity} aria-labelledby={`finding-${f.id}-title`}>
      <div className="row-tight">
        <StatusPill kind="severity" value={f.severity} />
        <ConfidencePill value={f.confidence} />
        <StatusPill kind="finding" value={f.status} />
        <Badge tone="outline">{humanize(f.category)}</Badge>
        {f.visibility === "suppressed" && (
          <Badge tone="warn" title={note.heldBack ?? undefined}>
            Not posted{note.heldBack ? `: ${note.heldBack}` : ""}
          </Badge>
        )}
        {actions && <span style={{ marginLeft: "auto" }}>{actions}</span>}
      </div>
      <h3 className="finding-title" id={`finding-${f.id}-title`}>
        {f.title}
      </h3>
      <div className="row-tight dim">
        <a className="mono break" href={githubBlobUrl(repoFullName, f.commitSha, f.path, f.startLine, githubUrl)} target="_blank" rel="noreferrer">
          {location(f)}
        </a>
        {f.symbol && <span className="mono">· {f.symbol}</span>}
        <span>· raised by {f.agents.length ? f.agents.map(humanize).join(", ") : humanize(f.agent)}</span>
        {f.externalCommentId !== null && (
          <a href={githubCommentUrl(repoFullName, prNumber, f.externalCommentId, githubUrl)} target="_blank" rel="noreferrer">
            <Icon name="github" size={12} /> Comment on GitHub
          </a>
        )}
      </div>
      {(f.ruleId || f.ruleText) && (
        <div className="dim">
          <Icon name="rules" size={12} /> Rule <span className="mono">{f.ruleId}</span>
          {f.ruleText && <>: {f.ruleText}</>}
        </div>
      )}
      {f.description && <Markdown source={f.description} headingOffset={3} />}
      {f.impact && (
        <p>
          <span className="strong">Impact: </span>
          {f.impact}
        </p>
      )}
      {f.evidence.length > 0 && (
        <div className="stack-sm">
          <span className="eyebrow">Evidence</span>
          {f.evidence.map((e, i) => (
            <div key={i} className="stack-sm">
              {e.note && <p className="dim">{e.note}</p>}
              <CodeBlock
                code={e.snippet}
                startLine={e.startLine}
                title={`${e.path}:${e.startLine}${e.endLine > e.startLine ? `–${e.endLine}` : ""}`}
                id={`ev-${f.id}-${i}`}
              />
            </div>
          ))}
        </div>
      )}
      {(f.suggestedFix || f.suggestion) && (
        <div className="stack-sm">
          <span className="eyebrow">Suggested fix</span>
          {f.suggestedFix && <Markdown source={f.suggestedFix} headingOffset={3} />}
          {f.suggestion && <CodeBlock code={f.suggestion} startLine={f.startLine} title={`Suggested change · ${f.path}`} id={`sg-${f.id}`} />}
        </div>
      )}
      {f.status === "resolved" && f.resolvedSha && (
        <p className="dim">
          Resolved{f.resolution === "fixed" ? " by commit" : ""} <span className="mono">{f.resolvedSha.slice(0, 7)}</span>
        </p>
      )}
    </article>
  );
}
