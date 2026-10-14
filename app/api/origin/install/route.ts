import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { current,seal,cookieOptions,origin } from "../../../../src/server";
import { originScopes,originPersonalScope } from "../../../../src/origin-auth";

export async function GET(request:Request){
 const identity=await current(),organizationId=new URL(request.url).searchParams.get("organization");
 if(!identity.organizations.some(o=>o._id===organizationId&&["owner","admin"].includes(o.role)))return NextResponse.json({error:"Workspace admin required"},{status:403});
 const appId=process.env.ORIGIN_APP_ID;
 if(!appId||!process.env.ORIGIN_APP_PRIVATE_KEY)return NextResponse.json({error:"Configure the OpenReview Origin App ID and Ed25519 private key"},{status:503});
 const state=randomBytes(32).toString("hex");
 (await cookies()).set("openreview_origin_install",await seal({state,organizationId,userId:identity.user._id}),{...cookieOptions,maxAge:300});
 // Origin grants metadata automatically at installation; explicit token requests still need it.
 const scopes=[...originScopes.filter(scope=>scope!=="repository:metadata:read"),originPersonalScope];
 const query=new URLSearchParams({client_id:appId,scope:scopes.join(" "),redirect_uri:origin()+"/api/origin/callback",state,summary:"Index selected repositories and publish OpenReview code reviews",include_granted_scopes:"true"});
 return NextResponse.redirect("https://cursor.com/codebase/apps/install?"+query);
}
