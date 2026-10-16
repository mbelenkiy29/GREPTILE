# Billing (cloud mode)

Billing is for hosted deployments only. With `BILLING_ENABLED` unset (the self-host default), reviews have no quota, the Stripe webhook endpoint returns 404, and the billing page says billing is off.

## Plans

- **Trial:** a workspace gets a free trial of `BILLING_TRIAL_DAYS` days (default 14). The trial clock starts at the workspace's first review or first Checkout, not at workspace creation, so workspaces created before billing was turned on still get the full trial. It includes `BILLING_TRIAL_REVIEWS` reviews per calendar month (UTC, default 200).
- **Starter (per seat):**
  - A Stripe subscription whose quantity is the number of active seats. Owners, admins and members are seats; viewers are free.
  - Reviews are unlimited under a monthly fair-use limit of seats × `BILLING_REVIEWS_PER_SEAT` (default 500).
  - The landing page, the setup plan step and Settings → Billing show `BILLING_SEAT_PRICE_LABEL` (for example `$12 per seat / month`). Set it on the web app and keep it in sync with the Stripe price.
- **Seat changes:** accepting an invitation or changing a member's role resyncs the subscription quantity, with prorations.
- **Past due:** reviews continue for `BILLING_GRACE_DAYS` (default 7) after the first failed payment, then pause until an invoice is paid.
- **Cancelled:** the workspace falls back to any remaining trial.

Higher tiers (Pro, Business) are planned in [roadmap/pricing-tiers.md](roadmap/pricing-tiers.md).

## Choosing a plan during setup

When billing is on, guided setup adds a **Choose your plan** step after inviting the team. It shows the Starter plan, the seat count and the trial, and offers two choices:
- **Add payment method:** opens Stripe Checkout and returns to the step.
- **Continue on the trial:** subscribe later in Settings → Billing.

Checkout carries any remaining trial into the subscription (`subscription_data.trial_end`), so the card is not charged until the trial ends. Stripe requires a trial end at least 48 hours away, so a trial with less time left is charged at Checkout. Without billing, the step does not exist and setup has one step fewer.

When a review is blocked, it is recorded as failed with a `Billing:` reason, visible on the pull request's review page. Blocked reviews are also counted on **Settings → Billing**.

## Setup (operator)

1. **Sandbox:** use a Stripe sandbox (or test mode) for setup and testing.
2. **Product and price:** create the Product "OpenReview Starter" with a recurring, per-unit monthly price. Set its ID as `STRIPE_SEAT_PRICE_ID`. Each future tier gets its own Product.
3. **Webhook:** add the endpoint `https://<convex-site>/stripe/webhook` on API version `2026-08-26.dahlia` (`STRIPE_API_VERSION` in `src/billing.ts`) for these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`
   - `invoice.payment_failed` and `invoice.paid`

   Set its signing secret as `STRIPE_WEBHOOK_SECRET`.
4. **API key:** create a restricted key (`rk_test_…`) with write access to Customers, Checkout Sessions, Customer portal and Subscriptions. Set it as `STRIPE_SECRET_KEY` on Convex (a `sk_test_…` key also works).
5. **Turn on billing:** set `BILLING_ENABLED=true` on Convex, and on the web app so the landing page shows pricing and the setup step count is right. Live keys (`rk_live_…`/`sk_live_…`) are refused unless `BILLING_ALLOW_LIVE=true`.
6. **Customer Portal:** turn it on in Stripe so admins can manage their payment method, invoices and cancellation. Turn off quantity changes, because seats follow workspace membership.
7. **Tax:** turn on Stripe Tax only after you have an active tax registration; until then Stripe collects no tax.

On Vercel, Stripe can also be provisioned from the Vercel Marketplace. The keys still belong in the Convex environment, because Convex runs Checkout, the portal and webhook handling.

## Switching from test to live

1. **Activate payments** on the Stripe account (business details and bank account) and fill in **Settings → Public details**: business name, support email and statement descriptor. Then, in live mode, create the same Product and Price, webhook endpoint (same events and API version) and portal configuration as in test mode, with the site's `/privacy` and `/terms` links in the portal.
2. **Live keys:** create a live restricted key (`rk_live_…`) with the same permissions. Set it as `STRIPE_SECRET_KEY`, and the live endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`.
3. **Convex settings:** set `STRIPE_SEAT_PRICE_ID` to the live price and `BILLING_ALLOW_LIVE=true`.
4. **Drop test links:** test customers and subscriptions do not exist in live mode, so every workspace must drop its Stripe links. Run this once:
   ```bash
   npx convex run billing:forgetStripeLinks '{"confirm":"switch-stripe-mode"}' --prod
   ```
   Each workspace returns to its trial with the same end date, and its next Checkout creates a live customer.
5. **Old webhook:** cancel the test subscriptions and disable the test-mode webhook endpoint, so the sandbox stops sending events (and retries) that would now fail signature checks.

## Guarantees

- **API version:** requests pin `Stripe-Version`. Invoice events are read from both the current shape (`parent.subscription_details.subscription`) and the older one (`subscription`).

- **Signatures:** webhooks are verified against the `Stripe-Signature` header with a five-minute tolerance.
- **Duplicates:** each event ID is applied at most once.
- **Ordering:** subscription events older than the last one applied are recorded as `stale` and ignored, so redelivery and reordering cannot roll state back.
- **Workspace linking:** Checkout sets both `client_reference_id` and subscription metadata. A subscription that claims a different workspace than its customer's is ignored.
