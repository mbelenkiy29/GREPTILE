import { createHash } from "node:crypto";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import { backend } from "../../../../src/server";
import type { Id } from "../../../../convex/_generated/dataModel";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export async function POST(request:Request,{params}:{params:Promise<{action:string}>}) {
 const {action}=await params;const secret=process.env.SERVICE_SECRET??"";
 try {
  const auth=z.string().regex(/^Bearer obr_[a-f0-9]{64}$/).parse(request.headers.get("authorization"));const tokenHash=hash(auth.slice(7));const body=await request.json();
  if(action==="pair") {const a=z.object({code:z.string().regex(/^[a-f0-9]{12}$/),name:z.string().min(1).max(100)}).parse(body);await backend().mutation(api.bridge.startPair,{secret,hash:tokenHash,...a});return Response.json({pending:true});}
  if(action==="status")return Response.json(await backend().mutation(api.bridge.pairStatus,{secret,hash:tokenHash}));
  if(action==="claim") {const a=z.object({requestId:z.string().regex(/^[a-z0-9]{16,64}$/)}).parse(body);return Response.json(await backend().action(api.bridgeJobs.claim,{secret,hash:tokenHash,requestId:a.requestId as Id<"fixRequests">}));}
  if(action==="report") {const a=z.object({requestId:z.string(),status:z.enum(["launched","failed","finished"]),error:z.string().max(1000).optional()}).parse(body);await backend().mutation(api.bridge.report,{secret,hash:tokenHash,...a,requestId:a.requestId as Id<"fixRequests">});return Response.json({ok:true});}
  return Response.json({error:"Unknown bridge action"},{status:404});
 }catch{return Response.json({error:"Invalid, expired, or unauthorized bridge request"},{status:400});}
}
