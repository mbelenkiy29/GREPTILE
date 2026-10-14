# Billing (cloud mode)

Billing is for hosted deployments only. With `BILLING_ENABLED` unset (the self-host default), reviews have no quota, the Stripe webhook endpoint returns 404, and the billing page says billing is off.

## Plans

- **Trial:** a workspace starts on a free trial of `BILLING_TRIAL_DAYS` days (default 14), counted from workspace creation. It includes `BILLING_TRIAL_REVIEWS` reviews per calendar month (UTC, default 200).
- **Team (per seat):** a Stripe subscription whose quantity is the number of active seats. Owners, admins and members are seats; viewers are free. The monthly quota is seats × `BILLING_REVIEWS_PER_SEAT` (default 100).
- **Seat changes:** accepting an invitation or changing a member's role resyncs the subscription quantity, with prorations.
- **Past due:** reviews continue for `BILLING_GRACE_DAYS` (default 7) after the first failed payment, then pause until an invoice is paid.
- **Cancelled:** the workspace falls back to any remaining trial.

## Credits, free plan and spending cap

Quotas are counted in credits. With the defaults, one review costs one credit and the limits match the review counts above.

- **Cost per review kind:** a review costs `BILLING_CREDITS_REVIEW` (default 1). A review that also gets generated reproduction tests costs `BILLING_CREDITS_GENERATED_TESTS` in total (default 3). The difference is charged when the tests job is requested. If no credits are left, the review is published without generated tests.
- **Included credits:** the trial includes `BILLING_TRIAL_CREDITS` (defaults to `BILLING_TRIAL_REVIEWS`). The team plan includes seats × `BILLING_CREDITS_PER_SEAT` (defaults to `BILLING_REVIEWS_PER_SEAT`).
- **Extra credits:** admins can buy credit packs from Settings → Billing, which is a one-time Stripe Checkout for `STRIPE_CREDITS_PRICE_ID` where one unit is one credit.
  - Credits are added when Stripe's signed `checkout.session.completed` event reports `payment_status: paid`, once per event.
  - Extra credits do not expire, and they are used after the month's included credits.
- **Free plan:** off by default. With `BILLING_FREE_CREDITS` above 0, a workspace with at most `BILLING_FREE_SEATS` billed seats (default 1) keeps that many credits a month after the trial ends. Larger workspaces need a subscription.
- **Spending cap (team plan):** admins set a monthly overage cap in dollars on Settings → Billing. The default is 0, which means no overage.
  - Once the included and extra credits are used up, each further credit costs `BILLING_OVERAGE_CREDIT_USD` (default $0.50) and is reported to Stripe as a meter event on `STRIPE_METER_EVENT`.
  - When the cap would be exceeded, reviews pause with a `Billing:` reason until the next month, or until an admin raises the cap.
  - Admins with a verified notification email, and the linked Slack channels, are told once per month at 80% and at 100% of the cap.
- **Reporting to Stripe:** meter events use our event ID as Stripe's `identifier`, so a retried report is not counted twice. Failed reports retry with backoff, up to five attempts.

When a review is blocked, it is recorded as failed with a `Billing:` reason, visible on the pull request's review page. Blocked reviews are also counted on **Settings → Billing**.

## Setup (operator)

1. In Stripe test mode, create a product with a recurring per-unit price. Set its ID as `STRIPE_SEAT_PRICE_ID`.
2. Add a webhook endpoint `https://<convex-site>/stripe/webhook` for these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` and `invoice.paid`. Set its signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Set `STRIPE_SECRET_KEY` (`sk_test_…`) and `BILLING_ENABLED=true` on Convex. Live keys are refused unless `BILLING_ALLOW_LIVE=true`.
4. Turn on the Customer Portal in Stripe so admins can manage their payment method, invoices and cancellation.
5. For extra credits, create a one-time price of one credit and set `STRIPE_CREDITS_PRICE_ID`.
6. For capped overage, create a billing meter with event name `openreview_credits` (or set `STRIPE_METER_EVENT`), using the default `stripe_customer_id` and `value` payload keys and sum aggregation. Add a metered price on it to the seat subscription's product, and set `BILLING_OVERAGE_CREDIT_USD` to the same per-credit price.

On Vercel, Stripe can also be provisioned from the Vercel Marketplace. The keys still belong in the Convex environment, because Convex runs Checkout, the portal and webhook handling.

## Guarantees

- **Signatures:** webhooks are verified against the `Stripe-Signature` header with a five-minute tolerance.
- **Duplicates:** each event ID is applied at most once.
- **Ordering:** subscription events older than the last one applied are recorded as `stale` and ignored, so redelivery and reordering cannot roll state back.
- **Workspace linking:** Checkout sets both `client_reference_id` and subscription metadata. A subscription that claims a different workspace than its customer's is ignored.
