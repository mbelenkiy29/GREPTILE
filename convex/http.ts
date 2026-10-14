import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { z } from "zod";
import {ConvexError} from "convex/values";
import { runtimeEvidenceSchema } from "../src/engine/types";
import { verifySlackSignature } from "../src/slack";
import { verifyStripeSignature } from "../src/billing";

const http = httpRouter();
http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > 4_000_000)
      return new Response("Payload too large", { status: 413 });
    const body = await request.text();
    if (body.length > 4_000_000)
      return new Response("Payload too large", { status: 413 });
    const signature = request.headers.get("x-hub-signature-256");
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
      return new Response("Unauthorized", { status: 401 });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    );
    const provided = signature
      .slice(7)
      .match(/../g)!
      .map((b) => parseInt(b, 16));
    let difference = 0;
    for (let i = 0; i < mac.length; i++) difference |= mac[i] ^ provided[i];
    if (difference) return new Response("Unauthorized", { status: 401 });
    const deliveryId = request.headers.get("x-github-delivery"),
      event = request.headers.get("x-github-event");
    if (!deliveryId || !event || deliveryId.length > 100 || event.length > 100)
      return new Response("Missing delivery metadata", { status: 400 });
    try {
      JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const payloadStorageId = await ctx.storage.store(
      new Blob([body], { type: "application/json" }),
    );
    await ctx.runMutation(internal.webhooks.receive, {
      deliveryId,
      event,
      payloadStorageId,
    });
    return new Response("Accepted", { status: 202 });
  }),
});
// Stripe webhooks (cloud billing): signed with STRIPE_WEBHOOK_SECRET, applied idempotently.
const stripeObject = z.object({ id: z.string().max(255).optional(), customer: z.string().max(255).nullish(), subscription: z.string().max(255).nullish(), status: z.string().max(40).optional(), client_reference_id: z.string().max(255).nullish(), mode: z.string().optional(), metadata: z.record(z.string()).nullish(), current_period_end: z.number().optional(), items: z.object({ data: z.array(z.object({ id: z.string(), quantity: z.number().int().nonnegative().optional(), current_period_end: z.number().optional() })).max(20) }).optional() }).passthrough();
const stripeEvent = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9_]{1,250}$/), type: z.string().max(100), created: z.number().int().positive(), data: z.object({ object: stripeObject }) }).passthrough();
http.route({
  path: "/stripe/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (process.env.BILLING_ENABLED !== "true") return new Response("Billing disabled", { status: 404 });
    if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) return new Response("Payload too large", { status: 413 });
    const body = await request.text();
    if (body.length > 1_000_000 || !await verifyStripeSignature(body, request.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)) return new Response("Unauthorized", { status: 401 });
    let event;
    try { event = stripeEvent.parse(JSON.parse(body)); } catch { return new Response("Invalid event", { status: 400 }); }
    const o = event.data.object, created = event.created * 1000, base = { eventId: event.id, type: event.type, created };
    if (event.type === "checkout.session.completed" && o.mode === "subscription" && o.client_reference_id && o.customer) await ctx.runMutation(internal.billing.applyStripeEvent, { ...base, checkout: { organizationId: o.client_reference_id, customer: o.customer, ...(o.subscription ? { subscription: o.subscription } : {}) } });
    else if (event.type.startsWith("customer.subscription.") && o.id && o.customer && o.status) {
      const item = o.items?.data[0];
      await ctx.runMutation(internal.billing.applyStripeEvent, { ...base, subscription: { id: o.id, customer: o.customer, status: o.status, quantity: item?.quantity ?? 1, ...(item ? { itemId: item.id } : {}), ...((item?.current_period_end ?? o.current_period_end) ? { currentPeriodEnd: (item?.current_period_end ?? o.current_period_end)! * 1000 } : {}), ...(o.metadata?.organizationId ? { organizationId: o.metadata.organizationId } : {}) } });
    } else if ((event.type === "invoice.payment_failed" || event.type === "invoice.paid") && o.customer) await ctx.runMutation(internal.billing.applyStripeEvent, { ...base, invoice: { customer: o.customer, ...(o.subscription ? { subscription: o.subscription } : {}) } });
    else await ctx.runMutation(internal.billing.applyStripeEvent, base);
    return new Response("ok", { status: 200 });
  }),
});
// Slack events and slash commands: signed requests only (SLACK_SIGNING_SECRET), answered fast;
// questions are queued as jobs.
async function slackRequest(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) return null;
  const body = await request.text();
  if (body.length > 1_000_000) return null;
  return await verifySlackSignature(body, request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), process.env.SLACK_SIGNING_SECRET) ? body : null;
}
const slackEvent = z.object({ type: z.string(), challenge: z.string().max(200).optional(), team_id: z.string().max(40).optional(), event_id: z.string().max(100).optional(), event: z.object({ type: z.string(), text: z.string().max(40000).optional(), channel: z.string().max(40).optional(), ts: z.string().max(40).optional(), thread_ts: z.string().max(40).optional(), bot_id: z.string().optional(), subtype: z.string().optional() }).passthrough().optional() }).passthrough();
http.route({
  path: "/slack/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await slackRequest(request);
    if (body === null) return new Response("Unauthorized", { status: 401 });
    let payload;
    try { payload = slackEvent.parse(JSON.parse(body)); } catch { return new Response("Invalid payload", { status: 400 }); }
    if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge ?? "" });
    const event = payload.event;
    if (payload.type === "event_callback" && event?.type === "app_mention" && !event.bot_id && !event.subtype && payload.team_id && payload.event_id && event.channel && event.ts)
      await ctx.runMutation(internal.notifications.enqueueMention, { eventId: payload.event_id, teamId: payload.team_id, channelId: event.channel, text: event.text ?? "", ts: event.ts, ...(event.thread_ts ? { threadTs: event.thread_ts } : {}) });
    return new Response("ok", { status: 200 });
  }),
});
http.route({
  path: "/slack/commands",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await slackRequest(request);
    if (body === null) return new Response("Unauthorized", { status: 401 });
    const form = new URLSearchParams(body), teamId = form.get("team_id") ?? "", channelId = form.get("channel_id") ?? "";
    if (!/^T[A-Z0-9]+$/.test(teamId) || !/^[CGD][A-Z0-9]+$/.test(channelId)) return new Response("Invalid command", { status: 400 });
    const text = await ctx.runQuery(internal.notifications.commandStatus, { teamId, channelId, text: (form.get("text") ?? "").slice(0, 200) });
    return Response.json({ response_type: "ephemeral", text });
  }),
});
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(
    async () =>
      new Response(
        JSON.stringify({ status: "ok", service: "openreview-backend" }),
        { headers: { "content-type": "application/json" } },
      ),
  ),
});
for(const operation of ["claim","heartbeat","snapshot","report"]){
 http.route({path:"/runtime/"+operation,method:"POST",handler:httpAction(async(ctx,request)=>{
  try{
   if(Number(request.headers.get("content-length")??0)>128000)return new Response("Too large",{status:413});
   const credential=z.string().regex(/^Bearer orw_[a-f0-9]{64}$/).parse(request.headers.get("authorization")).slice(7);
   const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(credential))),hash=Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
   const text=await request.text();if(new TextEncoder().encode(text).length>128000)return new Response("Too large",{status:413});
   const body=JSON.parse(text);
   if(operation==="claim")return Response.json(await ctx.runMutation(internal.runtime.claim,{hash,lease:z.string().uuid().parse(body.lease)}));
   const a=z.object({id:z.string(),lease:z.string().uuid()}).parse(body),id=a.id as Id<"runtimeJobs">;
   if(operation==="heartbeat"){await ctx.runMutation(internal.runtime.heartbeat,{hash,id,lease:a.lease});return Response.json({ok:true});}
   if(operation==="snapshot"){
    const job=await ctx.runQuery(internal.runtime.authenticatedJob,{hash,id,lease:a.lease,source:true});
    if(!job.sourceStorageId)throw new Error("Runtime snapshot unavailable");
    const blob=await ctx.storage.get(job.sourceStorageId);if(!blob)throw new Error("Runtime snapshot missing");
    return new Response(blob,{headers:{"content-type":"application/gzip","cache-control":"no-store"}});
   }
   const report=z.object({error:z.string().max(1000).optional(),evidence:runtimeEvidenceSchema.optional()}).parse(body);
   if(!report.error&&!report.evidence)throw new Error("Missing runtime result");
   await ctx.runAction(internal.runtimeJobs.report,{hash,id,lease:a.lease,...report});return Response.json({ok:true});
  }catch(error){if(error instanceof ConvexError&&typeof error.data==="object"&&error.data!==null&&"code" in error.data&&error.data.code==="RUNTIME_WORKER_CREDENTIAL_REJECTED")return Response.json({code:"worker_credential_rejected",error:"Runtime worker credential expired or revoked"},{status:401});return Response.json({error:"Invalid, expired, unauthorized or unavailable runtime request"},{status:401});}
 })});
}
export default http;
