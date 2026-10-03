import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, StatusPill } from "@/components/ui/Badge";
import { RULE_CATEGORY_LABEL, ruleDisplayTitle, type RuleCategory, type RuleSeverity } from "@/lib/rules/catalog";

export interface RuleCardItem {
  id: number;
  title: string;
  text: string;
  category: RuleCategory;
  severity: RuleSeverity;
  enabled: boolean;
  instructions: string;
  paths: string[];
  status: "active" | "candidate" | "rejected";
  source: string;
  repoFullName: string | null;
  rationale: string | null;
  evidence: { commentId: number; author: string; excerpt: string }[] | null;
  /** Published findings that cite the rule. */
  findings?: number;
}

const SOURCE_LABEL: Record<string, string> = { dashboard: "written in the dashboard", mined: "suggested from reviewer comments", template: "from a template", api: "from the API" };

/**
 * One rule (R6.11): title, text, category, severity, scope, path globs, state, instructions, mined evidence (R2.5),
 * and how many findings cite it. `actions` renders the controls the viewer may use.
 */
export function RuleCard({ rule: r, actions }: { rule: RuleCardItem; actions?: ReactNode }) {
  const titleId = `rule-${r.id}-title`;
  return (
    <article className="comment" data-rule={r.id} data-enabled={r.enabled} data-status={r.status} aria-labelledby={titleId}>
      <div className="rule-card-head">
        <h3 id={titleId} className="strong" style={{ fontSize: "var(--text-md)", margin: 0 }}>
          {ruleDisplayTitle(r)}
        </h3>
        <span className="spacer" />
        {r.status === "candidate" && <Badge tone="info">Suggested</Badge>}
        {r.status === "rejected" && <Badge tone="muted">Dismissed</Badge>}
        {r.status === "active" && (r.enabled ? <Badge tone="ok" dot>On</Badge> : <Badge tone="muted">Off</Badge>)}
      </div>
      <div className="row-tight">
        <StatusPill kind="severity" value={r.severity} />
        <Badge tone="outline">{RULE_CATEGORY_LABEL[r.category]}</Badge>
        <Badge tone="muted">{r.repoFullName ?? "All repositories"}</Badge>
        {r.paths.length > 0 ? <span className="mono dim break">{r.paths.join(", ")}</span> : <span className="dim">all files</span>}
      </div>
      <p>{r.text}</p>
      {r.instructions.trim() && (
        <details className="disclosure">
          <summary>Instructions</summary>
          <div className="disclosure-body">
            <p>{r.instructions}</p>
          </div>
        </details>
      )}
      {r.rationale && <p className="dim">{r.rationale}</p>}
      {r.evidence && r.evidence.length > 0 && (
        <div className="stack-sm">
          <span className="eyebrow">Evidence from your reviewers</span>
          <ul className="dim">
            {r.evidence.map((e) => (
              <li key={e.commentId}>
                @{e.author}: “{e.excerpt}”
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="row-tight dim">
        <span className="mono">rule:{r.id}</span>
        <span>· {SOURCE_LABEL[r.source] ?? r.source}</span>
        {r.findings !== undefined && (
          <>
            <span>·</span>
            <Link href={`/dashboard/findings?rule=${encodeURIComponent(`rule:${r.id}`)}`}>
              {r.findings} finding{r.findings === 1 ? "" : "s"} from this rule
            </Link>
          </>
        )}
      </div>
      {actions && <div className="row actions">{actions}</div>}
    </article>
  );
}
