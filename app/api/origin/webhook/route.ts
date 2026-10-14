import { api } from "../../../../convex/_generated/api";
import { backend } from "../../../../src/server";
export async function POST(request:Request){
 if(Number(request.headers.get("content-length")??0)>4000000)return new Response("Too large",{status:413});
 const body=await request.text();if(body.length>4000000)return new Response("Too large",{status:413});
 try{
  await backend().action(api.providerJobs.originWebhook,{secret:process.env.SERVICE_SECRET??"",body,externalId:request.headers.get("webhook-id")??"",timestamp:request.headers.get("webhook-timestamp")??"",signature:request.headers.get("webhook-signature")??""});
  return new Response("Accepted",{status:202});
 }catch{return new Response("Invalid or unavailable Origin delivery",{status:503});}
}
