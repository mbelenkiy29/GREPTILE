import { createStripeWebhookHandler } from "@/lib/billing/webhook";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Stripe webhook receiver (R4.2); 404 unless Stripe billing is configured. */
export const POST = createStripeWebhookHandler(() => ({ db: db(), log: log.child({ component: "stripe" }) }));
