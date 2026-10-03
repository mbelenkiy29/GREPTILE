import { StatusPill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { RuntimeValidationView } from "@/lib/sandbox/results";
import { formatDuration } from "@/lib/ui/format";

/**
 * Runtime validation of a review run (R4.5): outcome, image and network policy, the failing command and exit code,
 * recognized failing tests, and the captured (capped, redacted) log. Output is rendered as text, never as HTML.
 */
export function RuntimeValidationCard({ validation }: { validation: RuntimeValidationView }) {
  const v = validation;
  return (
    <Card
      title="Runtime validation"
      titleId="runtime-validation-heading"
      description={`${v.image} · ${v.network === "install-only" ? "network for the install step only" : "no network"} · beta`}
      actions={<StatusPill kind="validation" value={v.inProgress ? "running" : v.status} />}
    >
      <div className="stack-md" data-validation-status={v.status}>
        <dl className="facts">
          <div>
            <dt>{v.failedStep ? `Failed step (${v.failedStep})` : "Command"}</dt>
            <dd className="mono break">{v.command ?? "—"}</dd>
          </div>
          <div>
            <dt>Exit code</dt>
            <dd className="mono">{v.exitCode ?? "—"}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{v.inProgress ? "running…" : formatDuration(v.durationMs)}</dd>
          </div>
        </dl>
        {v.reason && <p className={v.status === "error" ? "error-text" : "dim"}>{v.reason}</p>}
        {v.failingTests.length > 0 && (
          <div className="stack-sm">
            <span className="eyebrow">Failing tests</span>
            <ul className="prose" style={{ margin: 0, paddingLeft: "1.2em" }}>
              {v.failingTests.map((t) => (
                <li key={t} className="mono">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.outputExcerpt.trim() && (
          <details className="disclosure" open={v.status === "failed" || v.status === "timeout"}>
            <summary>Log{v.truncated ? " (middle omitted; head and tail kept)" : ""}</summary>
            <div className="disclosure-body">
              <pre className="block" aria-label="Runtime validation log">
                {v.outputExcerpt}
              </pre>
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}
