import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { backend } from "../../../../../src/server";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 if(Number(request.headers.get("content-length")??0)>4000000)return new Response("Too large",{status:413});
 const body=await request.text();if(Buffer.byteLength(body)>4000000)return new Response("Too large",{status:413});
 // Azure DevOps service hooks: the secret arrives as a custom header or a Basic password, and the
 // delivery id is the notification's "id" in the body.
 const basic=/^Basic\s+([A-Za-z0-9+/=]+)$/.exec(request.headers.get("authorization")??"")?.[1];
 const basicSecret=basic?Buffer.from(basic,"base64").toString("utf8").split(":").slice(1).join(":"):undefined;
 let bodyId:string|undefined;try{const parsed=JSON.parse(body) as {id?:unknown};bodyId=typeof parsed.id==="string"?parsed.id:undefined;}catch{bodyId=undefined;}
 try{const {id}=await params;await backend().action(api.providerJobs.webhook,{secret:process.env.SERVICE_SECRET??"",connectionId:id as Id<"providerConnections">,signature:request.headers.get("x-gitlab-token")??request.headers.get("x-gitea-signature")??request.headers.get("x-hub-signature-256")??request.headers.get("x-hub-signature")??request.headers.get("x-openreview-token")??basicSecret??"",externalId:request.headers.get("x-gitlab-event-uuid")??request.headers.get("x-gitlab-webhook-uuid")??request.headers.get("x-gitea-delivery")??request.headers.get("x-github-delivery")??request.headers.get("x-request-id")??bodyId??"",eventType:request.headers.get("x-gitea-event-type")??request.headers.get("x-gitea-event")??request.headers.get("x-github-event")??request.headers.get("x-event-key")??undefined,body});return new Response("Accepted",{status:202});}
 catch{return new Response("Invalid or unauthorized delivery",{status:401});}
}
