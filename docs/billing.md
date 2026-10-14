# Billing (cloud mode)

Billing is for hosted deployments only. With `BILLING_ENABLED` unset (the self-host default), reviews have no quota, the Stripe webhook endpoint returns 404, and the billing page says billing is off.

## Plans

- **Trial:** a workspace starts on a free trial of `BILLING_TRIAL_DAYS` days (default 14), counted from workspace creation. It includes `BILLING_TRIAL_REVIEWS` reviews per calendar month (UTC, default 200).
- **Team (per seat):** a Stripe subscription whose quantity is the number of active seats. Owners, admins and members are seats; viewers are free. The monthly quota is seats × `BILLING_REVIEWS_PER_SEAT` (default 100).
- **Seat changes:** accepting an invitation or changing a member's role resyncs the subscription quantity, with prorations.
- **Past due:** reviews continue for `BILLING_GRACE_DAYS` (default 7) after the first failed payment, then pause until an invoice is paid.
- **Cancelled:** the workspace falls back to any remaining trial.

When a review is blocked, it is recorded as failed with a `Billing:` reason, visible on the pull request's review page. Blocked reviews are also counted on **Settings → Billing**.

## Setup (operator)

1. In Stripe test mode, create a product with a recurring per-unit price. Set its ID as `STRIPE_SEAT_PRICE_ID`.
2. Add a webhook endpoint `https://<convex-site>/stripe/webhook` for these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` and `invoice.paid`. Set its signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Set `STRIPE_SECRET_KEY` (`sk_test_…`) and `BILLING_ENABLED=true` on Convex. Live keys are refused unless `BILLING_ALLOW_LIVE=true`.
4. Turn on the Customer Portal in Stripe so admins can manage their payment method, invoices and cancellation.

On Vercel, Stripe can also be provisioned from the Vercel Marketplace. The keys still belong in the Convex environment, because Convex runs Checkout, the portal and webhook handling.

## Guarantees

- **Signatures:** webhooks are verified against the `Stripe-Signature` header with a five-minute tolerance.
- **Duplicates:** each event ID is applied at most once.
- **Ordering:** subscription events older than the last one applied are recorded as `stale` and ignored, so redelivery and reordering cannot roll state back.
- **Workspace linking:** Checkout sets both `client_reference_id` and subscription metadata. A subscription that claims a different workspace than its customer's is ignored.
