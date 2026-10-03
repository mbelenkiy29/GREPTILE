import { Badge, ConfidencePill, humanize, StatusPill } from "@/components/ui/Badge";
import { CodeBlock, DiffView } from "@/components/ui/Code";
import { Icon } from "@/components/ui/icons";
import { Markdown, renderInline } from "@/components/ui/Markdown";
import type { ExampleFinding } from "@/lib/marketing/content";

/**
 * An illustrative finding on the landing page (R5.1), drawn with the same finding card styles and safe Markdown
 * renderer the dashboard uses. Always labeled "Example": these are written for a fictional repository, not taken
 * from a customer or a real run.
 */
export function ExampleFindingCard({ finding: f }: { finding: ExampleFinding }) {
  const where = f.endLine > f.startLine ? `${f.path}:${f.startLine}–${f.endLine}` : `${f.path}:${f.startLine}`;
  const titleId = `example-${f.id}-title`;
  return (
    <article className="finding example-finding" data-severity={f.severity} data-example="" aria-labelledby={titleId}>
      <div className="row-tight">
        <Badge tone="outline" mono>
          Example
        </Badge>
        <StatusPill kind="severity" value={f.severity} />
        <ConfidencePill value={f.confidence} />
        <Badge tone="outline">{humanize(f.category)}</Badge>
      </div>
      <h3 className="finding-title" id={titleId}>
        {renderInline(f.title, `t-${f.id}`)}
      </h3>
      <p className="dim mono break">{where}</p>
      {f.rule && (
        <p className="dim">
          <Icon name="rules" size={12} /> Rule: {f.rule}
        </p>
      )}
      <Markdown source={f.description} headingOffset={3} />
      <Markdown source={`**Why it matters:** ${f.impact}`} />
      {f.evidence && (
        <div className="stack-sm">
          <span className="eyebrow">Evidence</span>
          <p className="dim">{f.evidence.note}</p>
          <CodeBlock code={f.evidence.snippet} startLine={f.evidence.startLine} title={`${f.evidence.path}:${f.evidence.startLine}`} id={`example-ev-${f.id}`} copy={false} />
        </div>
      )}
      {f.suggestion && (
        <div className="stack-sm">
          <span className="eyebrow">Suggested change</span>
          <DiffView diff={f.suggestion} title={f.path} id={`example-diff-${f.id}`} />
        </div>
      )}
    </article>
  );
}
