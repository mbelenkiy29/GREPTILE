import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { z } from "zod";
import {ConvexError} from "convex/values";
import { runtimeEvidenceSchema } from "../src/engine/types";

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
