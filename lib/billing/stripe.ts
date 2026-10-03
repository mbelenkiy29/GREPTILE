/**
 * The Stripe surface OpenReview uses (R4.2), behind a small interface so billing logic is tested with a fake client
 * and no Stripe code path runs when billing is off: {@link stripeApi} is only ever called with a configuration whose
 * Stripe keys are set. Webhook signatures are verified with the official SDK's verifier ({@link verifyStripeEvent}).
 */
import Stripe from "stripe";
import { z } from "zod";
import type { BillingConfig } from "./plans";

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  /** Unix seconds; null when not scheduled to cancel. */
  cancel_at: number | null;
  metadata: Record<string, string>;
  items: { data: { id: string; price: { id: string }; quantity?: number | null; current_period_start: number; current_period_end: number }[] };
}

export interface CheckoutSessionParams {
  mode: "subscription";
  customer: string;
  client_reference_id: string;
  line_items: { price: string; quantity?: number }[];
  success_url: string;
  cancel_url: string;
  subscription_data: { metadata: Record<string, string> };
  metadata: Record<string, string>;
}

export interface StripeApi {
  createCustomer(params: { name: string; email?: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  createCheckoutSession(params: CheckoutSessionParams, idempotencyKey: string): Promise<{ id: string; url: string | null }>;
  createPortalSession(params: { customer: string; return_url: string }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<StripeSubscription>;
  /** Changes a subscription item's quantity (seats), prorated. */
  updateSubscriptionItemQuantity(itemId: string, quantity: number, idempotencyKey: string): Promise<void>;
  /** The billing meter event name behind a metered price. */
  meterEventName(priceId: string): Promise<string>;
  createMeterEvent(params: { event_name: string; payload: Record<string, string>; identifier: string; timestamp: number }): Promise<void>;
}

export class BillingDisabledError extends Error {
  constructor() {
    super("Stripe billing is not configured on this instance.");
    this.name = "BillingDisabledError";
  }
}

function subscriptionOf(s: Stripe.Subscription): StripeSubscription {
  return {
    id: s.id,
    customer: typeof s.customer === "string" ? s.customer : s.customer.id,
    status: s.status,
    cancel_at: s.cancel_at,
    metadata: { ...s.metadata },
    items: {
      data: s.items.data.map((i) => ({
        id: i.id,
        price: { id: i.price.id },
        quantity: i.quantity ?? null,
        current_period_start: i.current_period_start,
        current_period_end: i.current_period_end,
      })),
    },
  };
}

/** The real client. Throws {@link BillingDisabledError} unless Stripe is configured. */
export function stripeApi(cfg: BillingConfig): StripeApi {
  if (!cfg.stripe) throw new BillingDisabledError();
  const stripe = new Stripe(cfg.stripe.secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "OpenReview" } });
  const meterNames = new Map<string, string>();
  return {
    async createCustomer(params, idempotencyKey) {
      const c = await stripe.customers.create(params, { idempotencyKey });
      return { id: c.id };
    },
    async createCheckoutSession(params, idempotencyKey) {
      const s = await stripe.checkout.sessions.create(params, { idempotencyKey });
      return { id: s.id, url: s.url };
    },
    async createPortalSession(params) {
      const s = await stripe.billingPortal.sessions.create(params);
      return { url: s.url };
    },
    async retrieveSubscription(id) {
      return subscriptionOf(await stripe.subscriptions.retrieve(id));
    },
    async updateSubscriptionItemQuantity(itemId, quantity, idempotencyKey) {
      await stripe.subscriptionItems.update(itemId, { quantity, proration_behavior: "create_prorations" }, { idempotencyKey });
    },
    async meterEventName(priceId) {
      const cached = meterNames.get(priceId);
      if (cached) return cached;
      const price = await stripe.prices.retrieve(priceId);
      const meterId = price.recurring?.meter;
      if (!meterId) throw new Error(`Stripe price ${priceId} (STRIPE_PRICE_OVERAGE) is not a metered price attached to a billing meter`);
      const meter = await stripe.billing.meters.retrieve(meterId);
      meterNames.set(priceId, meter.event_name);
      return meter.event_name;
    },
    async createMeterEvent(params) {
      await stripe.billing.meterEvents.create(params);
    },
  };
}

// ---- webhook events

const stripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  /** Unix seconds. */
  created: z.number(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type StripeEvent = z.infer<typeof stripeEventSchema>;

const idOf = z.union([z.string(), z.object({ id: z.string() }).transform((o) => o.id)]);

export const subscriptionObject = z.object({
  id: z.string(),
  customer: idOf,
  status: z.string(),
  cancel_at: z.number().nullish().transform((v) => v ?? null),
  metadata: z.record(z.string(), z.string()).nullish().transform((v) => v ?? {}),
  items: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        price: z.object({ id: z.string() }),
        quantity: z.number().nullish(),
        current_period_start: z.number(),
        current_period_end: z.number(),
      }),
    ),
  }),
});

export const checkoutSessionObject = z.object({
  id: z.string(),
  mode: z.string().nullish(),
  customer: idOf.nullish(),
  subscription: idOf.nullish(),
  client_reference_id: z.string().nullish(),
});

export const invoiceObject = z.object({ id: z.string(), customer: idOf.nullish() });

export class StripeSignatureError extends Error {}

/**
 * Verifies a webhook delivery's `stripe-signature` against the raw request body (the official verifier: HMAC-SHA256
 * with the endpoint secret, constant-time compare, 5-minute timestamp tolerance) and validates the event's shape.
 */
export function verifyStripeEvent(rawBody: string, signature: string | null, secret: string): StripeEvent {
  if (!signature) throw new StripeSignatureError("missing stripe-signature header");
  let event: unknown;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    throw new StripeSignatureError(err instanceof Error ? err.message : "invalid signature");
  }
  const parsed = stripeEventSchema.safeParse(event);
  if (!parsed.success) throw new StripeSignatureError("malformed Stripe event");
  return parsed.data;
}
