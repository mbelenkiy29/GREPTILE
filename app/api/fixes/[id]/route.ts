import { NextResponse } from "next/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { backend,current } from "../../../../src/server";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const {token}=await current(),{id}=await params;
 try{return NextResponse.json(await backend().query(api.bridge.status,{token,requestId:id as Id<"fixRequests">}),{headers:{"cache-control":"no-store"}});}
 catch{return NextResponse.json({error:"Fix request unavailable"},{status:404});}
}
