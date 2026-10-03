import type { ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/Chart";
import { CopyButton } from "@/components/ui/CopyButton";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { UsageMeter } from "@/lib/billing/alerts";
import type { UsageSettings } from "@/lib/billing/settings";
import type { AlertHistoryItem, BillingView } from "@/lib/billing/view";
import { formatCount, formatDate, formatUsd } from "@/lib/ui/format";

type Action = (formData: FormData) => void | Promise<void>;

const lastDay = (d: Date) => formatDate(new Date(d.getTime() - 1));

function PlanCard({ billing, canBill, actions }: { billing: BillingView; canBill: boolean; actions: { checkout: Action; portal: Action } }) {
  if (!billing.enabled) {
    return (
      <Card title="Plan" titleId="plan-heading">
        <div className="stack-sm" data-billing="self-hosted">
          <p>
            <strong>Self-hosted: unlimited.</strong> This instance has no billing configured, so every developer and review is included. Model costs
            are whatever your LLM provider charges; use the caps below to bound them.
          </p>
        </div>
      </Card>
    );
  }
  const { plan } = billing;
  const team = plan.id === "team";
  const included = billing.includedCredits;
  const footer = canBill ? (
    <div className="row-tight">
      {team ? (
        <form action={actions.portal}>
          <SubmitButton variant="primary" pendingLabel="Opening…">
            Manage billing
          </SubmitButton>
        </form>
      ) : (
        <form action={actions.checkout}>
          <SubmitButton variant="primary" pendingLabel="Opening checkout…">
            {`Upgrade to ${billing.offered.find((p) => p.id === "team")?.name ?? "Team"}`}
          </SubmitButton>
        </form>
      )}
      {!team && billing.hasCustomer && (
        <form action={actions.portal}>
          <SubmitButton variant="ghost" pendingLabel="Opening…">
            Invoices and payment methods
          </SubmitButton>
        </form>
      )}
    </div>
  ) : (
    <p className="dim">Only owners can change the plan.</p>
  );
  return (
    <Card title="Plan" titleId="plan-heading" footer={footer}>
      <div className="stack-md" data-billing={plan.id}>
        <div className="row-tight">
          <strong>{plan.name}</strong>
          <Badge tone={team ? "ok" : "muted"} dot>
            {team ? billing.status.replace(/_/g, " ") : "free"}
          </Badge>
          {team && <span className="dim">{`${billing.seats} seat${billing.seats === 1 ? "" : "s"} × ${formatUsd(plan.priceUsd)} / month`}</span>}
        </div>
        <p className="dim">{plan.tagline}</p>
        {billing.paymentFailedAt && (
          <Alert tone="error" title="Payment failed">
            <p>The last invoice payment failed on {formatDate(billing.paymentFailedAt)}. Update the payment method under Manage billing.</p>
          </Alert>
        )}
        {billing.cancelAt && <p className="dim">The subscription ends on {formatDate(billing.cancelAt)}.</p>}
        <div className="stack-sm">
          <span>
            Credits this period ({formatDate(billing.period.start)} – {lastDay(billing.period.end)}):{" "}
            <strong>{formatCount(billing.creditsUsed)}</strong>
            {included !== null ? ` of ${formatCount(included)} included` : ""}
          </span>
          {included !== null && <ProgressBar value={included > 0 ? billing.creditsUsed / included : 1} label="Included credits used" />}
          {team && plan.overagePriceUsd !== null && billing.creditsUsed > (included ?? 0) && (
            <span className="dim">{`${formatCount(billing.creditsUsed - (included ?? 0))} overage credits × ${formatUsd(plan.overagePriceUsd)}`}</span>
          )}
          <span>
            Active developers this period: <strong>{formatCount(billing.activeDevelopers)}</strong>
            {plan.activeDeveloperLimit !== null ? ` of ${plan.activeDeveloperLimit}` : ""}
            {team && billing.activeDevelopers > billing.seats ? " (seats grow to match within the hour)" : ""}
          </span>
        </div>
      </div>
    </Card>
  );
}

function Meters({ meters }: { meters: UsageMeter[] }) {
  if (!meters.length) return <p className="dim">No caps are set, so nothing stops or alerts on usage.</p>;
  return (
    <div className="stack-sm" data-usage-meters="">
      {meters.map((m) => {
        const fmt = (v: number) => (m.metric === "cost" ? formatUsd(v) : `${formatCount(v)} credits`);
        return (
          <div key={m.metric} className="stack-sm" style={{ gap: 4 }}>
            <span>
              {m.label}: <strong>{fmt(m.value)}</strong> of {fmt(m.limit)}
            </span>
            <ProgressBar value={Number.isFinite(m.ratio) ? m.ratio : 1} label={m.label} />
          </div>
        );
      })}
    </div>
  );
}

/** Settings → Usage & billing (R4.3, R4.2): plan and seats, caps and alerts, and the alert webhook's signing secret. */
export function BillingSettingsView({
  billing,
  settings,
  meters,
  alerts,
  secret,
  canManage,
  canBill,
  limitsForm,
  actions,
}: {
  billing: BillingView;
  settings: UsageSettings;
  meters: UsageMeter[];
  alerts: AlertHistoryItem[];
  /** The alert webhook signing secret (only passed to people who manage settings). */
  secret: string | null;
  canManage: boolean;
  canBill: boolean;
  /** The editable caps form (a client component), for people who manage settings. */
  limitsForm: ReactNode;
  actions: { checkout: Action; portal: Action; rotateSecret: Action };
}) {
  return (
    <div className="stack" data-testid="usage-billing">
      <PlanCard billing={billing} canBill={canBill} actions={actions} />
      <Card title="Caps and alerts" titleId="caps-heading" description="Limits apply per usage period (the billing period, or the calendar month in UTC).">
        <div className="stack-md">
          <Meters meters={meters} />
          {canManage ? (
            limitsForm
          ) : (
            <dl className="stack-sm" data-usage-settings="readonly">
              <div>
                <dt className="dim">Credit cap</dt>
                <dd>{settings.monthlyCreditCap === null ? "None" : `${formatCount(settings.monthlyCreditCap)} credits`}</dd>
              </div>
              <div>
                <dt className="dim">Model cost cap</dt>
                <dd>{settings.monthlyCostCapUsd === null ? "None" : formatUsd(settings.monthlyCostCapUsd)}</dd>
              </div>
              <div>
                <dt className="dim">Alert thresholds</dt>
                <dd>{settings.alertThresholds.length ? settings.alertThresholds.map((t) => `${t}%`).join(", ") : "Off"}</dd>
              </div>
              <div>
                <dt className="dim">Alert webhook</dt>
                <dd>{settings.alertWebhookUrl ? "Configured" : "None"}</dd>
              </div>
              <p className="dim">Only owners and admins can change caps and alerts.</p>
            </dl>
          )}
        </div>
      </Card>
      {canManage && settings.alertWebhookUrl && secret && (
        <Card
          title="Alert webhook signature"
          titleId="secret-heading"
          description="Verify that alerts come from OpenReview before acting on them."
          footer={
            <form action={actions.rotateSecret}>
              <SubmitButton variant="danger" size="sm" pendingLabel="Replacing…">
                Replace secret
              </SubmitButton>
            </form>
          }
        >
          <div className="stack-sm">
            <p>
              Each alert is a JSON <span className="mono">POST</span> with <span className="mono">x-openreview-timestamp</span> and{" "}
              <span className="mono">x-openreview-signature: sha256=&lt;hex&gt;</span>, the HMAC-SHA256 of{" "}
              <span className="mono">&lt;timestamp&gt;.&lt;raw body&gt;</span> with this secret.
            </p>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input className="input mono" readOnly value={secret} aria-label="Alert webhook signing secret" style={{ minWidth: 0 }} />
              <CopyButton value={secret} label="Copy secret" />
            </div>
          </div>
        </Card>
      )}
      <Card title="Recent alerts" titleId="alerts-heading" description="Thresholds crossed in the last 90 days.">
        {alerts.length ? (
          <ul className="stack-sm" data-usage-alerts="">
            {alerts.map((a) => (
              <li key={a.id}>
                <strong>{a.metric === "cost" ? "Model cost cap" : a.metric === "credits" ? "Credit cap" : "Included credits"}</strong> reached {a.threshold}% on{" "}
                {formatDate(a.createdAt)}
                {a.deliveredAt ? " · webhook delivered" : a.error ? ` · webhook failed: ${a.error}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="dim">No alerts yet.</p>
        )}
      </Card>
    </div>
  );
}
