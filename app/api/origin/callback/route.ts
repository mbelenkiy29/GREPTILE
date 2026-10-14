import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { current,backend,unseal,origin } from "../../../../src/server";
import { verifyOriginReceipt,originCredentials } from "../../../../src/origin-auth";
import { encryptCredential } from "../../../../src/credentials";
import { Origin } from "../../../../src/origin";

export async function GET(request:Request){
 const identity=await current(),jar=await cookies(),cookie=jar.get("openreview_origin_install")?.value;
 jar.delete("openreview_origin_install");
 try{
  if(!cookie)throw new Error("Installation session expired; reconnect Origin");
  const saved=z.object({state:z.string(),organizationId:z.string(),userId:z.string()}).parse(await unseal(cookie));
  if(saved.userId!==identity.user._id||!identity.organizations.some(o=>o._id===saved.organizationId&&["owner","admin"].includes(o.role)))throw new Error("Workspace admin required");
  const receipt=new URL(request.url).searchParams.get("installation_receipt");
  if(!receipt||receipt.length>20000)throw new Error("Missing Origin installation receipt");
  const appId=z.string().parse(process.env.ORIGIN_APP_ID),verified=await verifyOriginReceipt(receipt,appId,saved.state);
  const credentials=originCredentials.parse({appId,privateKey:process.env.ORIGIN_APP_PRIVATE_KEY,installationId:verified.sub});
  await new Origin(credentials).repositories();
  const connection=await backend().mutation(api.providerConnections.connectOrigin,{token:identity.token,secret:process.env.SERVICE_SECRET??"",organizationId:saved.organizationId as Id<"organizations">,installationId:verified.sub,namespaceId:verified.namespace_id,jti:verified.jti,expiresAt:verified.exp*1000,credentials:encryptCredential(JSON.stringify(credentials),saved.organizationId+":origin")});
  return NextResponse.redirect(origin()+"/dashboard/settings/providers?connection="+connection);
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Origin installation failed"},{status:400});}
}
