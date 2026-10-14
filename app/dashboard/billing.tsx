import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { buyCredits, openBillingPortal, setSpendingCap, startCheckout } from "./actions";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
// Settings → Billing: plan, quota usage, seats, and Stripe Checkout / Customer Portal (cloud only).
export async function BillingPanel({ token, organizationId, filters }: { token: string; organizationId: Id<"organizations">; filters: Record<string, string | undefined> }) {
  const s = await backend().query(api.billing.status, { token, organizationId });
  if (!s.enabled) return <section><h2>Billing is off</h2><p>This deployment does not bill workspaces (<code>BILLING_ENABLED</code> is not set), so reviews have no plan quota. Self-hosted installs are unlimited.</p></section>;
  const subscribed = s.plan === "team";
  return <>
    {filters.checkout === "success" && <p role="status">Thanks! Your subscription will appear here once Stripe confirms it.</p>}
    {filters.checkout === "cancelled" && <p role="status">Checkout was cancelled; nothing was charged.</p>}
    {filters.credits === "success" && <p role="status">Thanks! Your credits will appear here once Stripe confirms the payment.</p>}
    {filters.billing === "error" && <p role="alert">Billing could not be opened. Check that you are a workspace admin and try again.</p>}
    {!s.allowed && <p role="alert">{s.reason}</p>}
    <section aria-labelledby="plan-heading">
      <h2 id="plan-heading">{subscribed ? "Team plan" : s.plan === "free" ? "Free plan" : "Free trial"}</h2>
      <dl className="facts">
        <dt>Status</dt><dd><span className={`badge ${s.status}`}>{s.status.replaceAll("_", " ")}</span></dd>
        {!subscribed && s.plan !== "free" && <><dt>Trial ends</dt><dd>{day(s.trialEndsAt)}</dd></>}
        {s.currentPeriodEnd && <><dt>Current period ends</dt><dd>{day(s.currentPeriodEnd)}</dd></>}
        {s.pastDueSince && <><dt>Past due since</dt><dd>{day(s.pastDueSince)} · reviews pause after {s.graceDays} days</dd></>}
        <dt>Credits this month</dt><dd>{s.used} of {s.limit ?? "unlimited"} included{s.blocked ? ` · ${s.blocked} reviews blocked` : ""} · a review costs {s.credits.perReview}, a review with generated tests {s.credits.perGeneratedTestReview}</dd>
        <dt>Extra credits</dt><dd>{s.credits.extra} available (used after the included credits; they do not expire)</dd>
        {subscribed && <><dt>Overage</dt><dd>{s.credits.capUsd > 0 ? `${s.credits.overageCredits} credits · $${s.credits.overageUsd.toFixed(2)} of a $${s.credits.capUsd.toFixed(2)} monthly cap ($${s.credits.creditUsd.toFixed(2)} per credit)` : "Off: reviews pause when included and extra credits run out"}</dd></>}
        {s.credits.free > 0 && <><dt>Free plan</dt><dd>{s.credits.free} credits a month for up to {s.credits.freeSeats} developer{s.credits.freeSeats === 1 ? "" : "s"} after the trial</dd></>}
        <dt>Seats</dt><dd>{s.activeSeats} active (owners, admins and members; viewers are free){s.billedSeats !== null ? ` · ${s.billedSeats} billed` : ""} · {s.credits.perSeat} credits per seat each month</dd>
      </dl>
      {s.admin ? <div className="row">
        {!subscribed && <form action={startCheckout}><input type="hidden" name="organizationId" value={organizationId} /><button className="primary">Subscribe with Stripe</button></form>}
        {s.hasCustomer && <form action={openBillingPortal}><input type="hidden" name="organizationId" value={organizationId} /><button>Manage billing</button></form>}
      </div> : <p className="muted">Only workspace owners and admins can change billing.</p>}
      {s.admin && s.credits.packs && <form action={buyCredits} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId} /><label>Buy credits<input type="number" name="credits" min={10} max={100000} step={10} defaultValue={100} required /></label><button>Buy with Stripe</button></form>}
      {s.admin && subscribed && <form action={setSpendingCap} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId} /><label>Monthly overage cap (USD, 0 = off)<input type="number" name="capUsd" min={0} max={1000000} step="0.01" defaultValue={s.credits.capUsd} required /></label><button>Save cap</button><span className="muted">Reviews pause when the cap is reached; admins get email and Slack notices at 80% and 100%.</span></form>}
    </section>
  </>;
}
