import { api } from "../../../../../convex/_generated/api";
import type { Id } from "../../../../../convex/_generated/dataModel";
import { backend } from "../../../../../src/server";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 if(Number(request.headers.get("content-length")??0)>4000000)return new Response("Too large",{status:413});
 const body=await request.text();if(Buffer.byteLength(body)>4000000)return new Response("Too large",{status:413});
 try{const {id}=await params;await backend().action(api.providerJobs.webhook,{secret:process.env.SERVICE_SECRET??"",connectionId:id as Id<"providerConnections">,signature:request.headers.get("x-gitlab-token")??request.headers.get("x-gitea-signature")??request.headers.get("x-hub-signature-256")??request.headers.get("x-hub-signature")??"",externalId:request.headers.get("x-gitlab-event-uuid")??request.headers.get("x-gitlab-webhook-uuid")??request.headers.get("x-gitea-delivery")??request.headers.get("x-github-delivery")??request.headers.get("x-request-id")??"",eventType:request.headers.get("x-gitea-event-type")??request.headers.get("x-gitea-event")??request.headers.get("x-github-event")??request.headers.get("x-event-key")??undefined,body});return new Response("Accepted",{status:202});}
 catch{return new Response("Invalid or unauthorized delivery",{status:401});}
}
