/**
 * `POST /api/stripe/webhook` (R4.2). Answers 404 when billing is off (no Stripe code runs), 400 when the
 * `stripe-signature` does not verify against the raw body, 200 once the event is applied (or was already), and 500
 * when applying failed so Stripe redelivers it.
 */
import type { Db } from "@/lib/db";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { billingConfig, type BillingConfig } from "./plans";
import { lazyStripe } from "./report";
import { StripeSignatureError, verifyStripeEvent, type StripeApi } from "./stripe";
import { handleStripeEvent } from "./subscriptions";

/** Stripe events are small; anything larger is refused before it is read in full. */
export const MAX_STRIPE_EVENT_BYTES = 1_000_000;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createStripeWebhookHandler(factory: () => { db: Db; cfg?: BillingConfig; stripe?: () => StripeApi; now?: () => Date; log?: Logger }) {
  return async (req: Request): Promise<Response> => {
    const deps = factory();
    const cfg = deps.cfg ?? billingConfig();
    const log = (deps.log ?? rootLog).child({ component: "stripe-webhook" });
    if (!cfg.enabled || !cfg.stripe) return json({ error: "billing_disabled" }, 404);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_STRIPE_EVENT_BYTES) return json({ error: "payload_too_large" }, 413);
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_STRIPE_EVENT_BYTES) return json({ error: "payload_too_large" }, 413);
    let event;
    try {
      event = verifyStripeEvent(raw, req.headers.get("stripe-signature"), cfg.stripe.webhookSecret);
    } catch (err) {
      log.warn("stripe webhook rejected", { error: err instanceof StripeSignatureError ? err.message : errorMessage(err) });
      return json({ error: "invalid_signature" }, 400);
    }
    try {
      const result = await handleStripeEvent({ db: deps.db, cfg, stripe: deps.stripe ?? lazyStripe(cfg), now: deps.now, log }, event);
      return json({ received: true, ...result }, 200);
    } catch (err) {
      log.error("stripe webhook processing failed", { stripeEventId: event.id, stripeEventType: event.type, error: errorMessage(err) });
      return json({ error: "processing_failed" }, 500);
    }
  };
}
