import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { checkoutTrialEnd } from "../../src/billing";
import { openBillingPortal, startCheckout } from "./actions";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" });
// Settings → Billing: plan, quota usage, seats, and Stripe Checkout / Customer Portal (cloud only).
export async function BillingPanel({ token, organizationId, filters }: { token: string; organizationId: Id<"organizations">; filters: Record<string, string | undefined> }) {
  const s = await backend().query(api.billing.status, { token, organizationId });
  if (!s.enabled) return <section><h2>Billing is off</h2><p>This deployment does not bill workspaces (<code>BILLING_ENABLED</code> is not set), so reviews have no plan quota. Self-hosted installs are unlimited.</p></section>;
  const subscribed = s.plan === "starter", price = process.env.BILLING_SEAT_PRICE_LABEL;
  return <>
    {filters.checkout === "success" && <p role="status">Thanks! Your subscription will appear here once Stripe confirms it.</p>}
    {filters.checkout === "cancelled" && <p role="status">Checkout was cancelled; nothing was charged.</p>}
    {filters.billing === "error" && <p role="alert">Billing could not be opened. Check that you are a workspace admin and try again.</p>}
    {!s.allowed && <p role="alert">{s.reason}</p>}
    <section aria-labelledby="plan-heading">
      <h2 id="plan-heading">{subscribed ? "Starter plan" : "Free trial"}</h2>
      <dl className="facts">
        <dt>Status</dt><dd><span className={`badge ${s.status}`}>{s.status.replaceAll("_", " ")}</span></dd>
        {!subscribed && <><dt>Trial ends</dt><dd>{s.trialStarted ? day(s.trialEndsAt) : `${s.trialDays} days after the first review`}</dd></>}
        {s.currentPeriodEnd && <><dt>Current period ends</dt><dd>{day(s.currentPeriodEnd)}</dd></>}
        {s.pastDueSince && <><dt>Past due since</dt><dd>{day(s.pastDueSince)} · reviews pause after {s.graceDays} days</dd></>}
        <dt>Reviews this month</dt><dd>{subscribed ? `${s.used} · unlimited (fair use: ${s.limit})` : `${s.used} of ${s.limit ?? "unlimited"}`}{s.blocked ? ` · ${s.blocked} blocked` : ""}</dd>
        <dt>Seats</dt><dd>{s.activeSeats} active (owners, admins and members; viewers are free){s.billedSeats !== null ? ` · ${s.billedSeats} billed` : ""}</dd>
        <dt>Starter plan</dt><dd>{price ? `${price} · ` : ""}unlimited reviews, fair use {s.reviewsPerSeat} per seat each month</dd>
      </dl>
      {s.admin ? <div className="row">
        {!subscribed && <form action={startCheckout}><input type="hidden" name="organizationId" value={organizationId} /><button className="primary">{checkoutTrialEnd(s.trialEndsAt, Date.now()) ? "Add payment method" : "Subscribe with Stripe"}</button></form>}
        {s.hasCustomer && <form action={openBillingPortal}><input type="hidden" name="organizationId" value={organizationId} /><button>Manage billing</button></form>}
      </div> : <p className="muted">Only workspace owners and admins can change billing.</p>}
    </section>
  </>;
}
